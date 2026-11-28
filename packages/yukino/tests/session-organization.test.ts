import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseSessionTreeCommand,
  sessionTreeRows,
  updateSessionTreeOptions,
} from "@/session/actions.js";
import {
  MAX_SESSION_SEARCH_CHARS,
  MAX_SESSION_SEARCH_TERMS,
  SESSION_NAME_MAX_GRAPHEMES,
  COMPACT_BOUNDARY,
} from "@/session/constants.js";
import {
  applySessionNameSuggestion,
  filterSessions,
  listAllSessions,
  previewSessionNameSuggestion,
  sessionPickerRows,
  setSessionTags,
} from "@/session/index.js";
import { SessionManager } from "@/session/manager.js";
import { getYukinoDir } from "@/storage/index.js";

function project(name = "organization"): string {
  const cwd = join(dirname(getYukinoDir()), name);
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

function user(manager: SessionManager, content: string): string {
  return manager.append({
    role: "user",
    content,
    timestamp: 1,
    user_input: { id: randomUUID(), timestamp: 1000 },
  });
}

function branches() {
  const manager = SessionManager.create(project(), { persist: false });
  const root = user(manager, "shared task");
  const shared = manager.append({
    role: "assistant",
    content: "shared answer",
  });
  const a = user(manager, "inactive task");
  const aAnswer = manager.append({
    role: "assistant",
    content: "inactive needle answer",
  });
  manager.setLabel(aAnswer, "review-ready");
  manager.selectActiveLeaf(shared);
  const b = user(manager, "current task");
  const bAnswer = manager.append({
    role: "assistant",
    content: "current answer",
  });
  return { manager, root, shared, a, aAnswer, b, bAnswer };
}

afterEach(() => vi.restoreAllMocks());

describe("shared tree organization", () => {
  it("parses explicit display, navigation, labels and folding without consuming search as an action", () => {
    expect(parseSessionTreeCommand("")).toEqual({ action: "show", text: "" });
    expect(
      parseSessionTreeCommand("show --labeled-only role:user task"),
    ).toEqual({
      action: "show",
      text: "role:user task",
      options: { labeledOnly: true },
    });
    expect(
      parseSessionTreeCommand("--all-labels task --summary focus on tests"),
    ).toEqual({
      action: "show",
      text: "task",
      options: { labeledOnly: false },
      summary: "focus on tests",
    });
    expect(parseSessionTreeCommand("go entry --summary")).toEqual({
      action: "go",
      entryId: "entry",
      text: "",
      summary: "",
    });
    expect(parseSessionTreeCommand("label entry new label")).toEqual({
      action: "label",
      entryId: "entry",
      text: "new label",
    });
    expect(parseSessionTreeCommand("fold entry")).toEqual({
      action: "fold",
      entryId: "entry",
      text: "",
    });
    expect(parseSessionTreeCommand("unfold --all")).toEqual({
      action: "unfold",
      all: true,
      text: "",
    });
    expect(parseSessionTreeCommand("-- --literal")).toEqual({
      action: "show",
      text: "--literal",
    });
  });

  it.each([
    "go",
    "go --summary",
    "go entry extra",
    "fold",
    "fold entry extra",
    "unfold --unknown",
    "label",
    "--unknown",
    "--labeled-only --all-labels",
    "role:tool",
    "role:",
  ])("rejects ambiguous or malformed syntax: %s", (args) => {
    expect(() => parseSessionTreeCommand(args)).toThrow();
  });

  it("bounds query text and terms in both parser and shared rows", () => {
    const { manager } = branches();
    for (const query of [
      "界".repeat(MAX_SESSION_SEARCH_CHARS + 1),
      Array.from({ length: MAX_SESSION_SEARCH_TERMS + 1 }, () => "x").join(" "),
    ]) {
      expect(() => parseSessionTreeCommand(query)).toThrow();
      expect(() =>
        sessionTreeRows(manager.getTree(), manager.leafId, query),
      ).toThrow();
      expect(() => filterSessions([], { cwd: manager.cwd, query })).toThrow();
    }
  });

  it("accepts incomplete interactive role filters without throwing while users type", () => {
    const { manager } = branches();
    expect(() =>
      sessionTreeRows(manager.getTree(), manager.leafId, "role:u"),
    ).not.toThrow();
    expect(sessionTreeRows(manager.getTree(), manager.leafId, "role:")).toEqual(
      [],
    );
  });

  it("folds inactive descendants while retaining the entire current branch path", () => {
    const { manager, root, shared, a, aAnswer, b, bAnswer } = branches();
    const tree = manager.getTree();
    const revision = manager.revision;
    const options = updateSessionTreeOptions(
      tree,
      {},
      parseSessionTreeCommand(`fold ${root}`),
    );
    expect(
      sessionTreeRows(tree, bAnswer, "", options).map((row) => row.id),
    ).toEqual([root, shared, b, bAnswer]);
    expect(sessionTreeRows(tree, bAnswer, "", options)[0]).toMatchObject({
      onCurrentPath: true,
      folded: true,
      hasChildren: true,
      current: false,
    });
    expect(sessionTreeRows(tree, bAnswer, "", options).at(-1)?.current).toBe(
      true,
    );
    expect(
      sessionTreeRows(tree, bAnswer, "", { foldedEntryIds: [a] }).map(
        (row) => row.id,
      ),
    ).toEqual([root, shared, a, b, bAnswer]);
    expect(
      sessionTreeRows(tree, bAnswer, "role:assistant needle", options).map(
        (row) => row.id,
      ),
    ).toEqual([aAnswer]);
    expect(manager.revision).toBe(revision);
    expect(tree).toEqual(manager.getTree());
  });

  it("unfolds specific branches or all, and keeps labeled descendants reachable through unlabeled ancestors", () => {
    const { manager, root, shared, a, aAnswer, b, bAnswer } = branches();
    const tree = manager.getTree();
    const folded = updateSessionTreeOptions(
      tree,
      {},
      parseSessionTreeCommand("fold --all"),
    );
    expect(folded.foldedEntryIds).toContain(a);
    const unfolded = updateSessionTreeOptions(
      tree,
      folded,
      parseSessionTreeCommand("unfold --all"),
    );
    expect(unfolded.foldedEntryIds).toEqual([]);
    const labeled = updateSessionTreeOptions(
      tree,
      unfolded,
      parseSessionTreeCommand("--labeled-only"),
    );
    expect(
      sessionTreeRows(tree, bAnswer, "", labeled).map((row) => row.id),
    ).toEqual([root, shared, aAnswer, b, bAnswer]);
    expect(
      sessionTreeRows(tree, bAnswer, "role:assistant review", labeled).map(
        (row) => row.id,
      ),
    ).toEqual([aAnswer]);
    expect(
      sessionTreeRows(tree, null, "", labeled).map((row) => row.id),
    ).toEqual([aAnswer]);
    expect(
      updateSessionTreeOptions(
        tree,
        { foldedEntryIds: [a] },
        parseSessionTreeCommand(`unfold ${a}`),
      ).foldedEntryIds,
    ).toEqual([]);
    expect(() =>
      updateSessionTreeOptions(
        tree,
        {},
        parseSessionTreeCommand("fold missing"),
      ),
    ).toThrow("Unknown");
  });
});

describe("session tags and picker filters", () => {
  it("replaces normalized tags after refresh without dropping name or archive metadata", () => {
    const manager = SessionManager.create(project());
    const peer = SessionManager.open(manager.cwd, manager.id);
    peer.setMetadata({ name: "hand name", archived: true, tags: ["old"] });
    expect(setSessionTags(manager, [" Work ", "work", "修复", "修复"])).toEqual(
      {
        name: "hand name",
        archived: true,
        tags: ["Work", "修复"],
      },
    );
    expect(SessionManager.open(manager.cwd, manager.id).getMetadata()).toEqual(
      manager.getMetadata(),
    );
    const revision = manager.revision;
    setSessionTags(manager, ["Work", "修复"]);
    expect(manager.revision).toBe(revision);
    expect(() => setSessionTags(manager, [" "])).toThrow();
    expect(() => setSessionTags(manager, ["bad\ntag"])).toThrow();
    expect(() => setSessionTags(manager, ["x".repeat(257)])).toThrow();
    expect(() =>
      setSessionTags(
        manager,
        Array.from({ length: 65 }, (_, i) => `${i}`),
      ),
    ).toThrow();
    expect(manager.revision).toBe(revision);
    expect(setSessionTags(manager, []).tags).toEqual([]);
    expect(manager.getMetadata()).toMatchObject({
      name: "hand name",
      archived: true,
    });
  });

  it("defaults to the current project and hides archived sessions even when search matches", () => {
    const cwd = project("one");
    const otherCwd = project("two");
    const active = SessionManager.create(cwd);
    user(active, "fix parser");
    active.setMetadata({ name: "Parser repair", tags: ["Work", "修复"] });
    const archived = SessionManager.create(cwd);
    archived.setMetadata({
      name: "Parser archive",
      tags: ["Work"],
      archived: true,
    });
    const other = SessionManager.create(otherCwd);
    other.setMetadata({ name: "Other parser", tags: ["Work"] });
    const all = listAllSessions();
    expect(filterSessions(all, { cwd }).map((session) => session.id)).toEqual([
      active.id,
    ]);
    expect(filterSessions(all, { cwd, query: "archive" })).toEqual([]);
    expect(
      filterSessions(all, {
        cwd,
        includeArchived: true,
        query: "name:archive tag:work",
      }).map((session) => session.id),
    ).toEqual([archived.id]);
    expect(
      filterSessions(all, { cwd, tags: ["work", "修复"] }).map(
        (session) => session.id,
      ),
    ).toEqual([active.id]);
    expect(
      filterSessions(all, { cwd, allProjects: true }).map(
        (session) => session.id,
      ),
    ).toEqual([active.id, other.id]);
    const otherInfo = all.find((session) => session.id === other.id);
    expect(otherInfo).toBeDefined();
    expect(
      filterSessions(all, {
        cwd,
        projectKey: otherInfo?.projectKey,
        query: "project:two name:parser",
      }).map((session) => session.id),
    ).toEqual([other.id]);
    const rows = sessionPickerRows(all, {
      cwd,
      allProjects: true,
      includeArchived: true,
    });
    expect(rows.find((row) => row.sessionId === archived.id)).toMatchObject({
      label: "Parser archive",
      archived: true,
    });
    expect(rows.find((row) => row.sessionId === active.id)).toMatchObject({
      cwd: active.cwd,
      tags: ["Work", "修复"],
    });
    const duplicates = all.map((session) => ({ ...session, id: "same-id" }));
    const distinct = sessionPickerRows(duplicates, { cwd, allProjects: true });
    expect(new Set(distinct.map((row) => row.id)).size).toBe(distinct.length);
  });
});

describe("local session name suggestion", () => {
  it.each([
    ["修复会话树中的分支折叠", "修复会话树中的分支折叠"],
    ["  first line\r\n second\t line  ", "first line second line"],
    ["Cafe\u0301 𝒜", "Café 𝒜"],
  ])(
    "summarizes Unicode and multiline real input locally: %s",
    (input, expected) => {
      const manager = SessionManager.create(project(), { persist: false });
      manager.append({ role: "user", content: "automatic reminder" });
      user(manager, input);
      const revision = manager.revision;
      const preview = previewSessionNameSuggestion(manager);
      expect(preview).toEqual({
        name: expected,
        token: {
          sessionId: manager.id,
          cwd: manager.cwd,
          revision,
          currentName: null,
        },
      });
      expect(manager.revision).toBe(revision);
      expect(manager.getMetadata()).toEqual({});
      if (!preview) {
        throw new Error("Missing preview");
      }
      expect(applySessionNameSuggestion(manager, preview)).toBe(true);
      expect(manager.getMetadata().name).toBe(expected);
      expect(applySessionNameSuggestion(manager, preview)).toBe(false);
    },
  );

  it("bounds long names without splitting graphemes or surrogate pairs", () => {
    const manager = SessionManager.create(project(), { persist: false });
    user(manager, "界𝒜e\u0301".repeat(10_000));
    const preview = previewSessionNameSuggestion(manager);
    expect(preview?.name.endsWith("…")).toBe(true);
    expect(preview?.name).not.toMatch(/\p{Cs}/u);
    expect([
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        preview?.name ?? "",
      ),
    ]).toHaveLength(SESSION_NAME_MAX_GRAPHEMES);
    expect(preview?.name.length).toBeLessThanOrEqual(256);
  });

  it("uses the original first real input across branches and preserves tags/archive on confirmation", () => {
    const manager = SessionManager.create(project());
    const first = user(manager, "original task");
    manager.navigate(first);
    user(manager, "new branch task");
    manager.setMetadata({ tags: ["local"], archived: true, name: "" });
    const preview = previewSessionNameSuggestion(manager);
    if (!preview) {
      throw new Error("Missing preview");
    }
    expect(preview.name).toBe("original task");
    expect(applySessionNameSuggestion(manager, preview)).toBe(true);
    expect(manager.getMetadata()).toEqual({
      name: "original task",
      tags: ["local"],
      archived: true,
    });
    expect(SessionManager.open(manager.cwd, manager.id).getMetadata()).toEqual(
      manager.getMetadata(),
    );
  });

  it("reads only real text blocks and never uses shell/tool payloads or image placeholders", () => {
    const manager = SessionManager.create(project(), { persist: false });
    manager.append({
      role: "user",
      content: "shell command",
      userBash: {
        command: "pwd",
        output: "output",
        isError: false,
        elapsed: 1,
        status: "completed",
        excludeFromContext: false,
      },
    });
    manager.append({
      role: "assistant",
      content: "",
      toolUses: [{ toolUseId: "call", toolName: "Echo", arguments: {} }],
    });
    manager.append({
      role: "user",
      content: "tool text",
      toolResults: [
        { toolUseId: "call", content: "tool output", isError: false },
      ],
    });
    manager.append({
      role: "user",
      timestamp: 1,
      user_input: { id: randomUUID(), timestamp: 1 },
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AA==" },
        },
        { type: "text", text: "修复" },
        { type: "text", text: "  parser" },
      ],
    });
    expect(previewSessionNameSuggestion(manager)?.name).toBe("修复 parser");
  });

  it("does not invent a name from empty, synthetic or image-only input, or replace a hand name", () => {
    const manager = SessionManager.create(project(), { persist: false });
    manager.append({ role: "user", content: "synthetic" });
    expect(previewSessionNameSuggestion(manager)).toBeNull();
    user(manager, " \n\t ");
    expect(previewSessionNameSuggestion(manager)).toBeNull();
    const images = SessionManager.create(project(), { persist: false });
    images.append({
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AA==" },
        },
      ],
      timestamp: 1,
      user_input: { id: randomUUID(), timestamp: 1 },
    });
    expect(previewSessionNameSuggestion(images)).toBeNull();
    const named = SessionManager.create(project(), { persist: false });
    user(named, "suggested task");
    named.setName("hand-written name");
    const revision = named.revision;
    expect(previewSessionNameSuggestion(named)).toBeNull();
    expect(named.getMetadata().name).toBe("hand-written name");
    expect(named.revision).toBe(revision);
  });

  it.each(["rename", "append", "rename-away-and-back"])(
    "refreshes and cancels on a concurrent %s",
    (change) => {
      const manager = SessionManager.create(project());
      user(manager, "original task");
      const preview = previewSessionNameSuggestion(manager);
      if (!preview) {
        throw new Error("Missing preview");
      }
      const peer = SessionManager.open(manager.cwd, manager.id);
      if (change === "append") {
        peer.append({ role: "assistant", content: "new revision" });
      } else {
        peer.setName("manual name");
        if (change === "rename-away-and-back") {
          peer.setName("");
        }
      }
      const revision = peer.revision;
      expect(applySessionNameSuggestion(manager, preview)).toBe(false);
      expect(manager.revision).toBe(revision);
      expect(manager.getMetadata()).toEqual(peer.getMetadata());
    },
  );

  it("cancels a write-time revision race, wrong-session token and altered suggestion", () => {
    const manager = SessionManager.create(project());
    user(manager, "original task");
    const preview = previewSessionNameSuggestion(manager);
    if (!preview) {
      throw new Error("Missing preview");
    }
    const other = SessionManager.create(project(), { persist: false });
    user(other, "original task");
    expect(applySessionNameSuggestion(other, preview)).toBe(false);
    expect(
      applySessionNameSuggestion(manager, { ...preview, name: "forged name" }),
    ).toBe(false);
    expect(
      applySessionNameSuggestion(manager, {
        ...preview,
        token: { ...preview.token, currentName: "not the current name" },
      }),
    ).toBe(false);
    expect(
      applySessionNameSuggestion(manager, {
        ...preview,
        token: { ...preview.token, cwd: project("different") },
      }),
    ).toBe(false);
    const peer = SessionManager.open(manager.cwd, manager.id);
    const originalSet = manager.setMetadata.bind(manager);
    vi.spyOn(manager, "setMetadata").mockImplementationOnce((metadata) => {
      peer.setName("race winner");
      originalSet(metadata);
    });
    expect(applySessionNameSuggestion(manager, preview)).toBe(false);
    expect(
      SessionManager.open(manager.cwd, manager.id).getMetadata().name,
    ).toBe("race winner");
  });
});

