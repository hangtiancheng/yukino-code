import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";

import { load } from "cheerio";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CODE_MODE_RECORD,
  CODE_MODE_RECOVERY_RECORD,
} from "@/code-mode/constants.js";
import {
  COMPACT_BOUNDARY,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACTS,
  MAX_JSON_REFERENCES,
  MAX_JSON_DEPTH,
  MAX_SESSION_BYTES,
  MAX_SESSION_DEPTH,
  MAX_SESSION_RECORDS,
} from "@/session/constants.js";
import { getSessionFilePath, saveCompactBoundary } from "@/session/index.js";
import { SessionManager } from "@/session/manager.js";
import {
  createSessionHeader,
  decodeArtifact,
  makeArtifact,
  parseSessionJsonl,
  serializeDocument,
  SessionMessageSchema,
  validateDocument,
  visitJson,
  type SessionRecord,
} from "@/session/records.js";
import { SESSION_VIEWER_SCRIPT } from "@/session/transfer.js";
import { getSessionsDir, getYukinoDir } from "@/storage/index.js";
import { writeSpill } from "@/tool-result/index.js";
import { buildSpillPreview } from "@/tool-result/prompts.js";

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.useRealTimers();
});
function serializeUnknown(document: {
  header: unknown;
  records: unknown[];
}): string {
  return (
    [document.header, ...document.records]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n"
  );
}
function project(name = "project"): string {
  const directory = join(dirname(getYukinoDir()), name);
  mkdirSync(directory, { recursive: true });
  return realpathSync(directory);
}
function fixture(): SessionManager {
  const manager = SessionManager.create(project(), { persist: false });
  manager.append({ role: "user", content: "root" });
  const a = manager.append({
    role: "assistant",
    content: "A",
    cost: { amount: 2, currency: "USD", attemptId: "original-attempt" },
    timestamp: 1,
  });
  manager.append({ role: "user", content: "future question" });
  manager.append({ role: "assistant", content: "future answer" });
  manager.navigate(a);
  manager.append({ role: "user", content: "branch B" });
  manager.append({ role: "assistant", content: "B" });
  manager.setMetadata({ name: "session name", tags: ["work"], archived: true });
  manager.setLabel(a, "A label");
  return manager;
}

