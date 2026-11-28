import { createHash } from "node:crypto";
import fs, {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";

import { load } from "cheerio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_ARTIFACT_BYTES,
  MAX_SESSION_RECORD_BYTES,
  MAX_SESSION_STREAM_BYTES,
  MAX_SESSION_STRING_BYTES,
  SESSION_TRANSPORT_CHUNK_BYTES,
} from "@/session/constants.js";
import { SessionManager } from "@/session/manager.js";
import * as Records from "@/session/records.js";
import {
  countSessionDocumentBytes,
  createSessionHeader,
  getSessionFilePath,
  makeArtifact,
  SessionConflictError,
  SessionJsonlParser,
  sessionJsonlChunks,
  type SessionRecord,
} from "@/session/records.js";
import {
  sessionImportFileBytes,
  writeSessionExportFile,
} from "@/session/stream.js";
import { SESSION_VIEWER_SCRIPT } from "@/session/transfer.js";
import { getSessionsDir } from "@/storage/index.js";

beforeEach(() => {
  process.env.YUKINO_TEST_HOME = realpathSync(
    process.env.YUKINO_TEST_HOME ?? "",
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});
function project(name = "project"): string {
  const path = join(process.env.YUKINO_TEST_HOME ?? "", name);
  mkdirSync(path, { recursive: true });
  return path;
}
async function* chunks(
  bytes: Uint8Array,
  width = SESSION_TRANSPORT_CHUNK_BYTES,
): AsyncGenerator<Uint8Array> {
  for (let start = 0; start < bytes.length; start += width) {
    yield bytes.subarray(start, start + width);
    await setImmediate();
  }
}
async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const result: Buffer[] = [];
  for await (const chunk of source) {
    expect(chunk.byteLength).toBeLessThanOrEqual(SESSION_TRANSPORT_CHUNK_BYTES);
    expect(chunk.byteLength).toBeGreaterThan(0);
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(chunk),
    ).not.toThrow();
    result.push(Buffer.from(chunk));
  }
  return Buffer.concat(result);
}
function small(): SessionManager {
  const source = SessionManager.create(project(), { persist: false });
  source.append({ role: "user", content: "雪🙂" });
  return source;
}
function large(persistent = false): SessionManager {
  const source = SessionManager.create(project(), { persist: persistent });
  const root = source.append({
    role: "user",
    content: '雪🙂<&>"\\\n'.repeat(100_000),
  });
  source.appendRuntimeState({
    provider: {
      name: "provider",
      protocol: "openai",
      model: root,
      endpointFingerprint: "a".repeat(64),
    },
    thinking: "off",
    tools: [
      {
        name: "Read",
        schemaFingerprint: "b".repeat(64),
        sourceFingerprint: "c".repeat(64),
      },
    ],
    discovered: ["Read"],
  });
  source.append({
    role: "assistant",
    content: "",
    toolUses: [{ toolUseId: "call", toolName: "Read", arguments: {} }],
  });
  const output = "输出🙂<&>\n".repeat(100_000);
  const artifactId = source.appendArtifact(Buffer.from(output), "text/plain");
  source.append({
    role: "user",
    content: "",
    toolResults: [
      {
        toolUseId: "call",
        content: "preview",
        artifact: { id: artifactId },
        isError: false,
      },
    ],
  });
  return source;
}
function files(cwd: string): string[] {
  const path = getSessionsDir(cwd);
  return existsSync(path)
    ? readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
    : [];
}