describe("session tree filter modes", () => {
  it("hides pure tools and bookkeeping without hiding summaries or counting shell records as user input", () => {
    const manager = SessionManager.create(project(), { persist: false });
    const user = manager.append({ role: "user", content: "task" });
    manager.append({
      role: "assistant",
      content: "",
      toolUses: [{ toolUseId: "read", toolName: "ReadFile", arguments: {} }],
    });
    manager.append({
      role: "user",
      content: "",
      toolResults: [{ toolUseId: "read", content: "result", isError: false }],
    });
    manager.append({
      role: "system",
      type: "bookkeeping",
      content: "internal",
      timestamp: 1,
    });
    const shell = manager.append({
      role: "user",
      content: "shell output",
      userBash: {
        command: "pwd",
        output: "/repo",
        isError: false,
        elapsed: 0,
        status: "completed",
        excludeFromContext: false,
      },
    });
    const summary = manager.append({
      role: "system",
      type: COMPACT_BOUNDARY,
      content: JSON.stringify({ summary: "Summary", keep: [] }),
      timestamp: 1,
    });
    const rows = (filter: "no-tools" | "user-only") =>
      sessionTreeRows(manager.getTree(), manager.leafId, "", { filter }).map(
        (row) => row.id,
      );
    expect(rows("no-tools")).toEqual([user, shell, summary]);
    expect(rows("user-only")).toEqual([user]);
  });

  it("filters tool batches, users and labels without changing session navigation state", () => {
    const manager = SessionManager.create(project(), { persist: false });
    const user = manager.append({ role: "user", content: "task" });
    const call = manager.append({
      role: "assistant",
      content: "checking",
      toolUses: [
        {
          toolUseId: "read",
          toolName: "ReadFile",
          arguments: { file_path: "/repo/a" },
        },
      ],
    });
    const result = manager.append({
      role: "user",
      content: "",
      toolResults: [{ toolUseId: "read", content: "contents", isError: false }],
    });
    const answer = manager.append({ role: "assistant", content: "answer" });
    manager.setLabel(answer, "decision");
    const revision = manager.revision;
    const tree = manager.getTree();
    const ids = (filter: "all" | "no-tools" | "user-only" | "labeled-only") =>
      sessionTreeRows(tree, answer, "", { filter }).map((row) => row.id);
    expect(ids("all")).toEqual([user, call, result, answer]);
    expect(ids("no-tools")).toEqual([user, call, answer]);
    expect(ids("user-only")).toEqual([user]);
    expect(ids("labeled-only")).toEqual([answer]);
    expect(
      sessionTreeRows(tree, answer, "role:assistant", {
        filter: "no-tools",
      }).map((row) => row.id),
    ).toEqual([call, answer]);
    expect(manager.leafId).toBe(answer);
    expect(manager.revision).toBe(revision);
    manager.navigate(call);
    expect(manager.leafId).toBe(result);
  });

  it("preserves tags and archive state when renaming a session", () => {
    const manager = SessionManager.create(project(), { persist: false });
    manager.setMetadata({ tags: ["work"], archived: true });
    manager.setName("Renamed");
    expect(manager.getMetadata()).toEqual({
      name: "Renamed",
      tags: ["work"],
      archived: true,
    });
  });
});