describe("session copies and portable transfers", () => {
  it("clones only the active path with new identities, provenance, labels and historical costs", () => {
    const source = fixture();
    const clone = source.clone();
    expect(clone.id).not.toBe(source.id);
    expect(clone.getEntries()).toHaveLength(4);
    const sourceIds = new Set(
      source.getEntries().map((entry) => entry.entryId),
    );
    for (const entry of clone.getEntries()) {
      expect(sourceIds.has(entry.entryId)).toBe(false);
      expect(entry.provenance?.sessionId).toBe(source.id);
    }
    expect(clone.getEntries()[1].message.cost).toEqual(
      source.getEntries()[1].message.cost,
    );
    expect(clone.getTree()[0].children[0].label).toBe("A label");
    expect(clone.getMetadata()).toEqual(source.getMetadata());
    expect(clone.persistent).toBe(false);
  });

  it("forks the selected user's prefix and supplies its input without mutating the source", () => {
    const source = fixture();
    const selected = source
      .getEntries()
      .find((entry) => entry.message.content === "future question");
    if (!selected) {
      throw new Error("Missing fixture entry");
    }
    const leaf = source.leafId;
    const fork = source.fork(selected.entryId);
    expect(fork.getMessages().map((message) => message.content)).toEqual([
      "root",
      "A",
    ]);
    expect(fork.initialInput).toBe("future question");
    expect(source.leafId).toBe(leaf);
    expect(source.getEntries()).toHaveLength(6);
    expect(() => source.fork(source.getEntries()[1].entryId)).toThrow(
      "ordinary user entry",
    );
  });

  it("round-trips all branches or just the active path without accepting an imported cwd", () => {
    const source = fixture();
    const tree = source.export({ scope: "tree", format: "jsonl" });
    const active = source.export({ scope: "active", format: "jsonl" });
    const importedTree = SessionManager.import(project("destination"), tree);
    const importedActive = SessionManager.import(project("another"), active);
    expect(importedTree.getEntries()).toHaveLength(6);
    expect(importedActive.getEntries()).toHaveLength(4);
    expect(importedTree.cwd).toBe(project("destination"));
    expect(importedTree.getMessages()).toEqual(source.getMessages());
    const originals = new Map(
      source.getEntries().map((entry) => [entry.entryId, entry]),
    );
    const identities = new Map(
      importedTree
        .getEntries()
        .map((entry) => [entry.provenance?.entryId, entry.entryId]),
    );
    for (const entry of importedTree.getEntries()) {
      const original = entry.provenance
        ? originals.get(entry.provenance.entryId)
        : undefined;
      if (!original) {
        throw new Error("Missing import provenance");
      }
      expect(entry.message).toEqual({ ...original.message, historical: true });
      expect(entry.parentId).toBe(
        original.parentId === null ? null : identities.get(original.parentId),
      );
      expect(entry.timestamp).toBe(original.timestamp);
    }
    expect(importedTree.leafId).toBe(identities.get(source.leafId ?? ""));
    expect(importedTree.getMetadata()).toEqual(source.getMetadata());
    expect(importedTree.getTree()[0].children[0].label).toBe("A label");
    const raw = parseSessionJsonl(
      readFileSync(
        getSessionFilePath(importedTree.cwd, importedTree.id),
        "utf8",
      ),
    );
    expect(raw.header.provenance).toMatchObject({
      operation: "import",
      sessionId: source.id,
    });
    expect(raw.header).not.toHaveProperty("cwd");
  });

  it("remaps tool/input references but preserves external runtime state through clone/import", () => {
    const manager = SessionManager.create(project(), { persist: false });
    const root = manager.append({
      role: "user",
      content: "task",
      timestamp: 1,
      user_input: {
        id: "7bf9bb1a-c6f7-478e-8053-a8d48d823a0d",
        timestamp: 1000,
      },
    });
    manager.append({
      role: "assistant",
      content: "",
      toolUses: [{ toolUseId: "old-call", toolName: "Read", arguments: {} }],
    });
    manager.append({
      role: "user",
      content: "",
      toolResults: [
        { toolUseId: "old-call", content: "output", isError: false },
      ],
    });
    manager.append({ role: "assistant", content: "done" });
    manager.appendRuntimeState({
      provider: {
        name: "provider",
        protocol: "openai",
        model: root,
        endpointFingerprint: "a".repeat(64),
      },
      thinking: "off",
      tools: [],
      discovered: [],
    });
    const copied = SessionManager.import(
      project("destination"),
      manager.export({ scope: "tree", format: "jsonl" }),
    );
    const entries = copied.getEntries();
    expect(entries[0].message.user_input?.id).not.toBe(
      manager.getEntries()[0].message.user_input?.id,
    );
    const call = entries[1].message.tool_uses?.[0].tool_use_id;
    expect(call).not.toBe("old-call");
    expect(entries[2].message.tool_results?.[0].tool_use_id).toBe(call);
    expect(copied.getRuntimeState()?.provider.model).toBe(root);
    expect(copied.getRuntimeState()).toEqual(manager.getRuntimeState());
    expect(copied.getMessages()).toHaveLength(4);
  });

  it("copies system execution records as historical data without starting any runtime", () => {
    const source = SessionManager.create(project(), { persist: false });
    source.append({
      role: "system",
      content: JSON.stringify({
        kind: "finished",
        id: "run",
        result: { output: "result", isError: false },
      }),
      type: CODE_MODE_RECORD,
      timestamp: 1,
    });
    source.append({ role: "user", content: "task" });
    const cloned = source.clone();
    expect(cloned.getEntries()[0].message.historical).toBe(true);
    expect(cloned.getMessages()).toEqual([{ role: "user", content: "task" }]);
    expect(existsSync(getSessionsDir(project()))).toBe(false);
  });

  it("portable artifacts carry IDs, MIME, lengths and hashes and have independent copied bytes", () => {
    const source = SessionManager.create(project(), { persist: false });
    source.append({
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "QUJD" },
        },
      ],
    });
    const serialized = source.export({ scope: "tree", format: "jsonl" });
    const portable = parseSessionJsonl(serialized);
    const artifact = [...portable.artifacts.values()][0];
    expect(artifact).toMatchObject({
      mimeType: "image/png",
      length: 3,
      data: "QUJD",
      sha256: createHash("sha256").update("ABC").digest("hex"),
    });
    expect(serialized).not.toContain('"source":{"type":"base64"');
    const copied = SessionManager.import(project("destination"), serialized);
    const imported = parseSessionJsonl(
      copied.export({ scope: "tree", format: "jsonl" }),
    );
    expect([...imported.artifacts.values()][0].artifactId).not.toBe(
      artifact.artifactId,
    );
    expect(copied.getMessages()[0].content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "QUJD" },
      },
    ]);
  });

  it("embeds necessary full spill results without copying arbitrary owner runtime files", () => {
    const source = SessionManager.create(project());
    source.append({
      role: "assistant",
      content: "",
      toolUses: [{ toolUseId: "call", toolName: "Read", arguments: {} }],
    });
    const full = "full output\n".repeat(250);
    const path = writeSpill(source.id, "call", full);
    source.append({
      role: "user",
      content: "",
      toolResults: [
        {
          toolUseId: "call",
          content: buildSpillPreview(full, path),
          isError: false,
        },
      ],
    });
    const serialized = source.export({ scope: "tree", format: "jsonl" });
    expect(serialized).not.toContain(path);
    expect(parseSessionJsonl(serialized).artifacts.size).toBe(1);
    const imported = SessionManager.import(project("destination"), serialized);
    writeFileSync(path, "source changed");
    expect(imported.getMessages()[1].toolResults?.[0].content).toContain(full);
    expect(imported.export({ scope: "tree", format: "jsonl" })).not.toContain(
      "source changed",
    );
  });

  it("preserves structuredContent and raw MCP image/resource bytes through copy and restore", () => {
    const source = SessionManager.create(project(), { persist: false });
    source.append({
      role: "assistant",
      content: "",
      toolUses: [{ toolUseId: "call", toolName: "McpCall", arguments: {} }],
    });
    const raw = [
      { type: "image", data: "QUJD", mimeType: "image/png" },
      {
        type: "resource",
        resource: {
          uri: "mcp://resource",
          blob: "REVG",
          mimeType: "application/octet-stream",
        },
      },
    ];
    source.append({
      role: "user",
      content: "",
      toolResults: [
        {
          toolUseId: "call",
          content: "result",
          isError: false,
          structuredContent: { answer: 42 },
          rawContent: raw,
        },
      ],
    });
    const serialized = source.export({ scope: "tree", format: "jsonl" });
    expect(parseSessionJsonl(serialized).artifacts.size).toBe(2);
    const imported = SessionManager.import(project("destination"), serialized);
    expect(imported.getMessages()[1].toolResults?.[0]).toMatchObject({
      structuredContent: { answer: 42 },
      rawContent: raw,
    });
    expect(
      imported.clone().getMessages()[1].toolResults?.[0].rawContent,
    ).toEqual(raw);
    const redacted = imported.export({
      scope: "tree",
      format: "jsonl",
      redact: true,
    });
    expect(parseSessionJsonl(redacted).artifacts.size).toBe(0);
    expect(redacted).not.toContain("QUJD");
    expect(redacted).not.toContain("REVG");
  });

  it("restores and copies a CodeMode recovery as a paired tool result without replaying work", () => {
    const source = SessionManager.create(project(), { persist: false });
    source.append({
      role: "assistant",
      content: "",
      toolUses: [{ toolUseId: "call", toolName: "CodeMode", arguments: {} }],
    });
    source.append({
      role: "system",
      type: CODE_MODE_RECOVERY_RECORD,
      timestamp: 1,
      content: JSON.stringify({
        id: "call",
        result: {
          output: "recovered",
          isError: false,
          structuredContent: { value: 1 },
          contentBlocks: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "QUJD" },
            },
          ],
        },
      }),
    });
    const copied = source.clone();
    expect(copied.getMessages()[1].toolResults?.[0]).toMatchObject({
      content: "recovered",
      structuredContent: { value: 1 },
    });
    expect(copied.getMessages()[0].toolUses?.[0].toolUseId).toBe(
      copied.getMessages()[1].toolResults?.[0].toolUseId,
    );
    expect(copied.getEntries()[1].message.historical).toBe(true);
  });

  it("keeps compacted rich artifacts portable and copies the uncompacted original tree", () => {
    const source = SessionManager.create(project());
    source.append({ role: "user", content: "old" });
    saveCompactBoundary(source.cwd, source.id, {
      summary: "summary",
      keep: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "QUJD" },
            },
          ],
        },
      ],
    });
    source.refresh();
    const imported = SessionManager.import(
      project("destination"),
      source.export({ scope: "tree", format: "jsonl" }),
    );
    expect(imported.getMessages()).toEqual(source.getMessages());
    expect(imported.getEntries()).toHaveLength(2);
    expect(imported.getEntries()[1].message.type).toBe(COMPACT_BOUNDARY);
  });
});

