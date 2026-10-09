import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync as createTempDir,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, it, expect } from "vitest";

import {
  saveMessage,
  loadSession,
  listSessions,
  newSessionId,
  saveCompactBoundary,
  rebuildFromSession,
  toolUsesToRecords,
  toolResultsToRecords,
  cleanExpiredSessions,
  COMPACT_BOUNDARY,
} from "@/session/index.js";
import { getSessionsDir, sessionPath } from "@/storage/paths.js";
import { asString, contentToText } from "@/utils/index.js";

const t0 = Math.floor(Date.now() / 1000);
const t1 = t0 + 1;
const t2 = t0 + 2;
const t3 = t0 + 3;
const t4 = t0 + 4;
const tempDirs = new Set<string>();

function mkdtempSync(prefix: string): string {
  const directory = createTempDir(prefix);
  tempDirs.add(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("session save/load round-trip", () => {
  it("falls back to the last valid boundary when a later boundary is damaged", () => {
    const restored = rebuildFromSession([
      { role: "user", content: "old task", timestamp: t0 },
      {
        role: "system",
        type: COMPACT_BOUNDARY,
        timestamp: t1,
        content: JSON.stringify({
          summary: "valid summary",
          keep: [
            {
              role: "user",
              content: [
                { type: "text", text: "image task" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "QUJD",
                  },
                },
              ],
            },
          ],
        }),
      },
      { role: "assistant", content: "after boundary", timestamp: t2 },
      {
        role: "system",
        type: COMPACT_BOUNDARY,
        timestamp: t3,
        content: "{broken",
      },
      { role: "user", content: "latest task", timestamp: t4 },
    ]);
    expect(contentToText(restored[0].content)).toContain("valid summary");
    expect(restored[1].content).toEqual([
      { type: "text", text: "image task" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "QUJD" },
      },
    ]);
    expect(restored.slice(2).map((m) => m.content)).toEqual([
      "after boundary",
      "latest task",
    ]);
  });

  it("replays ordinary history if all compaction boundaries are invalid", () => {
    const restored = rebuildFromSession([
      { role: "user", content: "original task", timestamp: t0 },
      { role: "assistant", content: "original answer", timestamp: t1 },
      {
        role: "system",
        type: COMPACT_BOUNDARY,
        content: "not json",
        timestamp: t2,
      },
    ]);
    expect(restored.map((m) => m.content)).toEqual([
      "original task",
      "original answer",
    ]);
  });
  it("persists messages and loads them back in order", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();

    saveMessage(cwd, id, {
      role: "user",
      content: "first",
      timestamp: t0,
    });
    saveMessage(cwd, id, {
      role: "assistant",
      content: "reply",
      timestamp: t1,
    });

    const loaded = loadSession(cwd, id);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({ role: "user", content: "first" });
    expect(loaded[1]).toMatchObject({ role: "assistant", content: "reply" });
  });

  it("round-trips the provider item ID for native computer calls", () => {
    const toolUses = toolUsesToRecords([
      {
        toolUseId: "call_1",
        providerItemId: "item_1",
        toolName: "ComputerUse",
        arguments: { actions: [{ type: "screenshot" }], status: "completed" },
      },
    ]);

    expect(toolUses[0]?.provider_item_id).toBe("item_1");
    const restored = rebuildFromSession([
      { role: "assistant", content: "", timestamp: t0, tool_uses: toolUses },
    ]);
    expect(restored[0]?.toolUses?.[0]).toMatchObject({
      toolUseId: "call_1",
      providerItemId: "item_1",
      toolName: "ComputerUse",
    });
  });

  it("skips malformed and empty-content lines instead of crashing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = "broken";
    const dir = join(getSessionsDir(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [
        JSON.stringify({ role: "user", content: "ok", timestamp: t0 }),
        "{ not valid json",
        JSON.stringify({ role: "assistant", content: "", timestamp: t0 }),
        JSON.stringify({ role: "assistant", content: "good", timestamp: t0 }),
      ].join("\n") + "\n",
    );

    const loaded = loadSession(cwd, id);
    expect(loaded.map((m) => m.content)).toEqual(["ok", "good"]);
  });

  it("round-trips a user message with inline image blocks", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();
    const data = Buffer.from("user-attached-image").toString("base64");

    saveMessage(cwd, id, {
      role: "user",
      content: [
        { type: "text", text: "look at @shot.png" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data },
        },
      ],
      timestamp: t0,
    });

    // The JSONL stores the base64 payload inline.
    const raw = readFileSync(join(getSessionsDir(cwd), `${id}.jsonl`), "utf-8");
    expect(raw).toContain(data);

    const restored = rebuildFromSession(loadSession(cwd, id));
    expect(restored).toHaveLength(1);
    const content = restored[0].content;
    if (typeof content === "string") {
      throw new Error("expected content blocks");
    }
    expect(content[0]).toEqual({ type: "text", text: "look at @shot.png" });
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data },
    });
  });

  it("round-trips split tool-result text and rich blocks", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();
    const data = Buffer.from("tool-image").toString("base64");

    saveMessage(cwd, id, {
      role: "user",
      content: "",
      timestamp: t0,
      tool_results: toolResultsToRecords([
        {
          toolUseId: "tool-1",
          content: "screenshot\n[Image: image/png]",
          contentBlocks: [
            { type: "text", text: "screenshot" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data },
            },
          ],
          isError: false,
        },
      ]),
    });

    const raw = readFileSync(join(getSessionsDir(cwd), `${id}.jsonl`), "utf-8");
    expect(raw).toContain('"content_blocks"');
    const restored = rebuildFromSession(loadSession(cwd, id));
    expect(restored[0]?.toolResults?.[0]).toEqual({
      toolUseId: "tool-1",
      content: "screenshot\n[Image: image/png]",
      contentBlocks: [
        { type: "text", text: "screenshot" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data },
        },
      ],
      isError: false,
    });
  });

  it("migrates legacy array tool-result content while loading", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = "legacy-tool-blocks";
    const dir = join(getSessionsDir(cwd));
    mkdirSync(dir, { recursive: true });
    const blocks = [
      { type: "text", text: "legacy screenshot" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "QUJD" },
      },
      { type: "tool_reference", tool_name: "mcp__legacy__tool" },
      { type: "thinking", thinking: "must not enter tool_result content" },
    ];
    writeFileSync(
      join(dir, `${id}.jsonl`),
      JSON.stringify({
        role: "user",
        content: "",
        timestamp: t0,
        tool_results: [{ tool_use_id: "legacy-1", content: blocks }],
      }) + "\n",
      "utf-8",
    );

    const restored = rebuildFromSession(loadSession(cwd, id));
    expect(restored[0]?.toolResults?.[0]?.content).toBe(
      "legacy screenshot\n[Image: image/png]\n[Tool reference: mcp__legacy__tool]",
    );
    expect(restored[0]?.toolResults?.[0]?.contentBlocks).toEqual(
      blocks.slice(0, 3),
    );
  });

  it("labels a session by its first user message", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();
    // First persisted line is a system message; the label should skip to user.
    saveMessage(cwd, id, {
      role: "system",
      content: "boot",
      timestamp: t0,
    });
    saveMessage(cwd, id, {
      role: "user",
      content: "the real question",
      timestamp: t1,
    });

    const info = listSessions(cwd).find((s) => s.id === id);
    expect(info?.firstMessage).toBe("the real question");
    expect(info?.messageCount).toBe(2);
  });
});

