import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as invocation from "@/bootstrap/invocation.js";
import { AppConfigSchema } from "@/config/index.js";
import type { LLMClient } from "@/llm/client.js";
import { RPC_VERSION } from "@/rpc/constants.js";
import { JsonlWriter } from "@/rpc/jsonl.js";
import { runRpcMode } from "@/rpc/mode.js";
import { parseRpcRequest, type RpcMessage } from "@/rpc/protocol.js";
import { RpcServer } from "@/rpc/server.js";
import type { AgentSession } from "@/sdk/agent-session.js";
import { createAgentSession } from "@/sdk/factory.js";
import * as sdk from "@/sdk/index.js";
import { SessionManager } from "@/session/manager.js";
import { inspectSessionRestoration } from "@/session/restoration.js";

const sessions: AgentSession[] = [];
const provider = {
  name: "local",
  protocol: "anthropic" as const,
  base_url: "",
  model: "fixture",
};
const config = AppConfigSchema.parse({
  providers: [provider],
  enable_memory: false,
});
let cwd: string;
let other: string;
function request(
  command: "resume_session" | "switch_session",
  args: Record<string, unknown>,
) {
  return {
    version: RPC_VERSION,
    type: "request",
    commandId: "restore",
    command,
    args,
  };
}
beforeEach(() => {
  vi.stubEnv("HOME", homedir());
  cwd = join(homedir(), "project");
  other = join(homedir(), "other");
  mkdirSync(cwd);
  mkdirSync(other);
  cwd = realpathSync(cwd);
  other = realpathSync(other);
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected external request");
    }),
  );
});
afterEach(async () => {
  await Promise.allSettled(
    sessions.splice(0).map((session) => session.dispose()),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function modeRequest(
  command: "resume_session" | "switch_session",
  args: Record<string, unknown>,
) {
  const stream = vi.fn<LLMClient["stream"]>(() => {
    throw new Error("Resume must not call the model");
  });
  const result = await createAgentSession({
    cwd,
    config,
    provider,
    tools: [],
    persist: false,
    client: { protocol: "anthropic", setSystemPrompt: () => undefined, stream },
  });
  sessions.push(result.session);
  const resume = vi.spyOn(result.session, "resume");
  vi.spyOn(invocation, "loadInvocation").mockResolvedValue({
    cwd,
    config,
    provider,
    configPath: join(cwd, "test-config.yaml"),
    systemPrompt: "local test",
  });
  vi.spyOn(sdk, "createAgentSession").mockResolvedValue(result);
  let finish!: () => void;
  const received = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const messages: RpcMessage[] = [];
  vi.spyOn(JsonlWriter.prototype, "write").mockImplementation((message) => {
    messages.push(message);
    if (message.type === "response") {
      finish();
    }
    return Promise.resolve();
  });
  vi.spyOn(RpcServer.prototype, "run").mockImplementation(() => received);
  vi.spyOn(RpcServer.prototype, "emit").mockImplementation(function (
    this: RpcServer,
  ) {
    this.receive(JSON.stringify(request(command, args)));
    return Promise.resolve();
  });
  await runRpcMode({ persist: false });
  return {
    ...result,
    resume,
    stream,
    response: messages.find((message) => message.type === "response"),
  };
}

describe("RPC explicit restoration protocol", () => {
  it.each(["resume_session", "switch_session"] as const)(
    "%s rejects cross-project source without a destination",
    async (command) => {
      const source = SessionManager.create(other);
      const result = await modeRequest(command, {
        sessionId: source.id,
        cwd: other,
      });
      expect(result.response).toMatchObject({
        success: false,
        error: { code: "invalid_request" },
      });
      expect(result.resume).not.toHaveBeenCalled();
      expect(result.session.cwd).toBe(cwd);
      expect(result.stream).not.toHaveBeenCalled();
    },
  );

  it.each(["confirmed", "metadata", "projectTrust", "target"])(
    "does not treat arbitrary %s as confirmation",
    (field) => {
      expect(() =>
        parseRpcRequest(
          request("resume_session", {
            sessionId: "source",
            cwd: other,
            [field]: true,
          }),
        ),
      ).toThrow();
      expect(() =>
        parseRpcRequest(
          request("resume_session", {
            sessionId: "source",
            destination: other,
            [field]: true,
          }),
        ),
      ).toThrow();
    },
  );

  it("requires explicit destinations for copies and strictly validates revision confirmations", () => {
    expect(() =>
      parseRpcRequest(
        request("resume_session", { sessionId: "source", copy: true }),
      ),
    ).toThrow();
    expect(() =>
      parseRpcRequest(
        request("resume_session", {
          sessionId: "source",
          destination: other,
          copy: { confirmed: true },
        }),
      ),
    ).toThrow();
    expect(
      parseRpcRequest(request("resume_session", { sessionId: "source" })).args,
    ).toEqual({ sessionId: "source" });
    expect(
      parseRpcRequest(
        request("resume_session", {
          sessionId: "source",
          destination: other,
          copy: true,
        }),
      ).args.copy,
    ).toBe(true);
  });

  it.each(["resume_session", "switch_session"] as const)(
    "%s forwards the explicit canonical destination and cancellation signal",
    async (command) => {
      const source = SessionManager.create(other);
      const result = await modeRequest(command, {
        sessionId: source.id,
        cwd: other,
        destination: other,
      });
      expect(result.response).toMatchObject({ success: true });
      const signal = result.resume.mock.calls[0]?.[1]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(result.resume).toHaveBeenCalledWith(source.id, {
        cwd: other,
        destination: other,
        signal,
      });
      expect(result.session.sessionId).toBe(source.id);
      expect(result.session.cwd).toBe(other);
      expect(result.stream).not.toHaveBeenCalled();
    },
  );

  it("forwards revision-bound copy confirmation and preserves missing-directory source storage", async () => {
    const source = SessionManager.create(join(homedir(), "missing-project"));
    source.append({ role: "user", content: "source preserved" });
    const inspection = await inspectSessionRestoration(source, {
      destination: other,
    });
    const result = await modeRequest("resume_session", {
      sessionId: source.id,
      cwd: source.cwd,
      destination: other,
      copy: inspection.copyConfirmation,
    });
    expect(result.response).toMatchObject({ success: true });
    const signal = result.resume.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(result.resume).toHaveBeenCalledWith(source.id, {
      cwd: source.cwd,
      destination: other,
      copy: inspection.copyConfirmation,
      signal,
    });
    expect(result.session.sessionId).not.toBe(source.id);
    expect(result.session.cwd).toBe(other);
    expect(
      SessionManager.open(source.cwd, source.id).getMessages()[0]?.content,
    ).toBe("source preserved");
    expect(result.stream).not.toHaveBeenCalled();
  });
});
