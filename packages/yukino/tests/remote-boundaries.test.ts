import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { Agent } from "@/agent/index.js";
import { RecoveryState } from "@/compact/recovery.js";
import type { ProviderConfig } from "@/config/provider-config.js";
import { ConversationManager } from "@/conversation/index.js";
import { PermissionChecker } from "@/permissions/index.js";
import { parseRemoteAddress } from "@/remote/address.js";
import { RemoteServer } from "@/remote/server.js";
import { createAgentRuntime } from "@/runtime/factory.js";
import { ToolRegistry } from "@/tools/registry.js";

function rejectedWebSocketStatus(
  url: string,
  headers?: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("WebSocket unexpectedly opened"));
    });
    socket.once("error", () => undefined);
  });
}

function opensWebSocket(
  url: string,
  headers?: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => {
      socket.close();
      resolve();
    });
    socket.once("error", reject);
  });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    /** noop */
  };
  let reject: (reason?: unknown) => void = () => {
    /** noop */
  };
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function invokePrivate(
  target: object,
  methodName: string,
  args: unknown[] = [],
): unknown {
  const method: unknown = Reflect.get(target, methodName);
  if (typeof method !== "function") {
    throw new Error(`Missing method: ${methodName}`);
  }
  const result: unknown = Reflect.apply(method, target, args);
  return result;
}

function requirePromise(value: unknown): Promise<unknown> {
  if (!(value instanceof Promise)) {
    throw new Error("Expected private method to return a promise");
  }
  return value;
}