describe("structured full-result artifacts", () => {
  function fullResult() {
    const source = SessionManager.create(project());
    source.append({
      role: "assistant",
      content: "",
      toolUses: [
        {
          toolUseId: "run",
          toolName: "CodeMode",
          arguments: { code: "return 42" },
        },
      ],
    });
    const payload = {
      output: "full result\n".repeat(300),
      contentBlocks: [
        { type: "text", text: "```diff\n+safe\n```" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "QUJD" },
        },
      ],
      structuredContent: { value: { answer: 42, code: "</script>" } },
      rawContent: [{ type: "image", data: "REVG", mimeType: "image/png" }],
    };
    const full = JSON.stringify(payload);
    const path = writeSpill(source.id, "run", full);
    const artifact = {
      id: "run",
      path,
      mimeType: "application/json",
      size: Buffer.byteLength(full),
      hash: createHash("sha256").update(full).digest("hex"),
    };
    source.append({
      role: "system",
      type: CODE_MODE_RECORD,
      timestamp: 1,
      content: JSON.stringify({
        kind: "finished",
        id: "run",
        result: {
          output: `preview\nFull output: ${path}`,
          isError: false,
          artifact,
        },
      }),
    });
    source.append({
      role: "system",
      type: CODE_MODE_RECOVERY_RECORD,
      timestamp: 1,
      content: JSON.stringify({
        id: "run",
        result: {
          output: `preview\nFull output: ${path}`,
          isError: false,
          artifact,
        },
      }),
    });
    return { source, payload, path, artifact };
  }

  it("packages CodeMode full JSON results and hydrates code, structured, raw and images after source removal", () => {
    const { source, payload, path } = fullResult();
    const serialized = source.export({ scope: "tree", format: "jsonl" });
    const portable = parseSessionJsonl(serialized);
    const artifact = [...portable.artifacts.values()][0];
    expect(portable.artifacts.size).toBe(1);
    expect(JSON.parse(decodeArtifact(artifact).toString("utf8"))).toEqual(
      payload,
    );
    expect(serialized).not.toContain(path);
    expect(serialized).not.toContain('"path":');
    const html = load(source.export({ scope: "tree", format: "html" }));
    expect(html("body").text()).toContain("full result");
    expect(html("body").text()).toContain(payload.structuredContent.value.code);
    expect(html("iframe, object, embed")).toHaveLength(0);
    expect(html("script")).toHaveLength(1);
    expect(html("script").text()).toBe(SESSION_VIEWER_SCRIPT);
    const imported = SessionManager.import(project("destination"), serialized);
    const clone = source.clone();
    rmSync(dirname(path), { recursive: true });
    for (const copy of [
      imported,
      clone,
      SessionManager.open(clone.cwd, clone.id),
    ]) {
      const result = copy.getMessages()[1].toolResults?.[0];
      expect(result).toMatchObject({
        content: payload.output,
        contentBlocks: payload.contentBlocks,
        structuredContent: payload.structuredContent,
        rawContent: payload.rawContent,
      });
      expect(result?.artifact).toMatchObject({
        mimeType: "application/json",
        size: artifact.length,
        hash: artifact.sha256,
      });
      expect(result?.artifact?.id).not.toBe(artifact.artifactId);
      expect(result?.artifact).not.toHaveProperty("path");
      expect(
        SessionManager.import(
          project("repeat"),
          copy.export({ scope: "tree", format: "jsonl" }),
        ).getMessages()[1].toolResults?.[0].content,
      ).toBe(payload.output);
    }
  });

  it("packages explicit tool-result artifacts without requiring a preview wrapper", () => {
    const source = SessionManager.create(project());
    source.append({
      role: "assistant",
      content: "",
      toolUses: [{ toolUseId: "call", toolName: "Read", arguments: {} }],
    });
    const path = writeSpill(source.id, "call", "complete text");
    source.append({
      role: "user",
      content: "",
      toolResults: [
        {
          toolUseId: "call",
          content: "preview only",
          isError: false,
          artifact: { id: "call", path, mimeType: "text/plain" },
        },
      ],
    });
    const clone = source.clone();
    unlinkSync(path);
    expect(clone.getMessages()[1].toolResults?.[0].content).toBe(
      "complete text",
    );
    expect(
      clone.getEntries()[1].message.tool_results?.[0].artifact,
    ).not.toHaveProperty("path");
  });

  it("refuses absolute, traversal, mismatched identity, size and hash artifact sources", () => {
    const source = SessionManager.create(project());
    source.append({
      role: "assistant",
      content: "",
      toolUses: [{ toolUseId: "call", toolName: "Read", arguments: {} }],
    });
    const path = writeSpill(source.id, "call", "complete");
    source.append({
      role: "user",
      content: "",
      toolResults: [
        {
          toolUseId: "call",
          content: "preview",
          isError: false,
          artifact: { id: "call", path, mimeType: "text/plain" },
        },
      ],
    });
    const external = join(project(), "external");
    writeFileSync(external, "must remain unread");
    const raw = parseSessionJsonl(
      readFileSync(getSessionFilePath(source.cwd, source.id), "utf8"),
    );
    const variants = [
      { id: "call", path: external },
      { id: "call", path: `${dirname(path)}/../tool-results/call.txt` },
      { id: "another", path },
      { id: "call", path, size: 999 },
      { id: "call", path, hash: "0".repeat(64) },
    ];
    for (const artifact of variants) {
      writeFileSync(
        getSessionFilePath(source.cwd, source.id),
        serializeUnknown({
          ...raw,
          records: raw.records.map((record) =>
            record.type === "message" && record.message.tool_results
              ? {
                  ...record,
                  message: {
                    ...record.message,
                    tool_results: [
                      { ...record.message.tool_results[0], artifact },
                    ],
                  },
                }
              : record,
          ),
        }),
      );
      source.refresh();
      expect(() => source.export({ scope: "tree", format: "jsonl" })).toThrow();
    }
    expect(readFileSync(external, "utf8")).toBe("must remain unread");
  });

  it("rejects imported descriptor paths in recovery JSON without reading or writing any host artifact", () => {
    const { source } = fullResult();
    const portable = parseSessionJsonl(
      source.export({ scope: "tree", format: "jsonl" }),
    );
    const target = join(project(), "host-target");
    writeFileSync(target, "host bytes");
    const serialized = serializeUnknown({
      ...portable,
      records: portable.records.map((record) => {
        if (
          record.type !== "message" ||
          record.message.type !== CODE_MODE_RECOVERY_RECORD ||
          typeof record.message.content !== "string"
        ) {
          return record;
        }
        const payload: unknown = JSON.parse(record.message.content);
        return {
          ...record,
          message: {
            ...record.message,
            content: JSON.stringify(
              visitJson(payload, (value) => {
                if (
                  value &&
                  typeof value === "object" &&
                  "artifact" in value &&
                  value.artifact &&
                  typeof value.artifact === "object"
                ) {
                  return {
                    ...value,
                    artifact: { ...value.artifact, path: target },
                  };
                }
                return value;
              }),
            ),
          },
        };
      }),
    });
    const before = readdirSync(getSessionsDir(source.cwd));
    const opens = vi.spyOn(fs, "openSync");
    syncBuiltinESMExports();
    expect(() => SessionManager.import(source.cwd, serialized)).toThrow(
      "imported host paths",
    );
    expect(opens).not.toHaveBeenCalled();
    expect(readdirSync(getSessionsDir(source.cwd))).toEqual(before);
    expect(readFileSync(target, "utf8")).toBe("host bytes");
  });

  it.each(["symlink", "hardlink"])("rejects an explicit %s spill", (kind) => {
    const { source, path } = fullResult();
    const external = join(project(), "external");
    writeFileSync(external, readFileSync(path));
    unlinkSync(path);
    if (kind === "symlink") {
      symlinkSync(external, path);
    } else {
      linkSync(external, path);
    }
    expect(() => source.export({ scope: "tree", format: "jsonl" })).toThrow(
      /symlink|hardlink/u,
    );
    expect(() => source.clone()).toThrow(/symlink|hardlink/u);
  });

  it("rejects a linked owner ancestor instead of trusting lexical containment", () => {
    const { source, path } = fullResult();
    const moved = join(project(), "moved-owner-parent");
    const ownerParent = dirname(dirname(dirname(path)));
    fs.renameSync(ownerParent, moved);
    symlinkSync(moved, ownerParent, "dir");
    expect(() => source.export({ scope: "tree", format: "jsonl" })).toThrow(
      "symlink",
    );
  });

  it("redacts packaged full JSON data rather than merely dropping its preview", () => {
    const { source, path } = fullResult();
    const portable = source.export({
      scope: "tree",
      format: "jsonl",
      redact: true,
    });
    expect(portable).not.toContain(path);
    const imported = SessionManager.import(project("destination"), portable);
    expect(imported.getMessages()[1].toolResults?.[0].content).toContain(
      "full result",
    );
    expect(
      imported.getMessages()[1].toolResults?.[0].contentBlocks,
    ).not.toContainEqual(expect.objectContaining({ type: "image" }));
    expect(portable).not.toContain("QUJD");
    expect(portable).not.toContain("REVG");
  });
});

