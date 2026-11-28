import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppConfigSchema } from "@/config/index.js";
import * as runtimeFactory from "@/runtime/factory.js";
import {
  createAgentSession,
  type AgentSession,
  type LLMClient,
} from "@/sdk/index.js";
import { SessionManager } from "@/session/manager.js";
import { getSessionsDir } from "@/storage/index.js";

let cwd: string;
const sessions: AgentSession[] = [];
const provider = {
  name: "fixture",
  protocol: "anthropic" as const,
  model: "local",
  base_url: "",
};
const config = AppConfigSchema.parse({
  providers: [provider],
  enable_memory: false,
});
function project(name: string) {
  const path = join(homedir(), name);
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}
function resources(path: string) {
  mkdirSync(join(path, ".yukino"), { recursive: true });
  writeFileSync(join(path, ".yukino", "config.yaml"), "theme: dark\n");
}
function files(path: string) {
  const directory = getSessionsDir(path);
  return existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
    : [];
}
async function make(options: Parameters<typeof createAgentSession>[0] = {}) {
  const client = {
    protocol: "anthropic" as const,
    setSystemPrompt: vi.fn(),
    stream: vi.fn<LLMClient["stream"]>(async function* () {
      await Promise.resolve();
      yield* [];
      throw new Error("No model calls allowed");
    }),
  };
  const result = await createAgentSession({
    cwd,
    provider,
    config,
    client,
    persist: false,
    tools: [],
    ...options,
  });
  sessions.push(result.session);
  return { ...result, client };
}
async function collect(source: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const bytes of source) {
    expect(bytes.byteLength).toBeLessThanOrEqual(65536);
    chunks.push(Buffer.from(bytes));
  }
  return Buffer.concat(chunks);
}
beforeEach(() => {
  cwd = project("project");
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No external requests allowed");
    }),
  );
});
afterEach(async () => {
  await Promise.allSettled(
    sessions.splice(0).map((session) => session.dispose()),
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("public SDK bounded transfer", () => {
  it("exports/imports >1MiB UTF8 and artifact JSONL/HTML through stream and private files without string shortcuts or replay", async () => {
    const { session, sessionManager, client } = await make();
    sessionManager.append({ role: "user", content: "雪<&>".repeat(240_000) });
    sessionManager.append({
      role: "assistant",
      content: "",
      toolUses: [{ toolUseId: "read", toolName: "Read", arguments: {} }],
    });
    const id = sessionManager.appendArtifact(
      Buffer.from("输出".repeat(200_000)),
      "text/plain",
    );
    sessionManager.append({
      role: "user",
      content: "",
      toolResults: [
        {
          toolUseId: "read",
          content: "preview",
          isError: false,
          artifact: { id },
        },
      ],
    });
    const small = vi.spyOn(sessionManager, "export");
    const jsonl = await collect(
      session.exportStream({ scope: "tree", format: "jsonl" }),
    );
    const html = await collect(
      session.exportStream({ scope: "tree", format: "html" }),
    );
    expect(jsonl.length).toBeGreaterThan(1024 * 1024);
    expect(html.length).toBeGreaterThan(1024 * 1024);
    expect(html.toString()).toContain("输出");
    expect(small).not.toHaveBeenCalled();
    expect(() => session.export({ scope: "tree", format: "jsonl" })).toThrow(
      /string byte limit/,
    );
    await expect(session.import("x".repeat(1024 * 1024 + 1))).rejects.toThrow(
      /string byte limit/,
    );
    const path = join(cwd, "owned.jsonl");
    await session.exportFile(path, { scope: "tree", format: "jsonl" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path)).toEqual(jsonl);
    const before = session.sessionId;
    await session.importFile(path);
    expect(session.sessionId).not.toBe(before);
    expect(session.getModel().model).toBe("local");
    expect(
      session.sessionManager.getMessages().at(-1)?.toolResults?.[0].content,
    ).toContain("输出");
    expect(SessionManager.open(cwd, session.sessionId).getMessages()).toEqual(
      session.sessionManager.getMessages(),
    );
    expect(client.stream).not.toHaveBeenCalled();
    const third = await make();
    await third.session.importStream(
      session.exportStream({ scope: "tree", format: "jsonl" }),
    );
    expect(third.session.getModel().model).toBe("local");
    expect(third.client.stream).not.toHaveBeenCalled();
  });

  it("binds eager exports to session/revision, lifetime signals and disposal", async () => {
    const lifetime = new AbortController();
    const { session, sessionManager } = await make({ signal: lifetime.signal });
    const stale = session.exportStream({ scope: "tree", format: "jsonl" });
    sessionManager.setName("changed");
    await expect(stale.next()).rejects.toThrow(/revision/);
    const changed = session.exportStream({ scope: "tree", format: "jsonl" });
    await session.newSession();
    await expect(changed.next()).rejects.toThrow(/revision/);
    const exported = session.exportStream({ scope: "tree", format: "jsonl" });
    lifetime.abort(new Error("host closed"));
    await expect(exported.next()).rejects.toThrow("host closed");
    await session.dispose();
    expect(() =>
      session.exportStream({ scope: "tree", format: "jsonl" }),
    ).toThrow(/disposed/i);
  });

  it("rejects bad destination/provider/JSONL before healthy runtime disposal or publication", async () => {
    const { session, sessionManager } = await make();
    const dispose = vi.spyOn(runtimeFactory, "createAgentRuntime");
    const before = files(cwd);
    const source = SessionManager.create(cwd, { persist: false });
    const state = sessionManager.getRuntimeState();
    if (!state) {
      throw new Error("Missing saved state");
    }
    source.appendRuntimeState({
      ...state,
      provider: { ...state.provider, name: "missing" },
    });
    await expect(
      session.importStream(
        source.exportStream({ scope: "tree", format: "jsonl" }),
      ),
    ).rejects.toThrow(/provider target is unavailable/);
    await expect(
      session.importStream(
        source.exportStream({ scope: "tree", format: "jsonl" }),
        { cwd: join(cwd, "missing") },
      ),
    ).rejects.toThrow();
    await expect(
      session.importStream(
        (async function* () {
          yield await Promise.resolve(Buffer.from("{}\n"));
        })(),
      ),
    ).rejects.toThrow();
    expect(session.sessionManager).toBe(sessionManager);
    expect(dispose).not.toHaveBeenCalled();
    expect(files(cwd)).toEqual(before);
  });

  it.each(["deny", "cancel"])(
    "never publishes or abandons the healthy runtime on %s trust",
    async (action) => {
      const target = project("target");
      resources(target);
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const { session, sessionManager, client } = await make({
        onTrustRequest: async () => {
          entered();
          return action === "deny" ? "deny" : new Promise(() => undefined);
        },
      });
      const build = vi.spyOn(runtimeFactory, "createAgentRuntime");
      const controller = new AbortController();
      const importing = session.importStream(
        session.exportStream({ scope: "tree", format: "jsonl" }),
        { cwd: target, signal: controller.signal },
      );
      await waiting;
      if (action === "cancel") {
        controller.abort(new Error("cancel trust"));
      }
      await expect(importing).rejects.toThrow(
        action === "deny" ? /trust was not approved/ : /cancel trust/,
      );
      expect(session.sessionManager).toBe(sessionManager);
      expect(files(target)).toEqual([]);
      expect(build).not.toHaveBeenCalled();
      expect(client.stream).not.toHaveBeenCalled();
      expect(session.isBusy).toBe(false);
    },
  );

  it("checks fingerprint again after runtime setup and keeps failed candidates unpublished", async () => {
    const target = project("target");
    resources(target);
    const { session, sessionManager } = await make({
      onTrustRequest: () => Promise.resolve<"once">("once"),
    });
    const original = runtimeFactory.createAgentRuntime;
    vi.spyOn(runtimeFactory, "createAgentRuntime").mockImplementationOnce(
      async (options) => {
        const runtime = await original(options);
        writeFileSync(
          join(target, ".yukino", "config.yaml"),
          "model: changed-after-trust\n",
        );
        return runtime;
      },
    );
    await expect(
      session.importStream(
        session.exportStream({ scope: "tree", format: "jsonl" }),
        { cwd: target },
      ),
    ).rejects.toThrow(/trust/i);
    expect(files(target)).toEqual([]);
    expect(session.sessionManager).toBe(sessionManager);
  });

  it("cancels a blocked producer without waiting on iterator.return or publishing partial records", async () => {
    const { session, sessionManager } = await make();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const returned = vi.fn(() =>
      Promise.resolve({ done: true as const, value: undefined }),
    );
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          entered();
          return new Promise<IteratorResult<Uint8Array>>(() => undefined);
        },
        return: returned,
      }),
    };
    const controller = new AbortController();
    const importing = session.importStream(source, {
      signal: controller.signal,
    });
    await waiting;
    controller.abort(new Error("blocked producer cancelled"));
    await expect(importing).rejects.toThrow("blocked producer cancelled");
    expect(returned).toHaveBeenCalledOnce();
    expect(session.sessionManager).toBe(sessionManager);
    expect(files(cwd)).toEqual([]);
  });
});