describe("rebuildFromSession (compacted-state resume)", () => {
  it("rebuilds the compacted state from the last compact_boundary", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();

    // Original pre-boundary history that compaction summarized away. These must
    // NOT be replayed on resume — only the summary stands in for them.
    saveMessage(cwd, id, {
      role: "user",
      content: "ORIGINAL-Q-1 must-not-replay",
      timestamp: t0,
    });
    saveMessage(cwd, id, {
      role: "assistant",
      content: "ORIGINAL-A-1 must-not-replay",
      timestamp: t1,
    });
    saveMessage(cwd, id, {
      role: "user",
      content: "ORIGINAL-Q-2 must-not-replay",
      timestamp: t2,
    });

    // The boundary: summary + the verbatim kept tail inlined as role+text.
    saveCompactBoundary(cwd, id, {
      summary: "SUMMARY of the old prefix",
      keep: [
        { role: "user", content: "KEPT-Q recent" },
        { role: "assistant", content: "KEPT-A recent" },
      ],
    });

    // Continuation turns appended AFTER the boundary (e.g. after a prior resume).
    saveMessage(cwd, id, {
      role: "user",
      content: "POST-BOUNDARY-Q new",
      timestamp: t3,
    });
    saveMessage(cwd, id, {
      role: "assistant",
      content: "POST-BOUNDARY-A new",
      timestamp: t4,
    });

    const saved = loadSession(cwd, id);
    const rebuilt = rebuildFromSession(saved);
    const joined = rebuilt
      .map((m) => `${m.role}:${contentToText(m.content)}`)
      .join("\n");

    // Summary is present with the English framing wrapper, replayed as a synthetic user message.
    expect(rebuilt[0].role).toBe("user");
    expect(rebuilt[0].content).toContain(
      "The conversation history before this point was compacted",
    );
    expect(rebuilt[0].content).toContain("SUMMARY of the old prefix");
    expect(rebuilt[0].content).toContain(
      "Recent messages have been preserved verbatim",
    );
    expect(rebuilt[1]).toEqual({ role: "user", content: "KEPT-Q recent" });
    expect(rebuilt[2]).toEqual({ role: "assistant", content: "KEPT-A recent" });
    expect(joined).toContain("user:POST-BOUNDARY-Q new");
    expect(joined).toContain("assistant:POST-BOUNDARY-A new");
    expect(joined).not.toContain("must-not-replay");
    // Exactly: summary + 2 kept + 2 post-boundary.
    expect(rebuilt).toHaveLength(5);
  });

  it("preserves rich tool results inside compact boundaries", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();
    saveCompactBoundary(cwd, id, {
      summary: "summary",
      keep: [
        {
          role: "user",
          content: "",
          tool_results: toolResultsToRecords([
            {
              toolUseId: "tool-image",
              content: "[Image: image/png]",
              contentBlocks: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "QUJD",
                  },
                },
              ],
              isError: false,
            },
          ]),
        },
      ],
    });

    const rebuilt = rebuildFromSession(loadSession(cwd, id));
    expect(rebuilt[1]?.toolResults?.[0]?.contentBlocks).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "QUJD" },
      },
    ]);
  });

  it("uses only the LAST boundary when a session was compacted twice (chaining)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();

    saveMessage(cwd, id, {
      role: "user",
      content: "VERY-OLD must-not-replay",
      timestamp: t0,
    });
    // First boundary (superseded by the second).
    saveCompactBoundary(cwd, id, {
      summary: "FIRST-SUMMARY must-not-replay",
      keep: [{ role: "user", content: "FIRST-KEEP must-not-replay" }],
    });
    saveMessage(cwd, id, {
      role: "assistant",
      content: "MID must-not-replay",
      timestamp: t1,
    });
    // Second (latest) boundary — the one resume should use.
    saveCompactBoundary(cwd, id, {
      summary: "SECOND-SUMMARY",
      keep: [{ role: "assistant", content: "SECOND-KEEP recent" }],
    });
    saveMessage(cwd, id, {
      role: "user",
      content: "AFTER-SECOND new",
      timestamp: t2,
    });

    const rebuilt = rebuildFromSession(loadSession(cwd, id));
    const joined = rebuilt
      .map((m) => `${m.role}:${contentToText(m.content)}`)
      .join("\n");

    expect(joined).toContain("SECOND-SUMMARY");
    expect(joined).toContain("SECOND-KEEP recent");
    expect(joined).toContain("AFTER-SECOND new");
    expect(joined).not.toContain("must-not-replay");
    expect(rebuilt).toHaveLength(3); // summary + 1 kept + 1 post-boundary
  });

  it("full-replays an old session with no boundary (backward compatible)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();

    saveMessage(cwd, id, { role: "user", content: "q1", timestamp: t0 });
    saveMessage(cwd, id, {
      role: "assistant",
      content: "a1",
      timestamp: t1,
    });
    saveMessage(cwd, id, { role: "user", content: "q2", timestamp: t2 });

    const rebuilt = rebuildFromSession(loadSession(cwd, id));
    expect(rebuilt).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
  });

  it("persists the boundary as a COMPACT_BOUNDARY-typed record on disk", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();
    saveCompactBoundary(cwd, id, { summary: "s", keep: [] });

    const saved = loadSession(cwd, id);
    expect(saved).toHaveLength(1);
    expect(saved[0].type).toBe(COMPACT_BOUNDARY);
    expect(JSON.parse(asString(saved[0].content) || "{}")).toEqual({
      summary: "s",
      keep: [],
    });
  });
});

