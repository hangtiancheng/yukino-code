import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AppConfigSchema } from "@/config/index.js";
import type { LLMClient } from "@/llm/client.js";
import { MCPClient, type MCPRequestOptions } from "@/mcp/client.js";
import {
  createRuntimeEnvironment,
  type RuntimeEnvironment,
} from "@/remote/runtime-environment.js";
import type { AgentSession } from "@/sdk/agent-session.js";
import { createAgentSession } from "@/sdk/factory.js";
import { SessionManager } from "@/session/manager.js";

const environments: RuntimeEnvironment[] = [];
const sessions: AgentSession[] = [];

afterEach(async () => {
  await Promise.allSettled([
    ...environments
      .splice(0)
      .flatMap((environment) => [
        environment.project.dispose(),
        environment.runtime.dispose(),
      ]),
    ...sessions.splice(0).map((session) => session.dispose()),
  ]);
  vi.restoreAllMocks();
});

function fixture() {
  const home = homedir();
  const config = AppConfigSchema.parse({
    providers: [
      {
        name: "local",
        protocol: "openai-compat",
        base_url: "http://127.0.0.1:1/v1",
        model: "local",
        thinking: "off",
      },
    ],
    mcp_servers: [
      { name: "offline", url: "http://127.0.0.1:1/global" },
      { name: "available", url: "http://127.0.0.1:1/mcp" },
    ],
    enable_memory: false,
  });
  mkdirSync(join(home, ".yukino"), { recursive: true });
  writeFileSync(join(home, ".yukino", "config.yaml"), JSON.stringify(config));
  writeFileSync(
    join(home, ".mcp.json"),
    JSON.stringify({
      mcpServers: { offline: { command: "nonexistent-local-fixture" } },
    }),
  );
  const client: LLMClient = {
    protocol: "openai-compat",
    setSystemPrompt: vi.fn(),
    async *stream() {
      await Promise.resolve();
      yield { type: "text_delta", text: "HOME_STARTUP_OK" };
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
    },
  };
  const connect = vi
    .spyOn(MCPClient.prototype, "connect")
    .mockImplementation(async function (this: MCPClient) {
      await Promise.resolve();
      if (this.name === "offline") {
        throw Object.assign(
          new Error("Untrusted raw transport text fixture-secret"),
          { code: "ENOENT" },
        );
      }
    });
  vi.spyOn(MCPClient.prototype, "listTools").mockResolvedValue([]);
  vi.spyOn(MCPClient.prototype, "disconnect").mockResolvedValue(undefined);
  return { home, config, client, connect };
}

describe("authorized MCP startup degradation", () => {
  it.each(["runtime", "sdk"])(
    "cancels %s initialization while an MCP connection is pending",
    async (host) => {
      const { home, config, client, connect } = fixture();
      const controller = new AbortController();
      let entered!: () => void;
      const connecting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      connect.mockImplementation(async function (
        this: MCPClient,
        options: MCPRequestOptions = {},
      ) {
        const signal = options.signal;
        if (!signal) {
          throw new Error("Expected an initialization signal");
        }
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(
                new DOMException("Initialization cancelled", "AbortError"),
              );
            },
            { once: true },
          );
          entered();
        });
      });
      const creation =
        host === "runtime"
          ? createRuntimeEnvironment(config, SessionManager.create(home), {
              client,
              signal: controller.signal,
              enableCoordinatorMode: false,
              invocationOptions: { cwd: home, trustProject: true },
            })
          : createAgentSession({
              cwd: home,
              config,
              provider: config.providers[0],
              client,
              trust: "once",
              signal: controller.signal,
            });
      const rejected = expect(creation).rejects.toMatchObject({
        name: "AbortError",
      });
      await connecting;
      controller.abort();
      await rejected;
      expect(connect).toHaveBeenCalledOnce();
    },
  );

  it("starts a HOME runtime with a failed project server and no global-name fallback", async () => {
    const { home, config, client, connect } = fixture();
    const environment = await createRuntimeEnvironment(
      config,
      SessionManager.create(home),
      {
        client,
        enableCoordinatorMode: false,
        invocationOptions: { cwd: home, trustProject: true },
      },
    );
    environments.push(environment);
    expect(environment.runtime.mcpManager?.connectedServers()).toEqual([
      "available",
    ]);
    expect(
      environment.runtime.mcpManager
        ?.states()
        .find((state) => state.name === "offline")?.source.scope,
    ).toBe("project");
    expect(environment.errors).toHaveLength(1);
    expect(environment.errors[0].serverName).toBe("offline");
    expect(JSON.stringify(environment.errors)).not.toContain("fixture-secret");
    expect(connect).toHaveBeenCalledTimes(2);
    const output: string[] = [];
    for await (const event of environment.runtime.run(
      "harmless startup check",
      { onPermissionRequest: () => Promise.resolve("deny") },
    )) {
      if (event.type === "stream_text") {
        output.push(event.text);
      }
    }
    expect(output.join("")).toBe("HOME_STARTUP_OK");
  });

  it("creates an SDK session despite a failed authorized project server and can prompt", async () => {
    const { home, config, client, connect } = fixture();
    const { session } = await createAgentSession({
      cwd: home,
      config,
      provider: config.providers[0],
      client,
      trust: "once",
    });
    sessions.push(session);
    expect(
      session.getMCPState().servers.find((state) => state.name === "offline")
        ?.state,
    ).toBe("error");
    expect(connect).toHaveBeenCalledTimes(2);
    const result = await session.prompt("harmless SDK startup check");
    expect(result.status).toBe("completed");
    expect(result.text).toBe("HOME_STARTUP_OK");
  });
});
