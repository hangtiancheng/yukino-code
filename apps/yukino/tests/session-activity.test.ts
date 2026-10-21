import {
  mkdirSync,
  realpathSync,
  statSync,
  utimesSync,
  appendFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { recordInput, registerProject } from "@/history/index.js";
import {
  getSessionFilePath,
  listAllSessions,
  listSessions,
  loadSession,
  loadSessionForResume,
  saveCompactBoundary,
  saveMessage,
  saveUserMessage,
  truncateSessionLines,
} from "@/session/index.js";
import { getYukinoDir } from "@/storage/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function project(name: string): string {
  const cwd = join(dirname(getYukinoDir()), name);
  mkdirSync(cwd, { recursive: true });
  return realpathSync(cwd);
}

function submit(cwd: string, id: string, text: string, time: number): void {
  const input = recordInput({ cwd, sessionId: id, source: "cli", text });
  saveUserMessage(cwd, id, { ...input, timestamp: time }, { content: text });
}

describe("session activity ordering", () => {
  it("rejects input associated with a different project or session", () => {
    const cwd = project("one");
    const input = recordInput({
      cwd,
      sessionId: "original",
      source: "cli",
      text: "hello",
    });
    expect(() =>
      saveUserMessage(cwd, "other", input, { content: "hello" }),
    ).toThrow("User input does not belong");
    expect(() =>
      saveUserMessage(project("two"), "original", input, { content: "hello" }),
    ).toThrow("User input does not belong");
  });

  it("uses the latest submission time even when persistence arrives out of order", () => {
    const cwd = project("one");
    submit(cwd, "one", "newer", 2000);
    submit(cwd, "one", "delayed delivery", 1000);
    expect(listSessions(cwd)[0].lastUserMessageTime?.getTime()).toBe(2000);
  });

  it("orders by real user input across projects despite newer assistant and internal messages", () => {
    const first = project("one");
    const second = project("two");
    submit(first, "same-id", "older", 1000);
    submit(second, "same-id", "newer", 2000);
    saveMessage(first, "same-id", {
      role: "assistant",
      content: "reply",
      timestamp: 5000,
    });
    saveMessage(first, "same-id", {
      role: "user",
      content: "<system-reminder>automatic</system-reminder>",
      timestamp: 6000,
    });
    saveMessage(first, "same-id", {
      role: "user",
      content: "",
      timestamp: 7000,
      tool_results: [{ tool_use_id: "tool", content: "result" }],
    });
    saveCompactBoundary(first, "same-id", { summary: "summary", keep: [] });
    expect(
      listAllSessions().map((entry) => [
        entry.cwd,
        entry.id,
        entry.lastUserMessageTime?.getTime(),
      ]),
    ).toEqual([
      [second, "same-id", 2000],
      [first, "same-id", 1000],
    ]);
  });

  it("keeps ordering stable across a pure read and explicit resume while renewing expiry", () => {
    const cwd = project("one");
    submit(cwd, "older", "older", 1000);
    submit(cwd, "newer", "newer", 2000);
    const path = getSessionFilePath(cwd, "older");
    const aged = new Date(Date.now() - 100_000);
    utimesSync(path, aged, aged);
    const before = statSync(path).mtimeMs;
    loadSession(cwd, "older");
    expect(statSync(path).mtimeMs).toBe(before);
    loadSessionForResume(cwd, "older");
    expect(statSync(path).mtimeMs).toBeGreaterThan(before);
    expect(listSessions(cwd).map((entry) => entry.id)).toEqual([
      "newer",
      "older",
    ]);
    submit(cwd, "older", "another question", 3000);
    expect(listSessions(cwd).map((entry) => entry.id)).toEqual([
      "older",
      "newer",
    ]);
  });

  it("uses remaining user messages after conversation rewind", () => {
    const cwd = project("one");
    submit(cwd, "rewound", "first", 1000);
    submit(cwd, "other", "other", 2000);
    submit(cwd, "rewound", "removed", 3000);
    expect(listSessions(cwd)[0].id).toBe("rewound");
    truncateSessionLines(getSessionFilePath(cwd, "rewound"), 1);
    expect(listSessions(cwd).map((entry) => entry.id)).toEqual([
      "other",
      "rewound",
    ]);
    expect(listSessions(cwd)[1].lastUserMessageTime?.getTime()).toBe(1000);
  });

  it("ignores canceled input and control commands, and keeps sessions without user input last", () => {
    const cwd = project("one");
    submit(cwd, "spoken", "real", 1000);
    saveMessage(cwd, "internal", {
      role: "user",
      content: "automatic",
      timestamp: 10000,
    });
    recordInput({
      cwd,
      sessionId: "internal",
      source: "cli",
      text: "canceled steering",
    });
    recordInput({
      cwd,
      sessionId: "internal",
      source: "cli",
      text: "/resume",
      commandName: "resume",
    });
    expect(
      listSessions(cwd).map((entry) => [
        entry.id,
        entry.lastUserMessageTime?.getTime() ?? null,
      ]),
    ).toEqual([
      ["spoken", 1000],
      ["internal", null],
    ]);
  });

  it("isolates missing projects, corrupt transcripts and orphaned hashes", () => {
    const cwd = project("one");
    registerProject(join(cwd, "missing"));
    submit(cwd, "valid", "real", 1000);
    appendFileSync(getSessionFilePath(cwd, "valid"), "corrupt line\n");
    expect(listAllSessions().map((entry) => entry.id)).toEqual(["valid"]);
  });
});
