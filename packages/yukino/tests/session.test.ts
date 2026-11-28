import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { recordInput } from "@/history/index.js";
import { sessionTreeRows } from "@/session/actions.js";
import {
  COMPACT_BOUNDARY,
  MAX_SESSION_RUNTIME_IDENTIFIER_CHARS,
  MAX_SESSION_RUNTIME_TOOLS,
  SESSION_FORMAT,
  SESSION_RUNTIME_STATE,
} from "@/session/constants.js";
import {
  getSessionFilePath,
  listSessions,
  loadSession,
  loadSessionEntries,
  loadSessionForResume,
  rebuildFromSession,
  saveCompactBoundary,
  saveMessage,
  saveUserMessage,
  toolResultsToRecords,
  toolUsesToRecords,
} from "@/session/index.js";
import { SessionManager } from "@/session/manager.js";
import {
  SessionConflictError,
  parseSessionJsonl,
  serializeDocument,
  SessionMessageSchema,
  SessionRuntimeStateSchema,
  type SessionRuntimeState,
} from "@/session/records.js";
import { getSessionsDir, getYukinoDir } from "@/storage/index.js";

function project(): string {
  const directory = join(dirname(getYukinoDir()), "project");
  mkdirSync(directory, { recursive: true });
  return directory;
}

function runtimeState(model = "model-A"): SessionRuntimeState {
  return {
    provider: {
      name: "provider",
      protocol: "anthropic",
      model,
      endpointFingerprint: "a".repeat(64),
    },
    thinking: "high",
    tools: [
      {
        name: "mcp__trusted__read",
        schemaFingerprint: "b".repeat(64),
        sourceFingerprint: "c".repeat(64),
      },
    ],
    discovered: ["mcp__trusted__read"],
  };
}