describe("bounded session stream and file transport", () => {
  it("streams >1MiB UTF-8 plus owned artifacts in JSONL and HTML without export/string shortcuts", async () => {
    const source = large();
    const stringExport = vi.spyOn(source, "export").mockImplementation(() => {
      throw new Error("string shortcut");
    });
    const serialize = vi
      .spyOn(Records, "serializeDocument")
      .mockImplementation(() => {
        throw new Error("whole document shortcut");
      });
    const jsonl = await collect(
      source.exportStream({ scope: "tree", format: "jsonl" }),
    );
    const html = await collect(
      source.exportStream({ scope: "tree", format: "html" }),
    );
    expect(jsonl.length).toBeGreaterThan(MAX_SESSION_STRING_BYTES);
    expect(html.length).toBeGreaterThan(MAX_SESSION_STRING_BYTES);
    const page = load(html.toString("utf8"));
    expect(page("article")).toHaveLength(4);
    expect(page("body").text()).toContain("输出🙂<&>");
    expect(page("iframe,object,embed,[onerror]")).toHaveLength(0);
    expect(page("script")).toHaveLength(1);
    expect(page("script").text()).toBe(SESSION_VIEWER_SCRIPT);
    expect(
      page('meta[http-equiv="Content-Security-Policy"]').attr("content"),
    ).toContain(
      `script-src 'sha256-${createHash("sha256").update(page("script").text()).digest("base64")}'`,
    );
    expect(
      page('meta[http-equiv="Content-Security-Policy"]').attr("content"),
    ).toContain("default-src 'none'");
    const destination = project("destination");
    const imported = await SessionManager.importStream(
      destination,
      chunks(jsonl, 8191),
    );
    expect(imported.id).not.toBe(source.id);
    expect(imported.getRuntimeState()).toEqual(source.getRuntimeState());
    expect(imported.getEntries()[0].provenance?.entryId).toBe(
      source.getEntries()[0].entryId,
    );
    const entries = imported.getEntries();
    expect(entries[2].message.tool_uses?.[0].tool_use_id).toBe(
      entries[3].message.tool_results?.[0].tool_use_id,
    );
    expect(entries[3].message.tool_results?.[0].artifact).not.toHaveProperty(
      "path",
    );
    expect(imported.getMessages()[2].toolResults?.[0].content).toContain(
      "输出🙂<&>",
    );
    expect(
      SessionManager.open(destination, imported.id).getRuntimeState(),
    ).toEqual(source.getRuntimeState());
    expect(stringExport).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
  });

  it("emits the exact existing JSONL grammar, including surrogate and escape boundaries", async () => {
    const source = small();
    source.append({
      role: "assistant",
      content: `${"x".repeat(8191)}🙂\u0000\n"\\\ud800`,
    });
    const expected = source.export({ scope: "tree", format: "jsonl" });
    expect(
      (
        await collect(source.exportStream({ scope: "tree", format: "jsonl" }))
      ).toString(),
    ).toBe(expected);
    const html = source.export({ scope: "tree", format: "html" });
    expect(
      (
        await collect(source.exportStream({ scope: "tree", format: "html" }))
      ).toString(),
    ).toBe(html);
    const imported = await SessionManager.importStream(
      project("destination"),
      chunks(Buffer.from(expected), 1),
    );
    expect(imported.getMessages()).toEqual(source.getMessages());
  });

  it("bounds small string APIs explicitly rather than truncating", () => {
    const source = large();
    expect(() => source.export({ scope: "tree", format: "jsonl" })).toThrow(
      "string byte limit",
    );
    expect(() => source.export({ scope: "tree", format: "html" })).toThrow(
      "string byte limit",
    );
    expect(() =>
      SessionManager.import(
        project("destination"),
        " ".repeat(MAX_SESSION_STRING_BYTES + 1),
      ),
    ).toThrow("string byte limit");
    expect(files(project("destination"))).toEqual([]);
  });

  it("round-trips large files privately and refuses overwrite, links, relative and traversal paths", async () => {
    const source = large();
    const path = join(project(), "session.jsonl");
    const html = join(project(), "session.html");
    await source.exportFile(path, { scope: "tree", format: "jsonl" });
    await source.exportFile(html, { scope: "tree", format: "html" });
    expect(statSync(path).size).toBeGreaterThan(1024 * 1024);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const imported = await SessionManager.importFile(
      project("destination"),
      path,
    );
    expect(imported.getRuntimeState()).toEqual(source.getRuntimeState());
    const original = readFileSync(path);
    await expect(
      source.exportFile(path, { scope: "tree", format: "jsonl" }),
    ).rejects.toThrow("already exists");
    expect(readFileSync(path)).toEqual(original);
    const symbolic = join(project(), "symbolic");
    const hard = join(project(), "hard");
    symlinkSync(path, symbolic);
    linkSync(path, hard);
    for (const unsafe of [
      symbolic,
      hard,
      "relative.jsonl",
      `${project()}/../project/session.jsonl`,
    ]) {
      await expect(
        SessionManager.importFile(project("bad"), unsafe),
      ).rejects.toThrow(/canonical|unlinked/u);
    }
    const linkedDirectory = join(project(), "linked-directory");
    symlinkSync(project("external"), linkedDirectory, "dir");
    await expect(
      source.exportFile(join(linkedDirectory, "export"), {
        scope: "tree",
        format: "html",
      }),
    ).rejects.toThrow("canonical");
    expect(readdirSync(project("external"))).toEqual([]);
    expect(files(project("bad"))).toEqual([]);
    expect(
      readdirSync(project()).some((name) =>
        name.startsWith(".yukino-transfer-"),
      ),
    ).toBe(false);
  });

  it.each(["schema", "hash", "tools", "tree", "host path", "EOF", "UTF-8"])(
    "rejects %s before atomic publication",
    async (kind) => {
      const source = small();
      const portable = Records.SessionEntrySchema.parse(
        JSON.parse(
          source.export({ scope: "tree", format: "jsonl" }).split("\n")[1],
        ),
      );
      const header = createSessionHeader();
      let bytes: Buffer;
      if (kind === "schema") {
        bytes = Buffer.from(
          `${JSON.stringify(header)}\n{"type":"metadata","revision":1,"metadata":{"unexpected":true}}\n`,
        );
      } else if (kind === "hash") {
        const artifact = {
          ...makeArtifact(Buffer.from("bytes"), "text/plain", 1),
          sha256: "0".repeat(64),
        };
        bytes = Buffer.from(
          `${JSON.stringify(header)}\n${JSON.stringify(artifact)}\n`,
        );
      } else if (kind === "tools") {
        bytes = Buffer.from(
          `${JSON.stringify(header)}\n${JSON.stringify({ ...portable, message: { role: "assistant", content: "", timestamp: 1, tool_uses: [{ tool_use_id: "pending", tool_name: "Read" }] } })}\n${JSON.stringify({ type: "active_leaf", revision: 2, leafId: portable.entryId })}\n`,
        );
      } else if (kind === "tree") {
        bytes = Buffer.from(
          `${JSON.stringify(header)}\n${JSON.stringify({ ...portable, parentId: "missing" })}\n`,
        );
      } else if (kind === "host path") {
        bytes = Buffer.from(
          `${JSON.stringify(header)}\n${JSON.stringify({ ...portable, message: { role: "user", content: "<persisted-output>\nFull content saved to:\n/tmp/forbidden\n</persisted-output>", timestamp: 1 } })}\n${JSON.stringify({ type: "active_leaf", revision: 2, leafId: portable.entryId })}\n`,
        );
      } else if (kind === "EOF") {
        bytes = Buffer.from(
          source.export({ scope: "tree", format: "jsonl" }).slice(0, -1),
        );
      } else {
        bytes = Buffer.concat([
          Buffer.from(`${JSON.stringify(header)}\n{"type":"`),
          Buffer.from([0xc3, 0x28]),
          Buffer.from('"}\n'),
        ]);
      }
      const destination = project("destination");
      const kept = SessionManager.create(destination);
      const before = files(destination);
      await expect(
        SessionManager.importStream(destination, chunks(bytes, 13)),
      ).rejects.toThrow();
      expect(files(destination)).toEqual(before);
      expect(SessionManager.open(destination, kept.id).getEntries()).toEqual(
        [],
      );
    },
  );

  it("checks record and stream byte limits incrementally and accommodates an 8MiB artifact", async () => {
    const document = {
      header: createSessionHeader(),
      records: [
        makeArtifact(
          Buffer.alloc(MAX_ARTIFACT_BYTES),
          "application/octet-stream",
          1,
        ),
      ],
    };
    expect(countSessionDocumentBytes(document)).toBeGreaterThan(
      MAX_ARTIFACT_BYTES,
    );
    const parser = new SessionJsonlParser();
    for (const chunk of sessionJsonlChunks(document)) {
      expect(chunk.length).toBeLessThanOrEqual(SESSION_TRANSPORT_CHUNK_BYTES);
      parser.push(chunk);
    }
    expect(parser.finish().artifacts.size).toBe(1);
    const destination = project("destination");
    async function* oversizedRecord(): AsyncGenerator<Uint8Array> {
      yield Buffer.from(`${JSON.stringify(createSessionHeader())}\n`);
      for (
        let count = 0;
        count <= MAX_SESSION_RECORD_BYTES / SESSION_TRANSPORT_CHUNK_BYTES;
        count++
      ) {
        yield Buffer.alloc(SESSION_TRANSPORT_CHUNK_BYTES, 32);
      }
      await setImmediate();
    }
    await expect(
      SessionManager.importStream(destination, oversizedRecord()),
    ).rejects.toThrow("record byte limit");
    async function* oversizedStream(): AsyncGenerator<Uint8Array> {
      yield Buffer.from(`${JSON.stringify(createSessionHeader())}\n`);
      const content = "x".repeat(4 * 1024 * 1024);
      for (
        let revision = 1;
        revision <= MAX_SESSION_STREAM_BYTES / (4 * 1024 * 1024) + 1;
        revision++
      ) {
        const record: SessionRecord = {
          type: "message",
          revision,
          entryId: `entry-${String(revision)}`,
          parentId: null,
          timestamp: 1,
          message: { role: "user", content, timestamp: 1 },
        };
        yield Buffer.from(`${JSON.stringify(record)}\n`);
      }
      await setImmediate();
    }
    await expect(
      SessionManager.importStream(destination, oversizedStream()),
    ).rejects.toThrow("byte limit");
    expect(files(destination)).toEqual([]);
    const oversized = join(project(), "oversized.jsonl");
    writeFileSync(oversized, "");
    truncateSync(oversized, MAX_SESSION_STREAM_BYTES + 1);
    await expect(
      SessionManager.importFile(destination, oversized),
    ).rejects.toThrow("byte limit");
  });

  it("cancels midway and while a producer is blocked without publishing or leaving temporary files", async () => {
    const source = large();
    const controller = new AbortController();
    const destination = project("destination");
    async function* cancelled(): AsyncGenerator<Uint8Array> {
      for await (const chunk of source.exportStream({
        scope: "tree",
        format: "jsonl",
      })) {
        yield chunk;
        controller.abort();
      }
    }
    await expect(
      SessionManager.importStream(destination, cancelled(), {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/iu);
    expect(files(destination)).toEqual([]);
    const blocked = new AbortController();
    const returned = vi.fn((): Promise<IteratorResult<Uint8Array>> =>
      Promise.resolve({ done: true, value: undefined }),
    );
    const producer: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
        return: returned,
      }),
    };
    const pending = SessionManager.importStream(destination, producer, {
      signal: blocked.signal,
    });
    blocked.abort();
    await expect(pending).rejects.toThrow(/abort/iu);
    expect(returned).toHaveBeenCalledOnce();
    const exporting = new AbortController();
    const path = join(project(), "cancelled.jsonl");
    const original = fs.writeSync;
    vi.spyOn(fs, "writeSync").mockImplementation(
      (...args: Parameters<typeof fs.writeSync>) => {
        exporting.abort();
        return original(...args);
      },
    );
    syncBuiltinESMExports();
    await expect(
      source.exportFile(path, {
        scope: "tree",
        format: "jsonl",
        signal: exporting.signal,
      }),
    ).rejects.toThrow(/abort/iu);
    expect(existsSync(path)).toBe(false);
    expect(
      readdirSync(project()).some((name) =>
        name.startsWith(".yukino-transfer-"),
      ),
    ).toBe(false);
  });

  it("cancels a blocked file export even if iterator cleanup fails", async () => {
    const directory = project();
    const path = join(directory, "blocked.jsonl");
    const controller = new AbortController();
    const reading = Promise.withResolvers<undefined>();
    const close = vi.fn(() => {
      throw new Error("producer cleanup failed");
    });
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          reading.resolve(undefined);
          return new Promise(() => {});
        },
        return: close,
      }),
    };
    const pending = writeSessionExportFile(path, source, {
      signal: controller.signal,
    });
    await reading.promise;
    const reason = new Error("export cancelled");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(close).toHaveBeenCalledOnce();
    expect(readdirSync(directory)).toEqual([]);
  }, 1_000);

  it("rolls back a short transcript write and allows the append to be retried", () => {
    const source = SessionManager.create(project());
    source.append({ role: "user", content: "original" });
    const path = getSessionFilePath(source.cwd, source.id);
    const original = readFileSync(path);
    const transcript = statSync(path);
    const write = fs.writeSync;
    let short = false;
    const stalled = vi.spyOn(fs, "writeSync").mockImplementation((...args) => {
      const [fd] = args;
      const target = fs.fstatSync(fd);
      if (target.dev !== transcript.dev || target.ino !== transcript.ino) {
        return write(...args);
      }
      if (short) {
        return 0;
      }
      short = true;
      return write(fd, "{");
    });
    syncBuiltinESMExports();
    expect(() => source.append({ role: "user", content: "next" })).toThrow(
      "File write made no progress",
    );
    stalled.mockRestore();
    syncBuiltinESMExports();
    expect(readFileSync(path)).toEqual(original);
    source.append({ role: "user", content: "next" });
    expect(
      SessionManager.open(source.cwd, source.id).getEntries(),
    ).toHaveLength(2);
  });

  it("revalidates in-memory and persisted snapshot conflicts and removes failed export temporaries", async () => {
    const source = small();
    const stream = source.exportStream({ scope: "tree", format: "jsonl" });
    await stream.next();
    source.setName("changed");
    await expect(collect(stream)).rejects.toBeInstanceOf(SessionConflictError);
    const persistent = SessionManager.create(project("persistent"));
    persistent.append({ role: "user", content: "initial" });
    const peer = SessionManager.open(persistent.cwd, persistent.id);
    const original = persistent.exportStream.bind(persistent);
    let changed = false;
    vi.spyOn(persistent, "exportStream").mockImplementation((options) => {
      const snapshot = original(options);
      return (async function* () {
        for await (const chunk of snapshot) {
          yield chunk;
          if (!changed) {
            changed = true;
            peer.setName("raced");
          }
        }
      })();
    });
    const path = join(project(), "conflict.jsonl");
    await expect(
      persistent.exportFile(path, { scope: "tree", format: "jsonl" }),
    ).rejects.toBeInstanceOf(SessionConflictError);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(getSessionFilePath(peer.cwd, peer.id))).toBe(true);
    expect(
      readdirSync(project()).some((name) =>
        name.startsWith(".yukino-transfer-"),
      ),
    ).toBe(false);
  });

  it("cancels publication after complete validation and rejects pre-aborted file APIs", async () => {
    const source = small();
    const bytes = Buffer.from(
      source.export({ scope: "tree", format: "jsonl" }),
    );
    const destination = project("destination");
    SessionManager.create(destination);
    const before = files(destination);
    const controller = new AbortController();
    const original = fs.writeSync;
    vi.spyOn(fs, "writeSync").mockImplementation(
      (...args: Parameters<typeof fs.writeSync>) => {
        controller.abort();
        return original(...args);
      },
    );
    syncBuiltinESMExports();
    await expect(
      SessionManager.importStream(destination, chunks(bytes), {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/iu);
    expect(files(destination)).toEqual(before);
    expect(
      files(destination).some((name) => name.endsWith("publish-tmp")),
    ).toBe(false);
    const path = join(project(), "never-created.jsonl");
    await expect(
      source.exportFile(path, {
        scope: "tree",
        format: "jsonl",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/iu);
    await expect(
      SessionManager.importFile(destination, path, {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/iu);
    expect(existsSync(path)).toBe(false);
  });

  it("atomically refuses raced output destinations and detects changed input files", async () => {
    const path = join(project(), "raced.jsonl");
    const source = small();
    const bytes = Buffer.from(
      source.export({ scope: "tree", format: "jsonl" }),
    );
    async function* raced(): AsyncGenerator<Uint8Array> {
      yield bytes;
      writeFileSync(path, "keep raced data");
      await setImmediate();
    }
    await expect(writeSessionExportFile(path, raced())).rejects.toThrow(
      /EEXIST/u,
    );
    expect(readFileSync(path, "utf8")).toBe("keep raced data");
    const input = join(project(), "input.jsonl");
    writeFileSync(input, bytes);
    const reader = sessionImportFileBytes(input);
    await reader.next();
    truncateSync(input, 0);
    await expect(reader.next()).rejects.toThrow("unlinked");
    expect(
      readdirSync(project()).some((name) =>
        name.startsWith(".yukino-transfer-"),
      ),
    ).toBe(false);
  });
});