describe("import and export security limits", () => {
  it("rejects bad hashes/base64/lengths, missing references, path-bearing artifacts and incomplete calls before publication", () => {
    const source = SessionManager.create(project(), { persist: false });
    source.append({
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "QUJD" },
        },
      ],
    });
    const valid = parseSessionJsonl(
      source.export({ scope: "tree", format: "jsonl" }),
    );
    const artifact = [...valid.artifacts.values()][0];
    const destination = project("destination");
    const variants = [
      serializeDocument({
        ...valid,
        records: valid.records.map((record) =>
          record.type === "artifact"
            ? { ...record, sha256: "0".repeat(64) }
            : record,
        ),
      }),
      serializeDocument({
        ...valid,
        records: valid.records.map((record) =>
          record.type === "artifact"
            ? { ...record, data: "!invalid!" }
            : record,
        ),
      }),
      serializeDocument({
        ...valid,
        records: valid.records.map((record) =>
          record.type === "artifact"
            ? { ...record, length: artifact.length + 1 }
            : record,
        ),
      }),
      serializeDocument({
        ...valid,
        records: valid.records.map((record) =>
          record.type === "artifact"
            ? { ...record, path: "/etc/passwd" }
            : record,
        ),
      }),
      serializeDocument({
        ...valid,
        records: valid.records.map((record) =>
          record.type === "artifact"
            ? { ...record, artifactId: "unknown" }
            : record,
        ),
      }),
      serializeUnknown({ ...valid, header: { ...valid.header, cwd: "/etc" } }),
    ];
    const unfinished = SessionManager.create(project(), { persist: false });
    unfinished.append({
      role: "assistant",
      content: "",
      toolUses: [{ toolUseId: "pending", toolName: "Write", arguments: {} }],
    });
    const unfinishedDocument = validateDocument(createSessionHeader(), [
      {
        type: "message",
        entryId: "entry",
        parentId: null,
        timestamp: 1,
        revision: 1,
        message: {
          role: "assistant",
          content: "",
          timestamp: 1,
          tool_uses: [{ tool_use_id: "pending", tool_name: "Write" }],
        },
      },
      { type: "active_leaf", leafId: "entry", revision: 2 },
    ]);
    variants.push(serializeDocument(unfinishedDocument));
    for (const serialized of variants) {
      expect(() => SessionManager.import(destination, serialized)).toThrow();
    }
    expect(existsSync(getSessionsDir(destination))).toBe(false);
    expect(() => unfinished.export({ scope: "tree", format: "jsonl" })).toThrow(
      "incomplete tool batch",
    );
  });

  it("rejects active-leaf controls inside old pending batches and ambiguous navigation", () => {
    const header = createSessionHeader();
    const records: SessionRecord[] = [
      {
        type: "message",
        entryId: "call-entry",
        parentId: null,
        timestamp: 1,
        revision: 1,
        message: {
          role: "assistant",
          content: "",
          timestamp: 1,
          tool_uses: [{ tool_use_id: "call", tool_name: "Read" }],
        },
      },
      { type: "active_leaf", leafId: "call-entry", revision: 2 },
      {
        type: "message",
        entryId: "left",
        parentId: "call-entry",
        timestamp: 1,
        revision: 3,
        message: {
          role: "user",
          content: "left",
          timestamp: 1,
          tool_results: [{ tool_use_id: "call", content: "left" }],
        },
      },
      {
        type: "message",
        entryId: "right",
        parentId: "call-entry",
        timestamp: 1,
        revision: 4,
        message: {
          role: "user",
          content: "right",
          timestamp: 1,
          tool_results: [{ tool_use_id: "call", content: "right" }],
        },
      },
      { type: "active_leaf", leafId: "left", revision: 5 },
    ];
    const document = validateDocument(header, records, { completeTools: true });
    expect(() =>
      validateDocument(header, [
        ...records,
        { type: "active_leaf", leafId: "call-entry", revision: 6 },
      ]),
    ).toThrow("splits a tool batch");
    const manager = SessionManager.import(
      project(),
      serializeDocument(document),
    );
    const before = manager.leafId;
    expect(() => manager.navigate(manager.getEntries()[0].entryId)).toThrow(
      "ambiguous",
    );
    expect(manager.leafId).toBe(before);
  });

  it("fails invalid imports without leaving a half session in an existing directory", () => {
    const destination = project();
    const kept = SessionManager.create(destination);
    const before = readdirSync(getSessionsDir(destination));
    expect(() =>
      SessionManager.import(destination, "<html>not JSONL</html>\n"),
    ).toThrow();
    expect(readdirSync(getSessionsDir(destination))).toEqual(before);
    expect(SessionManager.open(destination, kept.id).getEntries()).toEqual([]);
  });

  it("bounds bytes, JSON depth, record count, tree depth and artifact expansion", () => {
    const destination = project();
    expect(() =>
      SessionManager.import(destination, " ".repeat(MAX_SESSION_BYTES + 1)),
    ).toThrow("byte limit");
    let nested: unknown = "leaf";
    for (let index = 0; index < MAX_JSON_DEPTH + 1; index++) {
      nested = { nested };
    }
    expect(() =>
      validateDocument(createSessionHeader(), [
        {
          type: "message",
          entryId: "entry",
          parentId: null,
          timestamp: 1,
          revision: 1,
          message: { role: "user", content: [{ nested }], timestamp: 1 },
        },
      ]),
    ).toThrow("JSON limits");
    expect(() =>
      parseSessionJsonl(
        JSON.stringify(createSessionHeader()) +
          "\n" +
          "{}\n".repeat(MAX_SESSION_RECORDS),
      ),
    ).toThrow("record limit");
    const entries: SessionRecord[] = Array.from(
      { length: MAX_SESSION_DEPTH + 1 },
      (_, index) => ({
        type: "message",
        entryId: `entry-${String(index)}`,
        parentId: index === 0 ? null : `entry-${String(index - 1)}`,
        timestamp: 1,
        revision: index + 1,
        message: { role: "user", content: "task", timestamp: 1 },
      }),
    );
    expect(() => validateDocument(createSessionHeader(), entries)).toThrow(
      "tree depth",
    );
    const artifact = makeArtifact(
      Buffer.alloc(MAX_ARTIFACT_BYTES),
      "text/plain",
      1,
    );
    expect(() =>
      validateDocument(createSessionHeader(), [
        artifact,
        {
          type: "message",
          entryId: "entry",
          parentId: null,
          timestamp: 1,
          revision: 2,
          message: {
            role: "user",
            content: Array.from({ length: 5 }, () => ({
              type: "text",
              text: `artifact://${artifact.artifactId}`,
            })),
            timestamp: 1,
          },
        },
        { type: "active_leaf", leafId: "entry", revision: 3 },
      ]),
    ).toThrow("expansion budget");
    expect(existsSync(getSessionsDir(destination))).toBe(false);
  });

  it("enforces aggregate artifact count and JSON reference budgets", () => {
    const artifacts: SessionRecord[] = Array.from(
      { length: MAX_ARTIFACTS + 1 },
      (_, index) => ({
        ...makeArtifact(Buffer.alloc(0), "text/plain", index + 1),
      }),
    );
    expect(() => validateDocument(createSessionHeader(), artifacts)).toThrow(
      "artifact budget",
    );
    const content = Array.from({ length: MAX_JSON_REFERENCES }, () => ({
      type: "text",
      text: "",
    }));
    expect(() =>
      SessionManager.import(
        project("destination"),
        serializeUnknown({
          header: createSessionHeader(),
          records: [
            {
              type: "message",
              entryId: "entry",
              parentId: null,
              revision: 1,
              timestamp: 1,
              message: { role: "user", content, timestamp: 1 },
            },
            { type: "active_leaf", revision: 2, leafId: "entry" },
          ],
        }),
      ),
    ).toThrow("Invalid session record");
    expect(existsSync(getSessionsDir(project("destination")))).toBe(false);
  });

  it("rejects unsafe prototypes and non-JSON objects without publishing", () => {
    const header = createSessionHeader();
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const state: unknown = JSON.parse(`{"${key}":{"polluted":true}}`);
      const serialized = serializeUnknown({
        header,
        records: [
          {
            type: "message",
            entryId: "entry",
            parentId: null,
            revision: 1,
            timestamp: 1,
            message: { role: "user", content: "task", state, timestamp: 1 },
          },
          { type: "active_leaf", revision: 2, leafId: "entry" },
        ],
      });
      expect(() =>
        SessionManager.import(project("destination"), serialized),
      ).toThrow("Invalid session record");
    }
    const manager = SessionManager.create(project(), { persist: false });
    expect(() =>
      manager.append({
        role: "user",
        content: [{ value: new Date() }],
        timestamp: 1,
      }),
    ).toThrow("non-JSON object");
    expect(manager.getEntries()).toEqual([]);
    expect(existsSync(getSessionsDir(project("destination")))).toBe(false);
  });

  it("publishes complete bytes atomically and refuses a raced destination without overwriting it", () => {
    const source = fixture();
    const serialized = source.export({ scope: "tree", format: "jsonl" });
    const destination = project("destination");
    const original = fs.linkSync;
    let identity = "";
    const links = vi
      .spyOn(fs, "linkSync")
      .mockImplementation((temporary, target) => {
        const complete = parseSessionJsonl(readFileSync(temporary, "utf8"), {
          completeTools: true,
        });
        expect(complete.entries).toHaveLength(source.getEntries().length);
        expect(existsSync(target)).toBe(false);
        identity = String(target);
        writeFileSync(target, "raced identity must be preserved\n");
        original(temporary, target);
      });
    syncBuiltinESMExports();
    expect(() => SessionManager.import(destination, serialized)).toThrow(
      /EEXIST/u,
    );
    expect(links).toHaveBeenCalledOnce();
    expect(readFileSync(identity, "utf8")).toBe(
      "raced identity must be preserved\n",
    );
    expect(
      readdirSync(getSessionsDir(destination)).some((name) =>
        name.endsWith("publish-tmp"),
      ),
    ).toBe(false);
  });

  it("refuses traversal and symlink artifact sources, and never reads imported host paths", () => {
    const source = SessionManager.create(project());
    const external = join(project(), "outside.txt");
    writeFileSync(external, "secret outside owner");
    source.append({
      role: "assistant",
      content: "",
      toolUses: [{ toolUseId: "call", toolName: "Read", arguments: {} }],
    });
    const owned = writeSpill(source.id, "call", "original");
    source.append({
      role: "user",
      content: "",
      toolResults: [
        {
          toolUseId: "call",
          content: buildSpillPreview("original", owned),
          isError: false,
        },
      ],
    });
    unlinkSync(owned);
    symlinkSync(external, owned);
    expect(() => source.export({ scope: "tree", format: "jsonl" })).toThrow(
      "symlink",
    );
    const attack = SessionManager.create(project(), { persist: false });
    attack.append({
      role: "user",
      content: buildSpillPreview("secret", external),
    });
    expect(() => attack.export({ scope: "tree", format: "jsonl" })).toThrow(
      "unowned",
    );
  });
});