describe("remote execution boundaries", () => {
  it("defaults to loopback and preserves explicit network and IPv6 binding", () => {
    expect(parseRemoteAddress(":18888")).toEqual({
      host: "127.0.0.1",
      port: 18888,
    });
    expect(parseRemoteAddress(":9000")).toEqual({
      host: "127.0.0.1",
      port: 9000,
    });
    expect(parseRemoteAddress("9000")).toEqual({
      host: "127.0.0.1",
      port: 9000,
    });
    expect(parseRemoteAddress("0.0.0.0:9000")).toEqual({
      host: "0.0.0.0",
      port: 9000,
    });
    expect(parseRemoteAddress("[::1]:9000")).toEqual({
      host: "::1",
      port: 9000,
    });
  });

  it("applies a per-mode default port and opt-in ephemeral binding", () => {
    // A bare host falls back to the caller's default port, not always 18888.
    expect(parseRemoteAddress("localhost", { defaultPort: 18890 })).toEqual({
      host: "localhost",
      port: 18890,
    });
    expect(parseRemoteAddress("localhost", { defaultPort: 18889 })).toEqual({
      host: "localhost",
      port: 18889,
    });
    // Port 0 is rejected unless the caller opts into ephemeral binding.
    expect(() => parseRemoteAddress(":0")).toThrow();
    expect(parseRemoteAddress(":0", { allowEphemeral: true })).toEqual({
      host: "127.0.0.1",
      port: 0,
    });
  });

  it("binds an ephemeral port and announces the reachable URL", async () => {
    const writes: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
    const server = new RemoteServer({
      providers: [],
      addr: "127.0.0.1:0",
      enableCoordinatorMode: false,
      agentFactory: () => Promise.reject(new Error("no provider")),
    });
    const runPromise = server.run();
    try {
      await vi.waitFor(() => {
        expect(
          writes.some((line) => line.includes("Remote server listening at")),
        ).toBe(true);
      });
      const line =
        writes.find((entry) => entry.includes("Remote server listening at")) ??
        "";
      // Port 0 must resolve to a real, reachable port in the announced URL.
      expect(line).toMatch(/http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+/);
      expect(line).not.toContain(":0");

      const browserUrl = new URL(
        /http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+/.exec(line)?.[0] ??
          "",
      );
      const token = new URLSearchParams(browserUrl.hash.slice(1)).get("token");
      expect(token).toBeTruthy();
      expect((await fetch(`http://${browserUrl.host}/auth`)).status).toBe(401);
      const auth = await fetch(`http://${browserUrl.host}/auth?token=${token}`);
      expect(auth.status).toBe(204);
      expect(auth.headers.get("cache-control")).toBe("no-store");
      const authorized = `ws://${browserUrl.host}/ws?token=${encodeURIComponent(token ?? "")}`;

      await expect(
        rejectedWebSocketStatus(`ws://${browserUrl.host}/ws`),
      ).resolves.toBe(401);
      await expect(
        rejectedWebSocketStatus(authorized, {
          Origin: "https://attacker.example",
        }),
      ).resolves.toBe(403);
      await expect(
        opensWebSocket(authorized, {
          Origin: `http://${browserUrl.host}`,
        }),
      ).resolves.toBeUndefined();
      await expect(
        opensWebSocket(authorized, { Origin: `https://${browserUrl.host}` }),
      ).resolves.toBeUndefined();
    } finally {
      await server.stop();
      await runPromise;
      stderrSpy.mockRestore();
    }
  });

  it("defers startup until interaction and passes the configured sandbox through retries", async () => {
    const sandboxConfig = {
      enabled: true,
      auto_allow: true,
      network_enabled: false,
    };
    const agentFactory = vi.fn(() =>
      Promise.reject(new Error("expected test failure")),
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const server = new RemoteServer({
      providers: [
        {
          name: "test",
          protocol: "openai",
          model: "test",
          base_url: "https://test.invalid",
        },
      ],
      addr: "127.0.0.1:0",
      enableCoordinatorMode: false,
      sandboxConfig,
      agentFactory,
    });
    const runPromise = server.run();
    try {
      await vi.waitFor(() => {
        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("Remote server listening at"),
        );
      });
      expect(agentFactory).not.toHaveBeenCalled();
      await requirePromise(invokePrivate(server, "ensureAgent"));
      expect(agentFactory).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ sandboxConfig }),
      );
      await requirePromise(invokePrivate(server, "ensureAgent"));
      expect(agentFactory).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ sandboxConfig }),
      );
    } finally {
      await server.stop();
      await runPromise;
      stderrSpy.mockRestore();
    }
  });

  it.each(["localhost:9000oops", ":65536", ":-1", ":0", "::1:9000"])(
    "rejects invalid address %s before starting an agent",
    (address) => {
      expect(() => parseRemoteAddress(address)).toThrow();
    },
  );

  it("shares one cold agent initialization across concurrent callers", async () => {
    const initialization = deferred<never>();
    const agentFactory = vi.fn(() => initialization.promise);
    const server = new RemoteServer({
      providers: [
        {
          name: "test",
          protocol: "openai",
          model: "test",
          base_url: "https://test.invalid",
        },
      ],
      addr: ":18888",
      enableCoordinatorMode: false,
      agentFactory,
    });

    const first = requirePromise(invokePrivate(server, "ensureAgent"));
    const second = requirePromise(invokePrivate(server, "ensureAgent"));
    await vi.waitFor(() => {
      expect(agentFactory).toHaveBeenCalledOnce();
    });

    initialization.reject(new Error("expected test failure"));
    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
    expect(Reflect.get(server, "agentInitPromise")).toBeNull();
  });

  it("starts the agent with the provider selected by default_provider", async () => {
    const initialization = deferred<never>();
    const agentFactory = vi.fn(() => initialization.promise);
    const providers = [
      {
        name: "first",
        protocol: "openai",
        model: "first-model",
        base_url: "https://first.invalid",
      },
      {
        name: "second",
        protocol: "openai",
        model: "second-model",
        base_url: "https://second.invalid",
      },
    ] satisfies ProviderConfig[];
    const server = new RemoteServer({
      providers,
      defaultProvider: 1,
      addr: ":18888",
      enableCoordinatorMode: false,
      agentFactory,
    });

    const pending = requirePromise(invokePrivate(server, "ensureAgent"));
    await vi.waitFor(() => {
      expect(agentFactory).toHaveBeenCalledOnce();
      expect(agentFactory.mock.calls).toMatchObject([
        [{ provider: providers[1] }],
      ]);
    });

    initialization.reject(new Error("expected test failure"));
    await expect(pending).resolves.toBeNull();
  });

  it("uses run-equivalent tool visibility for manual compaction", async () => {
    const registry = new ToolRegistry();
    const visibleNames = vi.spyOn(registry, "listVisibleToolNames");
    const visibleSchemas = vi.spyOn(registry, "getAllSchemas");
    const server = new RemoteServer({
      providers: [],
      addr: ":18888",
      enableCoordinatorMode: true,
    });
    Reflect.set(server, "agentHandle", {
      client: { protocol: "openai-compat" },
      conv: new ConversationManager(),
      recoveryState: new RecoveryState(),
      registry,
      cwd: process.cwd(),
      sessionId: "compact-test",
      enableCoordinatorMode: true,
      toolFilter: (name: string) => name !== "Agent",
    });

    await requirePromise(invokePrivate(server, "handleCompact"));

    expect(visibleNames).toHaveBeenCalledOnce();
    expect(visibleSchemas).toHaveBeenCalledOnce();
    const namesCall = visibleNames.mock.calls[0];
    const schemasCall = visibleSchemas.mock.calls[0];
    expect(namesCall?.[0]).toBe("openai-compat");
    expect(schemasCall?.[0]).toBe("openai-compat");
    expect(namesCall?.[1]).toBe(schemasCall?.[1]);
    const filter = namesCall?.[1];
    expect(filter?.("SendMessage")).toBe(true);
    expect(filter?.("Agent")).toBe(false);
    expect(filter?.("Bash")).toBe(false);
  });

  it("keeps remote skill subagents synchronized with the live parent execution mode", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-permissions-"));
    const skillDir = join(cwd, ".agents", "skills", "remote-fork");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: remote-fork\ndescription: test\ncontext: fork\n---\n\nDo work.",
    );
    const captured: PermissionChecker[] = [];
    const run = vi.spyOn(Agent.prototype, "run").mockImplementation(function (
      this: Agent,
    ) {
      const checker: unknown = Reflect.get(this, "checker");
      if (!(checker instanceof PermissionChecker)) {
        throw new Error("Missing checker");
      }
      captured.push(checker);
      return (async function* () {
        await Promise.resolve();
        yield {
          type: "loop_complete" as const,
          stopReason: "completed" as const,
        };
      })();
    });
    try {
      const handle = await createAgentRuntime({
        provider: {
          name: "test",
          protocol: "openai",
          base_url: "https://example.invalid",
          api_key: "test",
          model: "test",
        },
        cwd,
        enableCoordinatorMode: false,
        memoryEnabled: false,
      });
      handle.permissionMode = "acceptEdits";
      const loadSkill = handle.registry.get("LoadSkill");
      if (!loadSkill) {
        throw new Error("Missing LoadSkill");
      }
      expect(
        (await loadSkill.execute({ cwd }, { name: "remote-fork" })).isError,
      ).toBe(false);
      expect(captured).toHaveLength(1);
      expect(captured[0].mode).toBe("acceptEdits");
      handle.permissionMode = "bypassPermissions";
      expect(
        captured[0].check("Bash", "command", { command: "pnpm test" }).effect,
      ).toBe("allow");
      handle.permissionMode = "plan";
      expect(captured[0].mode).toBe("default");
      handle.permissionMode = "default";
      expect(
        captured[0].check("WriteFile", "write", { file_path: "a.ts" }).effect,
      ).toBe("ask");
    } finally {
      run.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("cancels a remote fork skill through the active run signal", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-remote-skill-"));
    const skillDir = join(cwd, ".agents", "skills", "remote-fork");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: remote-fork\ndescription: test\ncontext: fork\n---\n\nDo work.",
    );
    const provider: ProviderConfig = {
      name: "test",
      protocol: "openai",
      base_url: "https://example.invalid",
      api_key: "test",
      model: "test",
    };

    try {
      const handle = await createAgentRuntime({
        provider,
        cwd,
        enableCoordinatorMode: false,
        memoryEnabled: false,
      });
      const loadSkill = handle.registry.get("LoadSkill");
      expect(loadSkill).toBeDefined();
      if (!loadSkill) {
        return;
      }
      const controller = new AbortController();
      controller.abort();

      const result = await loadSkill.execute(
        { cwd, abortSignal: controller.signal },
        { name: "remote-fork" },
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("fork execution failed");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("settles pending permission and question waits when stopping the server", async () => {
    const server = new RemoteServer({
      providers: [],
      addr: ":18888",
      enableCoordinatorMode: false,
    });
    const permission = deferred<"allow" | "deny" | "allowAlways">();
    const question = deferred<Record<string, string>>();
    const abort = vi.fn();
    const registry = new ToolRegistry();
    const dispose = vi.spyOn(registry, "dispose");
    Reflect.set(server, "agentHandle", {
      abort,
      registry,
      dispose: () => registry.dispose(),
    });
    Reflect.set(
      server,
      "pendingPermissions",
      new Map([["permission", permission.resolve]]),
    );
    Reflect.set(
      server,
      "pendingAsks",
      new Map([["question", question.resolve]]),
    );
    await server.stop();
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    await expect(permission.promise).resolves.toBe("deny");
    await expect(question.promise).resolves.toEqual({});
  });
});