describe("immutable path runtime state", () => {
  it("preserves opaque model identifiers and human-readable provider names", () => {
    const manager = SessionManager.create(project(), { persist: false });
    const state = runtimeState("/models/本地 模型-v1");
    state.provider.name = "DeepSeek 本地";
    state.tools[0].name = "_local_read";
    state.discovered = ["_local_read"];
    manager.appendRuntimeState(state);
    expect(manager.clone().getRuntimeState()).toEqual(state);
  });

  it("keeps shared ancestor and branch A/B settings independent across navigation", () => {
    const manager = SessionManager.create(project());
    expect(manager.getRuntimeState()).toBeNull();
    const original = runtimeState("ancestor");
    const ancestor = manager.appendRuntimeState(original);
    const aState = runtimeState("branch-A");
    const a = manager.appendRuntimeState(aState);
    manager.append({ role: "assistant", content: "A" });
    manager.navigate(ancestor);
    expect(manager.getRuntimeState()).toEqual(original);
    const bState: SessionRuntimeState = {
      ...runtimeState("branch-B"),
      thinking: "off",
    };
    const b = manager.appendRuntimeState(bState);
    manager.append({ role: "assistant", content: "B" });
    original.provider.model = "mutated";
    const read = manager.getRuntimeState();
    if (!read) {
      throw new Error("Missing runtime state");
    }
    read.provider.model = "mutated";
    expect(manager.getRuntimeState()).toEqual(bState);
    expect(manager.getRuntimeState(a)).toEqual(aState);
    expect(manager.getRuntimeState(ancestor)?.provider.model).toBe("ancestor");
    manager.navigate(a);
    expect(manager.getRuntimeState()).toEqual(aState);
    manager.navigate(b);
    expect(manager.getRuntimeState()).toEqual(bState);
    expect(
      manager.getEntries().find((entry) => entry.entryId === b),
    ).toMatchObject({
      parentId: ancestor,
      message: {
        role: "system",
        type: SESSION_RUNTIME_STATE,
        content: "",
        state: bState,
      },
    });
    expect(
      SessionManager.open(manager.cwd, manager.id).getRuntimeState(),
    ).toEqual(bState);
    expect(manager.getRuntimeState(null)).toBeNull();
    expect(() => manager.getRuntimeState("missing")).toThrow();
  });

  it("retains nearest state through compaction, fork, clone, tree import and reopen without replay", () => {
    const cwd = project();
    const manager = SessionManager.create(cwd);
    const ancestor = manager.appendRuntimeState(runtimeState("ancestor"));
    const a = manager.appendRuntimeState(runtimeState("A"));
    const user = manager.append({ role: "user", content: "task A" });
    manager.append({ role: "assistant", content: "answer A" });
    manager.navigate(ancestor);
    const b = manager.appendRuntimeState(runtimeState("B"));
    manager.append({ role: "user", content: "task B" });
    manager.append({ role: "assistant", content: "answer B" });
    saveCompactBoundary(cwd, manager.id, {
      summary: "compacted B",
      keep: [{ role: "user", content: "tail B" }],
    });
    manager.refresh();
    expect(manager.getRuntimeState()).toEqual(runtimeState("B"));
    const fork = manager.fork(user);
    expect(fork.getRuntimeState()).toEqual(runtimeState("A"));
    expect(fork.getMessages()).toEqual([]);
    const clone = manager.clone();
    expect(clone.getRuntimeState()).toEqual(runtimeState("B"));
    expect(clone.getMessages()).toEqual(manager.getMessages());
    const imported = SessionManager.import(
      cwd,
      manager.export({ scope: "tree", format: "jsonl" }),
    );
    for (const sourceId of [ancestor, a, b]) {
      const copy = imported
        .getEntries()
        .find((entry) => entry.provenance?.entryId === sourceId);
      if (!copy) {
        throw new Error("Missing copied state");
      }
      expect(copy.entryId).not.toBe(sourceId);
      imported.navigate(copy.entryId);
      expect(imported.getRuntimeState()).toEqual(
        manager.getRuntimeState(sourceId),
      );
    }
    for (const copy of [fork, clone, imported]) {
      expect(SessionManager.open(cwd, copy.id).getRuntimeState()).toEqual(
        copy.getRuntimeState(),
      );
      expect(
        copy
          .getMessages()
          .every(
            (message) =>
              !Object.hasOwn(message, "state") &&
              !Object.hasOwn(message, "type"),
          ),
      ).toBe(true);
    }
    expect(rebuildFromSession(loadSession(cwd, manager.id))).toEqual(
      manager.getMessages(),
    );
  });

  it("never remaps external declaration/provider identifiers even when they equal entry IDs", () => {
    const manager = SessionManager.create(project(), { persist: false });
    const root = manager.append({ role: "user", content: "root" });
    const state = runtimeState(root);
    state.provider.name = root;
    state.tools[0].name = root;
    state.discovered = [root];
    manager.appendRuntimeState(state);
    for (const copy of [
      manager.clone(),
      SessionManager.import(
        project(),
        manager.export({ scope: "tree", format: "jsonl", redact: true }),
      ),
    ]) {
      expect(copy.getEntries()[0].entryId).not.toBe(root);
      expect(copy.getRuntimeState()).toEqual(state);
    }
  });

  it("shows state in offline exports, diagnostics and correctly nested tree rows", () => {
    const manager = SessionManager.create(project(), { persist: false });
    const root = manager.append({ role: "assistant", content: "root" });
    const stateId = manager.appendRuntimeState(runtimeState());
    const reply = manager.append({ role: "assistant", content: "reply" });
    const rows = sessionTreeRows(manager.getTree(), reply);
    expect(rows.map((row) => row.id)).toEqual([root, stateId, reply]);
    expect(rows[1].label).toContain("provider");
    expect(rows[1].label).toContain("model-A");
    expect(rows[1].label).toContain("high");
    expect(rows[1].label.startsWith("  ")).toBe(true);
    expect(rows[2].label).toBe("    reply");
    expect(
      sessionTreeRows(manager.getTree(), reply, "model-A").map((row) => row.id),
    ).toEqual([stateId]);
    expect(manager.export({ scope: "tree", format: "html" })).toContain(
      "Runtime state",
    );
    expect(manager.diagnostics({ includeTranscript: true })).toContain(
      '"endpointFingerprint"',
    );
  });

  it("rejects invalid, duplicate, oversized and credential-shaped snapshots before append or import publication", () => {
    const manager = SessionManager.create(project(), { persist: false });
    manager.appendRuntimeState(runtimeState());
    const document = parseSessionJsonl(
      manager.export({ scope: "tree", format: "jsonl" }),
    );
    const state = runtimeState();
    const invalid: unknown[] = [
      {},
      { ...state, provider: { ...state.provider, protocol: "unknown" } },
      {
        ...state,
        provider: {
          ...state.provider,
          endpointFingerprint: "https://secret:key@host",
        },
      },
      {
        ...state,
        provider: {
          ...state.provider,
          endpointURL: "https://host?token=secret",
        },
      },
      { ...state, provider: { ...state.provider, model: "sk-secret-key" } },
      { ...state, provider: { ...state.provider, name: "Bearer credential" } },
      { ...state, thinking: "unbounded" },
      { ...state, tools: [state.tools[0], state.tools[0]] },
      { ...state, discovered: [...state.discovered, ...state.discovered] },
      { ...state, discovered: ["missing"] },
      {
        ...state,
        tools: [{ ...state.tools[0], sourceFingerprint: "not-a-hash" }],
      },
      { ...state, tools: [{ ...state.tools[0], execute: "return secret" }] },
      {
        ...state,
        tools: [{ ...state.tools[0], name: "__proto__" }],
        discovered: [],
      },
      {
        ...state,
        provider: {
          ...state.provider,
          model: "x".repeat(MAX_SESSION_RUNTIME_IDENTIFIER_CHARS + 1),
        },
      },
      {
        ...state,
        tools: Array.from(
          { length: MAX_SESSION_RUNTIME_TOOLS + 1 },
          (_, index) => ({ ...state.tools[0], name: `tool-${String(index)}` }),
        ),
      },
      {
        ...state,
        discovered: Array.from(
          { length: MAX_SESSION_RUNTIME_TOOLS + 1 },
          (_, index) => `tool-${String(index)}`,
        ),
      },
      { ...state, approval: "allow", token: "secret", handles: {} },
      JSON.parse('{"__proto__":{"polluted":true}}'),
    ];
    for (const bad of invalid) {
      expect(() => SessionRuntimeStateSchema.parse(bad)).toThrow();
      const revision = manager.revision;
      expect(() =>
        manager.append(
          SessionMessageSchema.parse({
            role: "system",
            type: SESSION_RUNTIME_STATE,
            content: "",
            timestamp: 1,
            state: bad,
          }),
        ),
      ).toThrow();
      expect(manager.revision).toBe(revision);
      const serialized =
        [
          document.header,
          ...document.records.map((record) =>
            record.type === "message"
              ? { ...record, message: { ...record.message, state: bad } }
              : record,
          ),
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n";
      expect(() => parseSessionJsonl(serialized)).toThrow();
      expect(() => SessionManager.import(project(), serialized)).toThrow();
    }
    expect(existsSync(getSessionsDir(project()))).toBe(false);
  });

  it("rejects non-JSON state without evaluating accessors or serializers", () => {
    const state = runtimeState();
    const getter = vi.fn(() => "credential");
    Object.defineProperty(state.provider, "name", {
      get: getter,
      enumerable: true,
    });
    expect(() => SessionRuntimeStateSchema.parse(state)).toThrow(
      "JSON accessors",
    );
    const manager = SessionManager.create(project(), { persist: false });
    expect(() => manager.appendRuntimeState(state)).toThrow("JSON accessors");
    expect(getter).not.toHaveBeenCalled();
    const serializer = vi.fn(() => "credential");
    expect(() =>
      SessionRuntimeStateSchema.parse({
        ...runtimeState(),
        toJSON: serializer,
      }),
    ).toThrow();
    expect(serializer).not.toHaveBeenCalled();
    expect(() =>
      SessionRuntimeStateSchema.parse(
        Object.assign(new Date(), runtimeState()),
      ),
    ).toThrow("non-JSON object");
    expect(manager.getEntries()).toEqual([]);
  });

  it("rejects mutable ancestor state, nonempty/role-invalid controls and controls in compaction keep", () => {
    const state = runtimeState();
    for (const message of [
      { role: "assistant", content: "answer", state },
      { role: "user", type: SESSION_RUNTIME_STATE, content: "", state },
      {
        role: "system",
        type: SESSION_RUNTIME_STATE,
        content: "payload",
        state,
      },
      { role: "system", type: SESSION_RUNTIME_STATE, content: "" },
      {
        role: "system",
        type: SESSION_RUNTIME_STATE,
        content: "",
        state,
        cost: { token: "secret" },
      },
      {
        role: "system",
        type: SESSION_RUNTIME_STATE,
        content: "",
        state,
        tool_uses: [],
      },
    ]) {
      expect(() =>
        SessionMessageSchema.parse({ ...message, timestamp: 1 }),
      ).toThrow();
    }
    const manager = SessionManager.create(project(), { persist: false });
    manager.appendRuntimeState(state);
    expect(manager.getMessages()).toEqual([]);
    const control = manager.getEntries()[0].message;
    expect(() =>
      manager.append({
        role: "system",
        type: COMPACT_BOUNDARY,
        timestamp: 1,
        content: JSON.stringify({ summary: "summary", keep: [control] }),
      }),
    ).toThrow();
    expect(manager.getEntries()).toHaveLength(1);
  });
});

describe("append-only session tree", () => {
  it("uses one header and returns stable entry IDs from existing save APIs", () => {
    const cwd = project();
    const first = saveMessage(cwd, "session", {
      role: "user",
      content: "task",
      timestamp: 1,
    });
    const second = saveMessage(cwd, "session", {
      role: "assistant",
      content: "answer",
      timestamp: 2,
    });
    const document = parseSessionJsonl(
      readFileSync(getSessionFilePath(cwd, "session"), "utf8"),
    );
    expect(document.header).toMatchObject({
      format: SESSION_FORMAT,
      sessionId: "session",
      revision: 0,
    });
    expect(document.entries).toMatchObject([
      { entryId: first, parentId: null },
      { entryId: second, parentId: first },
    ]);
    expect(document.leafId).toBe(second);
    expect(document.revision).toBe(4);
    expect(
      loadSession(cwd, "session").map((message) => message.content),
    ).toEqual(["task", "answer"]);
  });

  it("preserves A → B → A and projects only the active ancestral path", () => {
    const cwd = project();
    const manager = SessionManager.create(cwd);
    const root = manager.append({ role: "user", content: "root" });
    const a = manager.append({ role: "assistant", content: "A" });
    manager.navigate(root);
    expect(manager.leafId).toBeNull();
    manager.append({ role: "user", content: "other root" });
    const b = manager.append({ role: "assistant", content: "B" });
    manager.navigate(a);
    expect(manager.getMessages().map((message) => message.content)).toEqual([
      "root",
      "A",
    ]);
    expect(SessionManager.open(cwd, manager.id).leafId).toBe(a);
    manager.navigate(b);
    expect(manager.getMessages().map((message) => message.content)).toEqual([
      "other root",
      "B",
    ]);
    manager.navigate(a);
    expect(manager.getEntries()).toHaveLength(4);
    expect(manager.getTree()).toHaveLength(2);
    expect(loadSessionEntries(cwd, manager.id)).toHaveLength(4);
    const entries = manager.getEntries();
    entries[0].message.content = "tampered";
    expect(manager.getEntries()[0].message.content).toBe("root");
  });

  it("selecting a user entry navigates to its parent and returns composer input", () => {
    const manager = SessionManager.create(project());
    manager.append({ role: "user", content: "first" });
    const reply = manager.append({ role: "assistant", content: "reply" });
    const user = manager.append({
      role: "user",
      content: [{ type: "text", text: "edit me" }],
    });
    manager.append({ role: "assistant", content: "later" });
    expect(manager.navigate(user)).toEqual({ input: "edit me" });
    expect(manager.leafId).toBe(reply);
    expect(manager.getMessages()).toHaveLength(2);
  });

  it("persists metadata and entry labels append-only", () => {
    const cwd = project();
    const manager = SessionManager.create(cwd);
    const entry = manager.append({ role: "user", content: "task" });
    manager.setName("named");
    manager.setMetadata({ tags: ["work", "review"], archived: true });
    manager.setLabel(entry, "checkpoint");
    const opened = SessionManager.open(cwd, manager.id);
    expect(opened.getMetadata()).toEqual({
      name: "named",
      tags: ["work", "review"],
      archived: true,
    });
    expect(opened.getTree()[0].label).toBe("checkpoint");
    opened.setLabel(entry, null);
    expect(opened.getTree()[0]).not.toHaveProperty("label");
    expect(() => {
      opened.setLabel("missing", "bad");
    }).toThrow("unknown label entry");
    expect(() => {
      opened.setName("x".repeat(257));
    }).toThrow();
  });

  it("keeps memory sessions, forks and artifacts entirely in their owner", () => {
    const cwd = project();
    const manager = SessionManager.create(cwd, { persist: false });
    manager.append({ role: "user", content: "task" });
    manager.appendArtifact(Buffer.from("artifact"), "text/plain");
    const clone = manager.clone();
    expect(clone.persistent).toBe(false);
    expect(existsSync(getSessionsDir(cwd))).toBe(false);
    expect(existsSync(getSessionFilePath(cwd, manager.id))).toBe(false);
    expect(manager.getMessages()).toHaveLength(1);
  });

  it("uses optimistic revisions under the same lock as appends", () => {
    const cwd = project();
    const first = SessionManager.create(cwd);
    const stale = SessionManager.open(cwd, first.id);
    first.append({ role: "user", content: "first" });
    expect(() =>
      stale.append({ role: "user", content: "lost update" }),
    ).toThrow(SessionConflictError);
    expect(stale.revision).toBe(0);
    stale.refresh();
    stale.append({ role: "assistant", content: "second" });
    first.refresh();
    expect(first.getMessages().map((message) => message.content)).toEqual([
      "first",
      "second",
    ]);
  });

  it("rejects one of two competing processes instead of losing either branch", async () => {
    const cwd = project();
    const manager = SessionManager.create(cwd);
    const modulePath = fileURLToPath(
      new URL("../src/session/manager.ts", import.meta.url),
    );
    const script = `import { SessionManager } from ${JSON.stringify(modulePath)};
      const manager = SessionManager.open(${JSON.stringify(cwd)}, ${JSON.stringify(manager.id)});
      process.stdout.write("ready\\n");
      await new Promise(resolve => process.stdin.once("data", resolve));
      try { manager.append({role:"user",content:String(process.pid)}); process.stdout.write("success\\n"); }
      catch (error) { process.stdout.write(error.name + "\\n"); }`;
    const children = Array.from({ length: 2 }, () => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          env: { ...process.env, HOME: dirname(getYukinoDir()) },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let output = "";
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => {
        errors += chunk.toString();
      });
      const ready = new Promise<void>((resolveReady, reject) => {
        child.once("error", reject);
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("ready\n")) {
            resolveReady();
          }
        });
        child.once("exit", (code) => {
          if (!output.includes("ready\n")) {
            reject(new Error(`${String(code)}: ${errors}`));
          }
        });
      });
      const finished = new Promise<string>((resolveFinished, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code !== 0) {
            reject(new Error(errors));
          } else {
            resolveFinished(output);
          }
        });
      });
      return { child, ready, finished };
    });
    try {
      await Promise.all(children.map((child) => child.ready));
      for (const child of children) {
        child.child.stdin.end("go\n");
      }
      const outputs = await Promise.all(
        children.map((child) => child.finished),
      );
      expect(
        outputs.filter((output) => output.includes("success")),
      ).toHaveLength(1);
      expect(
        outputs.filter((output) => output.includes("SessionConflictError")),
      ).toHaveLength(1);
      manager.refresh();
      expect(manager.getEntries()).toHaveLength(1);
    } finally {
      for (const child of children) {
        child.child.kill();
      }
    }
  }, 20_000);
});

