/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

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
import { asString, contentToText } from "@/utils/index.js";

const t0 = Math.floor(Date.now() / 1000);
const t1 = t0 + 1;
const t2 = t0 + 2;
const t3 = t0 + 3;
const t4 = t0 + 4;

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
    const workDir = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();

    saveMessage(workDir, id, {
      role: "user",
      content: "first",
      timestamp: t0,
    });
    saveMessage(workDir, id, {
      role: "assistant",
      content: "reply",
      timestamp: t1,
    });

    const loaded = loadSession(workDir, id);
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
    const workDir = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = "broken";
    const dir = join(workDir, ".yukino", "sessions");
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

    const loaded = loadSession(workDir, id);
    expect(loaded.map((m) => m.content)).toEqual(["ok", "good"]);
  });

  it("round-trips a user message with inline image blocks", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();
    const data = Buffer.from("user-attached-image").toString("base64");

    saveMessage(workDir, id, {
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
    const raw = readFileSync(
      join(workDir, ".yukino", "sessions", `${id}.jsonl`),
      "utf-8",
    );
    expect(raw).toContain(data);

    // Resume restores the inline image block byte-identically.
    const restored = rebuildFromSession(loadSession(workDir, id));
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
    const workDir = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();
    const data = Buffer.from("tool-image").toString("base64");

    saveMessage(workDir, id, {
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

    const raw = readFileSync(
      join(workDir, ".yukino", "sessions", `${id}.jsonl`),
      "utf-8",
    );
    expect(raw).toContain('"content_blocks"');
    const restored = rebuildFromSession(loadSession(workDir, id));
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
    const workDir = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = "legacy-tool-blocks";
    const dir = join(workDir, ".yukino", "sessions");
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

    const restored = rebuildFromSession(loadSession(workDir, id));
    expect(restored[0]?.toolResults?.[0]?.content).toBe(
      "legacy screenshot\n[Image: image/png]\n[Tool reference: mcp__legacy__tool]",
    );
    expect(restored[0]?.toolResults?.[0]?.contentBlocks).toEqual(
      blocks.slice(0, 3),
    );
  });

  it("labels a session by its first user message", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();
    // First persisted line is a system message; the label should skip to user.
    saveMessage(workDir, id, {
      role: "system",
      content: "boot",
      timestamp: t0,
    });
    saveMessage(workDir, id, {
      role: "user",
      content: "the real question",
      timestamp: t1,
    });

    const info = listSessions(workDir).find((s) => s.id === id);
    expect(info?.firstMessage).toBe("the real question");
    expect(info?.messageCount).toBe(2);
  });
});

