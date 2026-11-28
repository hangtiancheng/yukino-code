import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppConfigSchema } from "@/config/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { TrustDecision } from "@/project/types.js";
import * as runtimeFactory from "@/runtime/factory.js";
import { captureSessionRuntimeState } from "@/runtime/session-state.js";
import type { AgentRuntime } from "@/runtime/types.js";
import type { AgentSession } from "@/sdk/agent-session.js";
import { createAgentSession } from "@/sdk/factory.js";
import type { CreateAgentSessionOptions } from "@/sdk/types.js";
import { SessionManager } from "@/session/manager.js";
import { getSessionFilePath } from "@/session/records.js";
import {
  inspectSessionRestoration,
  prepareSessionRestoration,
} from "@/session/restoration.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool } from "@/tools/types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof fsPromises>();
  return { ...original, stat: vi.fn(original.stat) };
});

const sessions: AgentSession[] = [];
const runtimes: AgentRuntime[] = [];
const createRuntime = runtimeFactory.createAgentRuntime;
const provider = {
  name: "fixture",
  protocol: "anthropic" as const,
  model: "A",
  base_url: "",
};
const config = AppConfigSchema.parse({
  providers: [provider],
  enable_memory: false,
});
let cwd: string;
let other: string;

function mockClient() {
  return {
    protocol: "anthropic" as const,
    setSystemPrompt: vi.fn(),
    stream: vi.fn<LLMClient["stream"]>(async function* () {
      await Promise.resolve();
      yield { type: "text_delta", text: "local reply" };
      yield {
        type: "stream_end",
        stopReason: "end_turn",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      };
    }),
  };
}
async function make(options: CreateAgentSessionOptions = {}) {
  const client = mockClient();
  const result = await createAgentSession({
    cwd,
    config,
    provider,
    client,
    persist: true,
    tools: [],
    ...options,
  });
  sessions.push(result.session);
  return { ...result, client };
}
function project(directory: string) {
  mkdirSync(join(directory, ".yukino", "extensions"), { recursive: true });
  writeFileSync(
    join(directory, ".yukino", "config.yaml"),
    JSON.stringify({
      extensions: [{ name: "fixture", path: "extensions/fixture.mjs" }],
    }),
  );
  writeFileSync(
    join(directory, ".yukino", "extensions", "fixture.mjs"),
    `
import { appendFileSync } from "node:fs";
export function activate() {
  appendFileSync(${JSON.stringify(join(directory, "activated"))}, "activate\\n");
  return () => undefined;
}
`,
  );
}
function stored(manager: SessionManager) {
  return readFileSync(getSessionFilePath(manager.cwd, manager.id), "utf8");
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
  vi.spyOn(runtimeFactory, "createAgentRuntime").mockImplementation(
    async (options) => {
      const runtime = await createRuntime(options);
      runtimes.push(runtime);
      return runtime;
    },
  );
});
afterEach(async () => {
  await Promise.allSettled(
    sessions.splice(0).map((session) => session.dispose()),
  );
  await Promise.allSettled(
    runtimes.splice(0).map((runtime) => runtime.dispose()),
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("explicit SDK restoration boundaries", () => {
  it("keeps same-project resume ergonomic and restores the exact branch provider and declarations without model calls", async () => {
    const registry = new ToolRegistry();
    const echo: Tool = {
      name: "Echo",
      description: "echo",
      category: "read",
      deferred: true,
      schema: () => ({
        name: "Echo",
        description: "echo",
        input_schema: { type: "object", properties: {} },
      }),
      execute: () => Promise.resolve({ output: "ok", isError: false }),
    };
    registry.register(echo);
    const { session, sessionManager, client } = await make({
      registry,
      tools: undefined,
    });
    runtimes[0].registry.markDiscovered("Echo");
    sessionManager.appendRuntimeState(captureSessionRuntimeState(runtimes[0]));
    sessionManager.append({ role: "user", content: "stored input" });
    const b = mockClient();
    await session.newSession();
    await session.setModel({ ...provider, model: "B" }, b);
    await session.resume(sessionManager.id);
    expect(session.sessionId).toBe(sessionManager.id);
    expect(session.cwd).toBe(cwd);
    expect(session.getModel().model).toBe("A");
    expect(
      session
        .getMessages()
        .some((message) => message.content === "stored input"),
    ).toBe(true);
    expect(runtimes.at(-1)?.registry.isDiscovered("Echo")).toBe(true);
    expect(client.stream).not.toHaveBeenCalled();
    expect(b.stream).not.toHaveBeenCalled();
    expect(session.getStats().attempts).toBe(0);
  });

  it("rejects cross-project lookup or switching without destination before stopping a healthy runtime", async () => {
    const { session, sessionManager, client } = await make();
    const target = SessionManager.create(other);
    const close = vi.spyOn(runtimes[0], "dispose");
    const invalidate = vi.spyOn(runtimes[0].cache, "invalidate");
    await expect(session.resume(target.id, { cwd: other })).rejects.toThrow(
      /explicit destination/,
    );
    await expect(session.switchSession(target)).rejects.toThrow(
      /explicit destination/,
    );
    expect(session.sessionManager).toBe(sessionManager);
    expect(close).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(runtimeFactory.createAgentRuntime).toHaveBeenCalledTimes(1);
    expect(client.stream).not.toHaveBeenCalled();
    await expect(session.prompt("still healthy")).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("keeps same-project restoration usable with already untrusted resources", async () => {
    project(cwd);
    const { session, sessionManager, client } = await make();
    await session.resume(sessionManager.id);
    expect(session.sessionId).toBe(sessionManager.id);
    expect(existsSync(join(cwd, "activated"))).toBe(false);
    expect(client.stream).not.toHaveBeenCalled();
  });

  it("rejects a permission-denied target and a pre-aborted helper without touching the runtime", async () => {
    const { session, sessionManager } = await make();
    const close = vi.spyOn(runtimes[0], "dispose");
    const sourceStat = await fsPromises.stat(cwd);
    vi.spyOn(fsPromises, "stat")
      .mockResolvedValueOnce(sourceStat)
      .mockRejectedValueOnce(
        Object.assign(new Error("target access denied"), { code: "EACCES" }),
      );
    await expect(
      session.switchSession(sessionManager, { destination: other, copy: true }),
    ).rejects.toThrow("target access denied");
    const controller = new AbortController();
    controller.abort(new Error("cancel before inspection"));
    await expect(
      prepareSessionRestoration(sessionManager, cwd, {
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancel before inspection");
    expect(close).not.toHaveBeenCalled();
    expect(runtimeFactory.createAgentRuntime).toHaveBeenCalledTimes(1);
  });

  it("rejects an unavailable stored provider before copying or runtime construction", async () => {
    const { session, sessionManager } = await make();
    const source = SessionManager.create(cwd);
    const saved = sessionManager.getRuntimeState();
    if (!saved) {
      throw new Error("Missing runtime state");
    }
    source.appendRuntimeState({
      ...saved,
      provider: { ...saved.provider, name: "unavailable" },
    });
    const close = vi.spyOn(runtimes[0], "dispose");
    const publish = vi.spyOn(SessionManager, "import");
    await expect(
      session.switchSession(source, { destination: other, copy: true }),
    ).rejects.toThrow(/provider target is unavailable/);
    expect(close).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(runtimeFactory.createAgentRuntime).toHaveBeenCalledTimes(1);
  });

  it("rejects unrelated metadata and the removed cwd-string signature", async () => {
    const { session, sessionManager } = await make();
    // @ts-expect-error Explicit options replaced the old cwd-string signature.
    await expect(session.resume(sessionManager.id, cwd)).rejects.toThrow(
      /options/,
    );
    await expect(
      // @ts-expect-error Arbitrary metadata cannot authorize execution.
      session.resume(sessionManager.id, { confirmed: true }),
    ).rejects.toThrow(/options/);
  });

  it("requires a new identity for a changed execution destination and copies the exact stored state", async () => {
    const { session, sessionManager, client } = await make();
    sessionManager.append({ role: "user", content: "source input" });
    const before = stored(sessionManager);
    await expect(
      session.resume(sessionManager.id, { destination: other }),
    ).rejects.toThrow(/explicit copy/);
    const inspection = await inspectSessionRestoration(sessionManager, {
      destination: other,
    });
    const b = mockClient();
    await session.newSession();
    await session.setModel({ ...provider, model: "B" }, b);
    await session.resume(sessionManager.id, {
      destination: other,
      copy: inspection.copyConfirmation,
    });
    expect(session.cwd).toBe(other);
    expect(session.sessionId).not.toBe(sessionManager.id);
    expect(session.getModel().model).toBe("A");
    expect(
      session
        .getMessages()
        .some((message) => message.content === "source input"),
    ).toBe(true);
    expect(stored(sessionManager)).toBe(before);
    expect(client.stream).not.toHaveBeenCalled();
  });

  it("keeps missing-directory storage readable, cancels without disposal, and copies only to an explicit existing target", async () => {
    const source = SessionManager.create(other);
    source.append({ role: "user", content: "orphaned input" });
    const before = stored(source);
    renameSync(other, `${other}-moved`);
    const { session, sessionManager, client } = await make();
    const close = vi.spyOn(runtimes[0], "dispose");
    const inspection = await inspectSessionRestoration(source, {
      destination: cwd,
    });
    expect(inspection).toMatchObject({ sourceMissing: true, destination: cwd });
    expect(SessionManager.open(other, source.id).getMessages()).toHaveLength(1);
    await expect(session.resume(source.id, { cwd: other })).rejects.toThrow(
      /explicit destination/,
    );
    await expect(
      session.switchSession(source, { destination: cwd }),
    ).rejects.toThrow(/only an explicit copy/);
    await expect(session.switchSession(source, { copy: true })).rejects.toThrow(
      /explicit destination/,
    );
    expect(session.sessionManager).toBe(sessionManager);
    expect(close).not.toHaveBeenCalled();
    expect(stored(source)).toBe(before);
    await session.resume(source.id, {
      cwd: other,
      destination: cwd,
      copy: inspection.copyConfirmation,
    });
    expect(session.sessionId).not.toBe(source.id);
    expect(
      session
        .getMessages()
        .some((message) => message.content === "orphaned input"),
    ).toBe(true);
    expect(stored(source)).toBe(before);
    expect(existsSync(other)).toBe(false);
    expect(client.stream).not.toHaveBeenCalled();
  });

  it("canonicalizes a destination symlink, but rejects invalid or ambiguous destinations without creating them", async () => {
    const { session, sessionManager } = await make();
    const file = join(homedir(), "file");
    writeFileSync(file, "not a directory");
    const missing = join(homedir(), "not-created");
    const close = vi.spyOn(runtimes[0], "dispose");
    for (const destination of [missing, file, "relative", ""]) {
      await expect(
        session.switchSession(sessionManager, { destination, copy: true }),
      ).rejects.toThrow();
    }
    expect(close).not.toHaveBeenCalled();
    expect(existsSync(missing)).toBe(false);
    const alias = join(homedir(), "alias");
    symlinkSync(other, alias);
    const inspection = await inspectSessionRestoration(sessionManager, {
      destination: alias,
    });
    expect(inspection.destination).toBe(other);
    await session.switchSession(sessionManager, {
      destination: alias,
      copy: inspection.copyConfirmation,
    });
    expect(session.cwd).toBe(other);
  });

  it("binds copy confirmation to source revision and rejects a retargeted symlink", async () => {
    const { session, sessionManager } = await make();
    const inspection = await inspectSessionRestoration(sessionManager, {
      destination: other,
    });
    sessionManager.setName("changed after confirmation");
    await expect(
      session.switchSession(sessionManager, {
        destination: other,
        copy: inspection.copyConfirmation,
      }),
    ).rejects.toThrow(/Stale/);
    const alias = join(homedir(), "alias");
    symlinkSync(other, alias);
    const prepared = await prepareSessionRestoration(sessionManager, cwd, {
      destination: alias,
      copy: true,
    });
    unlinkSync(alias);
    symlinkSync(cwd, alias);
    await expect(prepared.assertCurrent()).rejects.toThrow(
      /changed after confirmation/,
    );
    expect(runtimeFactory.createAgentRuntime).toHaveBeenCalledTimes(1);
  });

  it("preflights trust without extension activation or source publication when target approval is denied", async () => {
    project(other);
    const approval = vi.fn(() => Promise.resolve<TrustDecision>("deny"));
    const { session, sessionManager } = await make({
      trust: "once",
      onTrustRequest: approval,
    });
    const before = stored(sessionManager);
    const close = vi.spyOn(runtimes[0], "dispose");
    const publish = vi.spyOn(SessionManager, "import");
    await expect(
      session.switchSession(sessionManager, { destination: other, copy: true }),
    ).rejects.toThrow(/trust was not approved/);
    expect(approval).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(existsSync(join(other, "activated"))).toBe(false);
    expect(stored(sessionManager)).toBe(before);
  });

  it("uses the consumed constructor grant only for its fingerprint and reuses one target preflight approval", async () => {
    project(cwd);
    project(other);
    const approval = vi.fn(() => Promise.resolve<TrustDecision>("once"));
    const { session } = await make({ trust: "once", onTrustRequest: approval });
    const target = SessionManager.create(other);
    await session.switchSession(target, { destination: other });
    expect(approval).toHaveBeenCalledOnce();
    expect(approval).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: other }),
    );
    expect(readFileSync(join(other, "activated"), "utf8")).toBe("activate\n");
    expect(session.sessionId).toBe(target.id);
  });

  it("resumes healthy queued input after a denied preflight without cancelling either receipt", async () => {
    project(other);
    let deny!: () => void;
    let requested!: () => void;
    const trustRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const { session } = await make({
      onTrustRequest: () =>
        new Promise<TrustDecision>((resolve) => {
          deny = () => {
            resolve("deny");
          };
          requested();
        }),
    });
    let started!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    session.subscribe((event) => {
      if (event.type === "run_started") {
        started();
      }
    });
    const first = session.prompt("first healthy input");
    await runStarted;
    const queued = session.followUp("second healthy input");
    const source = SessionManager.create(cwd, { persist: false });
    const restoring = session.switchSession(source, {
      destination: other,
      copy: true,
    });
    expect((await first).status).toBe("completed");
    await trustRequested;
    deny();
    await expect(restoring).rejects.toThrow(/trust was not approved/);
    expect((await queued.completion).status).toBe("completed");
    expect(session.isBusy).toBe(false);
  });

  it("aborts a waiting trust preflight without disposal, activation or copy", async () => {
    project(other);
    let entered!: () => void;
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { session, sessionManager } = await make({
      onTrustRequest: () => {
        entered();
        return new Promise(() => undefined);
      },
    });
    const close = vi.spyOn(runtimes[0], "dispose");
    const controller = new AbortController();
    const restoring = session.switchSession(sessionManager, {
      destination: other,
      copy: true,
      signal: controller.signal,
    });
    await requested;
    controller.abort(new Error("cancelled preflight"));
    await expect(restoring).rejects.toThrow("cancelled preflight");
    expect(close).not.toHaveBeenCalled();
    expect(session.sessionManager).toBe(sessionManager);
    expect(existsSync(join(other, "activated"))).toBe(false);
    expect(runtimeFactory.createAgentRuntime).toHaveBeenCalledTimes(1);
    expect((await session.prompt("after cancellation")).status).toBe(
      "completed",
    );
  });

  it("rechecks source revision after approval before copying or stopping the current runtime", async () => {
    project(other);
    const source = SessionManager.create(cwd);
    const { session } = await make({
      onTrustRequest: () => {
        source.setName("concurrent update");
        return Promise.resolve("once");
      },
    });
    const close = vi.spyOn(runtimes[0], "dispose");
    const publish = vi.spyOn(SessionManager, "import");
    await expect(
      session.switchSession(source, { destination: other, copy: true }),
    ).rejects.toThrow(/revision/);
    expect(close).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(existsSync(join(other, "activated"))).toBe(false);
  });

  it("rolls back a failed runtime replacement without resurrecting revoked project grants", async () => {
    project(cwd);
    const approval = vi.fn(() => Promise.resolve<TrustDecision>("once"));
    const { session, sessionManager, client } = await make({
      trust: "persistent",
      onTrustRequest: approval,
    });
    await session.revokeProjectTrust();
    vi.mocked(runtimeFactory.createAgentRuntime).mockRejectedValueOnce(
      new Error("target setup failed"),
    );
    const target = SessionManager.create(other);
    await expect(
      session.switchSession(target, { destination: other }),
    ).rejects.toThrow("target setup failed");
    expect(session.sessionManager).toBe(sessionManager);
    expect(session.getModel().model).toBe("A");
    expect(
      session.getProjectSources().some((source) => source.scope === "project"),
    ).toBe(false);
    expect(approval).not.toHaveBeenCalled();
    await session.switchSession(target, { destination: other });
    await session.switchSession(sessionManager, { destination: cwd });
    expect(
      session.getProjectSources().some((source) => source.scope === "project"),
    ).toBe(false);
    expect(approval).not.toHaveBeenCalled();
    expect(readFileSync(join(cwd, "activated"), "utf8")).toBe("activate\n");
    expect(client.stream).not.toHaveBeenCalled();
    expect((await session.prompt("rollback remains usable")).status).toBe(
      "completed",
    );
  });
});
