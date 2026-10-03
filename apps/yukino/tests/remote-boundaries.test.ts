import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { RecoveryState } from "@/compact/recovery.js";
import type { ProviderConfig } from "@/config/provider-config.js";
import { ConversationManager } from "@/conversation/index.js";
import { FileHistory } from "@/file-history/index.js";
import { parseRemoteAddress } from "@/remote/address.js";
import { createRemoteAgent, RemoteServer } from "@/remote/server.js";
import { restoreRemoteSession } from "@/remote/session-state.js";
import type { SessionMessage } from "@/session/index.js";
import { TaskList } from "@/todo/index.js";
import { TaskStore } from "@/todo/store.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
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
      forkDisabled: true,
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
      providers: [],
      addr: ":18888",
      enableCoordinatorMode: false,
      forkDisabled: true,
      agentFactory,
    });

    const first = requirePromise(invokePrivate(server, "ensureAgent"));
    const second = requirePromise(invokePrivate(server, "ensureAgent"));
    expect(agentFactory).toHaveBeenCalledOnce();

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
      forkDisabled: true,
      agentFactory,
    });

    const pending = requirePromise(invokePrivate(server, "ensureAgent"));
    expect(agentFactory).toHaveBeenCalledWith(
      expect.objectContaining({ provider: providers[1] }),
    );

    initialization.reject(new Error("expected test failure"));
    await expect(pending).resolves.toBeNull();
  });

  it("validates reviews before initialization and claims streaming during cold start", async () => {
    const initialization = deferred<never>();
    const agentFactory = vi.fn(() => initialization.promise);
    const server = new RemoteServer({
      providers: [],
      addr: ":18888",
      enableCoordinatorMode: false,
      forkDisabled: true,
      agentFactory,
    });

    const invalid = requirePromise(
      invokePrivate(server, "handleCodeReviewStart", [{ from: "main" }]),
    );
    expect(agentFactory).not.toHaveBeenCalled();
    expect(Reflect.get(server, "streaming")).toBe(false);
    await invalid;

    const first = requirePromise(
      invokePrivate(server, "handleCodeReviewStart", [{}]),
    );
    expect(Reflect.get(server, "streaming")).toBe(true);
    const second = requirePromise(
      invokePrivate(server, "handleCodeReviewStart", [{}]),
    );
    expect(agentFactory).toHaveBeenCalledOnce();
    await second;

    initialization.reject(new Error("expected test failure"));
    await first;
    expect(Reflect.get(server, "streaming")).toBe(false);
  });

  it("uses run-equivalent tool visibility for manual compaction", async () => {
    const registry = new ToolRegistry();
    const visibleNames = vi.spyOn(registry, "listVisibleToolNames");
    const visibleSchemas = vi.spyOn(registry, "getAllSchemas");
    const server = new RemoteServer({
      providers: [],
      addr: ":18888",
      enableCoordinatorMode: true,
      forkDisabled: true,
    });
    Reflect.set(server, "agentHandle", {
      client: { protocol: "openai-compat" },
      conv: new ConversationManager(),
      recoveryState: new RecoveryState(),
      registry,
      workDir: process.cwd(),
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

  it("cancels a remote fork skill through the active run signal", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-remote-skill-"));
    const skillDir = join(workDir, ".agents", "skills", "remote-fork");
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
      const handle = await createRemoteAgent({
        provider,
        workDir,
        enableCoordinatorMode: false,
        forkDisabled: false,
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
        { workDir, abortSignal: controller.signal },
        { name: "remote-fork" },
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("fork execution failed");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("restores tool results and image attachments without replacing the fork's conversation", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-remote-"));
    try {
      const conv = new ConversationManager();
      conv.addUserMessage("old session");
      const state: Parameters<typeof restoreRemoteSession>[0] = {
        workDir,
        conv,
        sessionId: "old",
        fileHistory: new FileHistory(workDir, "old"),
        fileStateCache: new FileStateCache(),
        recoveryState: new RecoveryState(),
        activeSkills: new Map([["old", "old instructions"]]),
        toolFilter: () => false,
        taskList: new TaskList(new TaskStore(workDir, "old")),
      };
      const forkSnapshot = () => conv.fork();
      state.fileStateCache.record("old-file", 1);
      state.recoveryState.recordFileRead("old-file", "old content");
      const saved: SessionMessage[] = [
        {
          role: "assistant",
          content: "read",
          timestamp: 1,
          tool_uses: [
            {
              tool_use_id: "read",
              tool_name: "ReadFile",
              arguments: { file_path: "image.png" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "aGVsbG8=",
              },
            },
            { type: "text", text: "attachment note" },
          ],
          timestamp: 2,
          tool_results: [
            { tool_use_id: "read", content: "image read", is_error: false },
          ],
        },
      ];
      const snapshot = JSON.stringify(saved);
      restoreRemoteSession(state, "new", saved);
      expect(state.conv).toBe(conv);
      expect(forkSnapshot().getMessages().at(-1)?.content).toEqual(
        saved[1]?.content,
      );
      expect(
        forkSnapshot().getMessages().at(-1)?.toolResults?.[0]?.content,
      ).toBe("image read");
      expect(JSON.stringify(saved)).toBe(snapshot);
      expect(state.sessionId).toBe("new");
      expect(state.activeSkills.size).toBe(0);
      expect(state.toolFilter).toBeNull();
      expect(state.fileStateCache.has("old-file")).toBe(false);
      expect(state.recoveryState.snapshotFiles()).toEqual([]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("settles pending permission and question waits when stopping the server", async () => {
    const server = new RemoteServer({
      providers: [],
      addr: ":18888",
      enableCoordinatorMode: false,
      forkDisabled: true,
    });
    const permission = deferred<"allow" | "deny" | "allowAlways">();
    const question = deferred<Record<string, string>>();
    const abort = vi.fn();
    Reflect.set(server, "agentHandle", { abort });
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
    await expect(permission.promise).resolves.toBe("deny");
    await expect(question.promise).resolves.toEqual({});
  });
});