describe("rebuildFromSession (compacted-state resume)", () => {
  it("rebuilds the compacted state from the last compact_boundary", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();

    // Original pre-boundary history that compaction summarized away. These must
    // NOT be replayed on resume — only the summary stands in for them.
    saveMessage(workDir, id, {
      role: "user",
      content: "ORIGINAL-Q-1 must-not-replay",
      timestamp: t0,
    });
    saveMessage(workDir, id, {
      role: "assistant",
      content: "ORIGINAL-A-1 must-not-replay",
      timestamp: t1,
    });
    saveMessage(workDir, id, {
      role: "user",
      content: "ORIGINAL-Q-2 must-not-replay",
      timestamp: t2,
    });

    // The boundary: summary + the verbatim kept tail inlined as role+text.
    saveCompactBoundary(workDir, id, {
      summary: "SUMMARY of the old prefix",
      keep: [
        { role: "user", content: "KEPT-Q recent" },
        { role: "assistant", content: "KEPT-A recent" },
      ],
    });

    // Continuation turns appended AFTER the boundary (e.g. after a prior resume).
    saveMessage(workDir, id, {
      role: "user",
      content: "POST-BOUNDARY-Q new",
      timestamp: t3,
    });
    saveMessage(workDir, id, {
      role: "assistant",
      content: "POST-BOUNDARY-A new",
      timestamp: t4,
    });

    const saved = loadSession(workDir, id);
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
    // Kept tail (original text) is replayed verbatim, in order, with roles.
    expect(rebuilt[1]).toEqual({ role: "user", content: "KEPT-Q recent" });
    expect(rebuilt[2]).toEqual({ role: "assistant", content: "KEPT-A recent" });
    // Post-boundary continuation messages are replayed.
    expect(joined).toContain("user:POST-BOUNDARY-Q new");
    expect(joined).toContain("assistant:POST-BOUNDARY-A new");
    // Pre-boundary originals are NOT replayed (the summary replaces them).
    expect(joined).not.toContain("must-not-replay");
    // Exactly: summary + 2 kept + 2 post-boundary.
    expect(rebuilt).toHaveLength(5);
  });

  it("preserves rich tool results inside compact boundaries", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();
    saveCompactBoundary(workDir, id, {
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

    const rebuilt = rebuildFromSession(loadSession(workDir, id));
    expect(rebuilt[1]?.toolResults?.[0]?.contentBlocks).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "QUJD" },
      },
    ]);
  });

  it("uses only the LAST boundary when a session was compacted twice (chaining)", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();

    saveMessage(workDir, id, {
      role: "user",
      content: "VERY-OLD must-not-replay",
      timestamp: t0,
    });
    // First boundary (superseded by the second).
    saveCompactBoundary(workDir, id, {
      summary: "FIRST-SUMMARY must-not-replay",
      keep: [{ role: "user", content: "FIRST-KEEP must-not-replay" }],
    });
    saveMessage(workDir, id, {
      role: "assistant",
      content: "MID must-not-replay",
      timestamp: t1,
    });
    // Second (latest) boundary — the one resume should use.
    saveCompactBoundary(workDir, id, {
      summary: "SECOND-SUMMARY",
      keep: [{ role: "assistant", content: "SECOND-KEEP recent" }],
    });
    saveMessage(workDir, id, {
      role: "user",
      content: "AFTER-SECOND new",
      timestamp: t2,
    });

    const rebuilt = rebuildFromSession(loadSession(workDir, id));
    const joined = rebuilt
      .map((m) => `${m.role}:${contentToText(m.content)}`)
      .join("\n");

    expect(joined).toContain("SECOND-SUMMARY");
    expect(joined).toContain("SECOND-KEEP recent");
    expect(joined).toContain("AFTER-SECOND new");
    // Nothing from before the last boundary leaks in.
    expect(joined).not.toContain("must-not-replay");
    expect(rebuilt).toHaveLength(3); // summary + 1 kept + 1 post-boundary
  });

  it("full-replays an old session with no boundary (backward compatible)", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();

    saveMessage(workDir, id, { role: "user", content: "q1", timestamp: t0 });
    saveMessage(workDir, id, {
      role: "assistant",
      content: "a1",
      timestamp: t1,
    });
    saveMessage(workDir, id, { role: "user", content: "q2", timestamp: t2 });

    const rebuilt = rebuildFromSession(loadSession(workDir, id));
    expect(rebuilt).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
  });

  it("persists the boundary as a COMPACT_BOUNDARY-typed record on disk", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const id = newSessionId();
    saveCompactBoundary(workDir, id, { summary: "s", keep: [] });

    const saved = loadSession(workDir, id);
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
    const workDir = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const expiredId = "expired-session";
    const freshId = "fresh-session";
    const sessionsRoot = join(workDir, ".yukino", "sessions");

    saveMessage(workDir, expiredId, {
      role: "user",
      content: "old",
      timestamp: t0,
    });
    saveMessage(workDir, freshId, {
      role: "user",
      content: "new",
      timestamp: t0,
    });

    // Spill files under the real (hyphenated) directory name used by
    // spillDir() — the cleanup must delete these, not a "tool_results" path.
    const expiredSpill = join(sessionsRoot, expiredId, "tool-results");
    const freshSpill = join(sessionsRoot, freshId, "tool-results");
    mkdirSync(expiredSpill, { recursive: true });
    mkdirSync(freshSpill, { recursive: true });
    writeFileSync(join(expiredSpill, "toolu_old.txt"), "spilled", "utf-8");
    writeFileSync(join(freshSpill, "toolu_new.txt"), "spilled", "utf-8");

    // Age the expired session beyond SESSION_EXPIRY_DAYS (30 days).
    const aged = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(join(sessionsRoot, `${expiredId}.jsonl`), aged, aged);

    expect(cleanExpiredSessions(workDir)).toBe(1);
    expect(existsSync(join(sessionsRoot, `${expiredId}.jsonl`))).toBe(false);
    expect(existsSync(join(sessionsRoot, expiredId))).toBe(false);
    // The fresh session and its spill files are untouched.
    expect(existsSync(join(sessionsRoot, `${freshId}.jsonl`))).toBe(true);
    expect(existsSync(join(freshSpill, "toolu_new.txt"))).toBe(true);
  });

  it("returns 0 when the sessions directory does not exist", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    expect(cleanExpiredSessions(workDir)).toBe(0);
  });

  it("sweeps expired sessions lazily on the first listSessions call", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-sess-"));
    const expiredId = "expired-listed";
    const freshId = "fresh-listed";
    const sessionsRoot = join(workDir, ".yukino", "sessions");

    saveMessage(workDir, expiredId, {
      role: "user",
      content: "old",
      timestamp: t0,
    });
    saveMessage(workDir, freshId, {
      role: "user",
      content: "new",
      timestamp: t0,
    });
    const expiredSpill = join(sessionsRoot, expiredId, "tool-results");
    mkdirSync(expiredSpill, { recursive: true });
    writeFileSync(join(expiredSpill, "toolu_x.txt"), "spilled", "utf-8");

    const aged = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(join(sessionsRoot, `${expiredId}.jsonl`), aged, aged);

    // The expired session is removed before the listing is built, so it
    // never shows up in the resume picker.
    const listed = listSessions(workDir);
    expect(listed.map((s) => s.id)).toEqual([freshId]);
    expect(existsSync(join(sessionsRoot, `${expiredId}.jsonl`))).toBe(false);
    expect(existsSync(join(sessionsRoot, expiredId))).toBe(false);
  });
});