describe("strict validation and safe tool boundaries", () => {
  it("explicitly refuses old linear data on both read and write, preserving every byte", () => {
    const cwd = project();
    const path = getSessionFilePath(cwd, "old");
    mkdirSync(dirname(path), { recursive: true });
    const old =
      JSON.stringify({ role: "user", content: "old", timestamp: 1 }) + "\n";
    writeFileSync(path, old);
    expect(() => loadSession(cwd, "old")).toThrow("Unsupported session format");
    expect(() =>
      saveMessage(cwd, "old", { role: "user", content: "new", timestamp: 2 }),
    ).toThrow("Unsupported session format");
    expect(readFileSync(path, "utf8")).toBe(old);
    expect(listSessions(cwd)[0].error).toContain("Unsupported session format");
  });

  it("rejects malformed, partial, duplicate, cyclic and nonexistent references", () => {
    const manager = SessionManager.create(project(), { persist: false });
    manager.append({ role: "user", content: "task" });
    const valid = manager.export({ scope: "tree", format: "jsonl" });
    const document = parseSessionJsonl(valid);
    const entry = document.entries[0];
    const variants = [
      valid + "{broken\n",
      valid.slice(0, -1),
      serializeDocument({
        ...document,
        records: [
          ...document.records,
          { ...entry, revision: document.revision + 1 },
        ],
      }),
      serializeDocument({
        ...document,
        records: document.records.map((record) =>
          record.type === "message"
            ? { ...record, parentId: record.entryId }
            : record,
        ),
      }),
      serializeDocument({
        ...document,
        records: document.records.map((record) =>
          record.type === "active_leaf"
            ? { ...record, leafId: "unknown" }
            : record,
        ),
      }),
      serializeDocument({
        ...document,
        records: document.records.map((record) => ({
          ...record,
          revision: record.revision + 1,
        })),
      }),
    ];
    for (const serialized of variants) {
      expect(() => parseSessionJsonl(serialized)).toThrow();
    }
  });

  it("does not skip damaged records in an otherwise valid session", () => {
    const cwd = project();
    const manager = SessionManager.create(cwd);
    manager.append({ role: "user", content: "valid" });
    const path = getSessionFilePath(cwd, manager.id);
    const corrupted = readFileSync(path, "utf8") + "{broken\n";
    writeFileSync(path, corrupted);
    expect(() => loadSession(cwd, manager.id)).toThrow(
      "Invalid session record",
    );
    expect(() =>
      manager.append({ role: "assistant", content: "unsafe" }),
    ).toThrow();
    expect(readFileSync(path, "utf8")).toBe(corrupted);
  });

  it("rejects a valid document stored under another filename without changing either identity", () => {
    const cwd = project();
    const manager = SessionManager.create(cwd);
    manager.append({ role: "user", content: "original" });
    const original = readFileSync(getSessionFilePath(cwd, manager.id), "utf8");
    const other = getSessionFilePath(cwd, "different-identity");
    writeFileSync(other, original);
    expect(() => SessionManager.open(cwd, "different-identity")).toThrow(
      "filename",
    );
    expect(() =>
      saveMessage(cwd, "different-identity", {
        role: "user",
        content: "unsafe",
        timestamp: 1,
      }),
    ).toThrow("filename");
    expect(
      listSessions(cwd).find((session) => session.id === "different-identity")
        ?.error,
    ).toContain("filename");
    expect(readFileSync(other, "utf8")).toBe(original);
    expect(readFileSync(getSessionFilePath(cwd, manager.id), "utf8")).toBe(
      original,
    );
  });

  it("orders by revisions and random identities even when clocks repeat or move backwards", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const cwd = project();
      const first = SessionManager.create(cwd);
      const second = SessionManager.create(cwd);
      expect(first.id).not.toBe(second.id);
      const a = first.append({ role: "user", content: "A" });
      clock.mockReturnValue(500);
      const b = first.append({ role: "assistant", content: "B" });
      expect(a).not.toBe(b);
      const document = parseSessionJsonl(
        readFileSync(getSessionFilePath(cwd, first.id), "utf8"),
      );
      expect(document.entries[1].timestamp).toBeLessThan(
        document.entries[0].timestamp,
      );
      expect(document.revision).toBe(4);
      expect(first.getMessages().map((message) => message.content)).toEqual([
        "A",
        "B",
      ]);
      expect(() =>
        first.append({
          role: "user",
          content: "invalid",
          timestamp: Number.POSITIVE_INFINITY,
        }),
      ).toThrow();
      expect(() =>
        first.append({
          role: "user",
          content: "invalid",
          timestamp: Number.MAX_VALUE,
        }),
      ).toThrow();
      expect(first.revision).toBe(4);
    } finally {
      clock.mockRestore();
    }
  });

  it("enforces pairing on every branch and navigates a complete tool batch atomically", () => {
    const manager = SessionManager.create(project());
    manager.append({ role: "user", content: "task" });
    const call = manager.append({
      role: "assistant",
      content: "",
      toolUses: [
        { toolUseId: "a", toolName: "ReadFile", arguments: {} },
        { toolUseId: "b", toolName: "ReadFile", arguments: {} },
      ],
    });
    expect(() => manager.navigate(call)).toThrow("incomplete");
    expect(() =>
      manager.append({ role: "assistant", content: "cannot split" }),
    ).toThrow("splits a tool batch");
    expect(() =>
      manager.append({
        role: "user",
        content: "",
        toolResults: [
          { toolUseId: "unknown", content: "orphan", isError: false },
        ],
      }),
    ).toThrow("orphaned");
    const partial = manager.append({
      role: "user",
      content: "",
      toolResults: [{ toolUseId: "a", content: "A", isError: false }],
    });
    expect(() => manager.navigate(partial)).toThrow("incomplete");
    const paired = manager.append({
      role: "user",
      content: "",
      toolResults: [{ toolUseId: "b", content: "B", isError: false }],
    });
    manager.append({ role: "assistant", content: "complete" });
    manager.navigate(call);
    expect(manager.leafId).toBe(paired);
    expect(manager.getMessages()[2].toolResults?.[0].content).toBe("A");
    expect(() =>
      manager.append({
        role: "user",
        content: "",
        toolResults: [{ toolUseId: "a", content: "duplicate", isError: false }],
      }),
    ).toThrow("orphaned");
  });

  it("rejects duplicate calls and compaction that drops pending results", () => {
    const cwd = project();
    const manager = SessionManager.create(cwd);
    expect(() =>
      manager.append({
        role: "assistant",
        content: "",
        toolUses: [
          { toolUseId: "a", toolName: "Read", arguments: {} },
          { toolUseId: "a", toolName: "Read", arguments: {} },
        ],
      }),
    ).toThrow("duplicate tool call");
    manager.append({
      role: "assistant",
      content: "",
      toolUses: [{ toolUseId: "a", toolName: "Read", arguments: {} }],
    });
    expect(() =>
      saveCompactBoundary(cwd, manager.id, { summary: "unsafe", keep: [] }),
    ).toThrow("compaction splits");
  });

  it("round-trips rich tool results, provider IDs and opaque thinking", () => {
    const cwd = project();
    saveMessage(cwd, "session", {
      role: "assistant",
      content: "",
      timestamp: 1,
      thinking_blocks: [
        { type: "thinking", thinking: "visible", signature: "sig" },
        { type: "redacted_thinking", data: "OPAQUE" },
      ],
      tool_uses: toolUsesToRecords([
        {
          toolUseId: "call",
          toolName: "ComputerUse",
          providerItemId: "provider",
          arguments: {},
        },
      ]),
    });
    saveMessage(cwd, "session", {
      role: "user",
      content: "",
      timestamp: 2,
      tool_results: toolResultsToRecords([
        {
          toolUseId: "call",
          content: "image",
          isError: false,
          contentBlocks: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "QUJD" },
            },
          ],
        },
      ]),
    });
    const restored = rebuildFromSession(loadSession(cwd, "session"));
    expect(restored[0].thinkingBlocks).toMatchObject([
      { thinking: "visible", signature: "sig" },
      { data: "OPAQUE" },
    ]);
    expect(restored[0].toolUses?.[0].providerItemId).toBe("provider");
    expect(restored[1].toolResults?.[0].contentBlocks?.[0]).toMatchObject({
      type: "image",
      source: { data: "QUJD" },
    });
  });
});