describe("cleanExpiredSessions", () => {
  it("removes expired .jsonl files together with their tool-results subdirectory", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const expiredId = "expired-session";
    const freshId = "fresh-session";
    const sessionsRoot = join(getSessionsDir(cwd));

    saveMessage(cwd, expiredId, {
      role: "user",
      content: "old",
      timestamp: t0,
    });
    saveMessage(cwd, freshId, {
      role: "user",
      content: "new",
      timestamp: t0,
    });

    // Spill files under the real (hyphenated) directory name used by
    // spillDir() — the cleanup must delete these, not a "tool_results" path.
    const expiredSpill = sessionPath(expiredId, "tool-results");
    const freshSpill = sessionPath(freshId, "tool-results");
    mkdirSync(expiredSpill, { recursive: true });
    mkdirSync(freshSpill, { recursive: true });
    writeFileSync(join(expiredSpill, "toolu_old.txt"), "spilled", "utf-8");
    writeFileSync(join(freshSpill, "toolu_new.txt"), "spilled", "utf-8");

    // Age the expired session beyond SESSION_EXPIRY_DAYS (30 days).
    const aged = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(join(sessionsRoot, `${expiredId}.jsonl`), aged, aged);

    expect(cleanExpiredSessions(cwd)).toBe(1);
    expect(existsSync(join(sessionsRoot, `${expiredId}.jsonl`))).toBe(false);
    expect(existsSync(sessionPath(expiredId))).toBe(false);
    expect(existsSync(join(sessionsRoot, `${freshId}.jsonl`))).toBe(true);
    expect(existsSync(join(freshSpill, "toolu_new.txt"))).toBe(true);
  });

  it("returns 0 when the sessions directory does not exist", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    expect(cleanExpiredSessions(cwd)).toBe(0);
  });

  it("keeps an expired session that was just loaded for resume", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const sessionId = "resumed-session";
    const filePath = join(getSessionsDir(cwd), `${sessionId}.jsonl`);
    saveMessage(cwd, sessionId, {
      role: "user",
      content: "resume me",
      timestamp: t0,
    });
    const aged = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(filePath, aged, aged);

    expect(loadSession(cwd, sessionId)).toHaveLength(1);
    expect(cleanExpiredSessions(cwd)).toBe(0);
    expect(existsSync(filePath)).toBe(true);
  });

  it("rechecks expiry after waiting for a concurrent resume", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const sessionId = "concurrently-resumed";
    const filePath = join(getSessionsDir(cwd), `${sessionId}.jsonl`);
    const lockPath = `${filePath}.lock`;
    saveMessage(cwd, sessionId, {
      role: "user",
      content: "resume me concurrently",
      timestamp: t0,
    });
    const aged = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(filePath, aged, aged);

    const script = [
      'const fs = require("node:fs");',
      `const filePath = ${JSON.stringify(filePath)};`,
      `const lockPath = ${JSON.stringify(lockPath)};`,
      "fs.mkdirSync(lockPath);",
      "const ticket = `${lockPath}/ticket-0000000000000001-${process.pid}-resume`;",
      'fs.writeFileSync(ticket, String(process.pid), { flag: "wx" });',
      'process.stdout.write("ready\\n");',
      "setTimeout(() => {",
      "  const now = new Date();",
      "  fs.utimesSync(filePath, now, now);",
      "  fs.unlinkSync(ticket);",
      "  try { fs.rmdirSync(lockPath); } catch {}",
      "}, 100);",
    ].join("\n");
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`resume helper exited ${String(code)}`));
        }
      });
    });
    await new Promise<void>((resolveReady, rejectReady) => {
      child.once("error", rejectReady);
      child.stdout.once("data", () => {
        resolveReady();
      });
    });

    expect(cleanExpiredSessions(cwd)).toBe(0);
    await closed;
    expect(existsSync(filePath)).toBe(true);
  });

  it("sweeps expired sessions lazily on the first listSessions call", () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const expiredId = "expired-listed";
    const freshId = "fresh-listed";
    const sessionsRoot = join(getSessionsDir(cwd));

    saveMessage(cwd, expiredId, {
      role: "user",
      content: "old",
      timestamp: t0,
    });
    saveMessage(cwd, freshId, {
      role: "user",
      content: "new",
      timestamp: t0,
    });
    const expiredSpill = sessionPath(expiredId, "tool-results");
    mkdirSync(expiredSpill, { recursive: true });
    writeFileSync(join(expiredSpill, "toolu_x.txt"), "spilled", "utf-8");

    const aged = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(join(sessionsRoot, `${expiredId}.jsonl`), aged, aged);

    // The expired session is removed before the listing is built, so it
    // never shows up in the resume picker.
    const listed = listSessions(cwd);
    expect(listed.map((s) => s.id)).toEqual([freshId]);
    expect(existsSync(join(sessionsRoot, `${expiredId}.jsonl`))).toBe(false);
    expect(existsSync(sessionPath(expiredId))).toBe(false);
  });
});