describe("offline HTML and local diagnostics", () => {
  it("escapes hostile text and permits only the fixed hashed offline viewer script", () => {
    const source = SessionManager.create(project(), { persist: false });
    source.setName('</title><script>alert("x")</script>');
    source.append({
      role: "user",
      content: '</script><img src="https://attacker" onerror="alert(1)">',
    });
    source.append({
      role: "assistant",
      content: "```diff\n+change\n```",
      timestamp: 1,
      thinking_blocks: [
        { type: "thinking", thinking: "visible thought", signature: "sig" },
        { type: "redacted_thinking", data: "OPAQUE-SECRET" },
      ],
      cost: { amount: 3, currency: "USD" },
    });
    const html = source.export({ scope: "tree", format: "html" });
    const page = load(html);
    expect(page("iframe,object,embed,link")).toHaveLength(0);
    expect(page("script")).toHaveLength(1);
    expect(page("script").text()).toBe(SESSION_VIEWER_SCRIPT);
    expect(
      page('meta[http-equiv="Content-Security-Policy"]').attr("content"),
    ).toContain(
      `script-src 'sha256-${createHash("sha256").update(page("script").text()).digest("base64")}'`,
    );
    expect(page("[onerror],[onclick]")).toHaveLength(0);
    expect(
      page('meta[http-equiv="Content-Security-Policy"]').attr("content"),
    ).toContain("default-src 'none'");
    expect(page("details").length).toBeGreaterThanOrEqual(5);
    expect(page("body").text()).toContain("visible thought");
    expect(page("body").text()).toContain("historical usage");
    expect(html).not.toContain("OPAQUE-SECRET");
    expect(html.match(/<script>/gu)).toHaveLength(1);
    expect(html).not.toContain("url(");
    expect(
      page("a")
        .toArray()
        .every((element) => page(element).attr("href")?.startsWith("#")),
    ).toBe(true);
  });

  it("redaction removes secrets, local paths and attachments from JSONL and diagnostics", () => {
    const source = SessionManager.create(project(), { persist: false });
    source.append({
      role: "user",
      content: [
        { type: "text", text: "token=super-secret /Users/me/private/file" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "QUJD" },
        },
      ],
    });
    expect(() =>
      source.append(
        SessionMessageSchema.parse({
          role: "assistant",
          content: "answer",
          timestamp: 1,
          state: {
            authorization: "Bearer top-secret",
            env: { SECRET: "private" },
          },
        }),
      ),
    ).toThrow();
    source.append({ role: "assistant", content: "answer" });
    const exported = source.export({
      scope: "tree",
      format: "jsonl",
      redact: true,
    });
    expect(exported).not.toContain("super-secret");
    expect(exported).not.toContain("top-secret");
    expect(exported).not.toContain("/Users/me");
    expect(exported).not.toContain("QUJD");
    expect(parseSessionJsonl(exported).artifacts.size).toBe(0);
    const defaultDiagnostics = source.diagnostics({
      configuration: {
        apiKey: "secret-key",
        env: { LEAK: "secret-env" },
        model: "model",
      },
    });
    expect(defaultDiagnostics).not.toContain("secret-key");
    expect(defaultDiagnostics).not.toContain("secret-env");
    expect(defaultDiagnostics).not.toContain("transcript");
    const optedIn = source.diagnostics({ includeTranscript: true });
    expect(optedIn).toContain("transcript");
    expect(optedIn).not.toContain("super-secret");
    expect(optedIn).not.toContain("QUJD");
    expect(existsSync(getSessionsDir(project()))).toBe(false);
  });
});