describe("path-local compaction and activity", () => {
  it("keeps original history and restores different branch compactions independently", () => {
    const cwd = project();
    const manager = SessionManager.create(cwd);
    manager.append({ role: "user", content: "old" });
    const reply = manager.append({ role: "assistant", content: "old reply" });
    saveCompactBoundary(cwd, manager.id, {
      summary: "summary A",
      keep: [{ role: "user", content: "tail A" }],
    });
    manager.refresh();
    const a = manager.leafId;
    manager.navigate(reply);
    saveCompactBoundary(cwd, manager.id, {
      summary: "summary B",
      keep: [{ role: "user", content: "tail B" }],
    });
    manager.refresh();
    const b = manager.leafId;
    expect(manager.getMessages()[0].content).toContain("summary B");
    manager.navigate(a);
    expect(manager.getMessages()[0].content).toContain("summary A");
    expect(manager.getEntries()).toHaveLength(4);
    manager.navigate(b);
    expect(manager.getMessages()[1].content).toBe("tail B");
  });

  it("rejects damaged or unpaired compaction instead of silently falling back", () => {
    expect(() =>
      rebuildFromSession([
        {
          role: "system",
          type: COMPACT_BOUNDARY,
          timestamp: 1,
          content: "{broken",
        },
      ]),
    ).toThrow();
    expect(() =>
      rebuildFromSession([
        {
          role: "system",
          type: COMPACT_BOUNDARY,
          timestamp: 1,
          content: JSON.stringify({
            summary: "summary",
            keep: [
              {
                role: "user",
                content: "",
                tool_results: [{ tool_use_id: "orphan", content: "result" }],
              },
            ],
          }),
        },
      ]),
    ).toThrow("orphaned");
  });

  it("returns saveUserMessage's entry identity without losing input provenance", () => {
    const cwd = project();
    const input = recordInput({
      cwd,
      sessionId: "session",
      source: "sdk",
      text: "task",
    });
    const saved = saveUserMessage(cwd, "session", input, { content: "task" });
    expect(saved.entryId).toBe(loadSessionEntries(cwd, "session")[0].entryId);
    expect(saved.user_input).toEqual({
      id: input.id,
      timestamp: input.timestamp,
    });
    expect(() =>
      saveUserMessage(cwd, "other", input, { content: "task" }),
    ).toThrow("does not belong");
  });

  it("does not delete old, named or archived sessions or refresh lifetime on any query", () => {
    const cwd = project();
    const manager = SessionManager.create(cwd);
    manager.append({ role: "user", content: "old" });
    manager.setMetadata({ name: "keep", archived: true });
    const path = getSessionFilePath(cwd, manager.id);
    const aged = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    utimesSync(path, aged, aged);
    const before = statSync(path).mtimeMs;
    loadSession(cwd, manager.id);
    loadSessionForResume(cwd, manager.id);
    SessionManager.open(cwd, manager.id).getTree();
    expect(listSessions(cwd)[0].metadata).toMatchObject({
      name: "keep",
      archived: true,
    });
    expect(statSync(path).mtimeMs).toBe(before);
    expect(existsSync(path)).toBe(true);
  });
});

it.each(["image", "document"])(
  "still rejects unsupported %s attachment sources while accepting JSON schemas named source",
  (type) => {
    const manager = SessionManager.create(project(), { persist: false });
    expect(() =>
      manager.append({
        role: "user",
        content: [{ type, source: { type: "file", path: "/untrusted" } }],
      }),
    ).toThrow(/unsupported attachment source/);
    expect(() =>
      manager.append({
        role: "user",
        content: [
          {
            type,
            source: {
              type: "base64",
              data: "invalid!",
              media_type: "image/png",
            },
          },
        ],
      }),
    ).toThrow(/base64/);
    manager.append({
      role: "assistant",
      content: "",
      toolUses: [
        {
          toolUseId: "schema",
          toolName: "SchemaTool",
          arguments: {
            properties: { source: { type: "string" } },
            source: { type: "object", properties: {} },
          },
        },
      ],
    });
    expect(() =>
      manager.append({
        role: "user",
        content: "",
        toolResults: [
          {
            toolUseId: "schema",
            content: "ok",
            isError: false,
            structuredContent: { source: { type: "repository", path: "src" } },
          },
        ],
      }),
    ).not.toThrow();
  },
);
