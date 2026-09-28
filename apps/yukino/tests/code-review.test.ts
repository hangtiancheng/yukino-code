import { describe, expect, it } from "vitest";

import {
  parseComments,
  CommentCollector,
  normalizeCommentPath,
} from "@/code-review/comment-tool.js";
import {
  parseDiffText,
  parseHunks,
  unquoteGitPath,
} from "@/code-review/diff-parser.js";
import { FileReadDiffTool } from "@/code-review/file-read-diff.js";
import { parseFilterResponse } from "@/code-review/filter.js";
import {
  buildChangeFilesExceptGroup,
  buildConcatenatedDiffs,
  buildConfirmedCommentsBlock,
  buildMainTaskMessage,
} from "@/code-review/format.js";
import { deriveReviewMode } from "@/code-review/git.js";
import {
  chunkGroups,
  enforceMaxFilesPerGroup,
  formatDiffEntry,
  parseGroupingResponse,
} from "@/code-review/grouping.js";
import { stripMarkdownFences } from "@/code-review/prompts.js";
import { extractCodeBlock, relocateWithLlm } from "@/code-review/relocate.js";
import {
  relocateAcrossFiles,
  resolveComment,
  resolveFromFileContent,
  resolveFromHunk,
} from "@/code-review/resolve.js";
import {
  finalizeComments,
  parseReviewArgs,
  validateReviewInput,
} from "@/code-review/runner.js";
import {
  effectivePath,
  estimateTokens,
  selectFiles,
  summarizeSelection,
} from "@/code-review/selection.js";
import type { FileDiff, ReviewComment } from "@/code-review/types.js";
import { parse as parseCommand } from "@/commands/commands.js";
import type { LLMClient } from "@/llm/client.js";

const MODIFIED_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1234567..89abcde 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,6 @@
 import express from "express";
 
+const port = 8080;
 const app = express();
 app.listen(port);
 export default app;
`;

const NEW_FILE_DIFF = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
`;

const DELETED_DIFF = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const gone = true;
-export const alsoGone = true;
`;

const BINARY_DIFF = `diff --git a/imgs/logo.png b/imgs/logo.png
new file mode 100644
Binary files /dev/null and b/imgs/logo.png differ
`;

const RENAMED_DIFF = `diff --git a/src/before.ts b/src/after.ts
similarity index 90%
rename from src/before.ts
rename to src/after.ts
--- a/src/before.ts
+++ b/src/after.ts
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = 3;
`;

function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    path: "src/app.ts",
    content: "issue",
    existingCode: "const port = 8080;",
    startLine: 0,
    endLine: 0,
    category: "bug",
    severity: "high",
    resolution: "unresolved",
    ...overrides,
  };
}

function makeFileDiff(
  path: string,
  overrides: Partial<FileDiff> = {},
): FileDiff {
  return {
    oldPath: path,
    newPath: path,
    diffText: `diff --git a/${path} b/${path}\n`,
    hunks: [],
    isBinary: false,
    isDeleted: false,
    isNew: false,
    isRenamed: false,
    insertions: 0,
    deletions: 0,
    ...overrides,
  };
}

describe("diff-parser", () => {
  it("parses modified, new, deleted, binary and renamed files", async () => {
    const diffs = await parseDiffText(
      [
        MODIFIED_DIFF,
        NEW_FILE_DIFF,
        DELETED_DIFF,
        BINARY_DIFF,
        RENAMED_DIFF,
      ].join("\n"),
    );
    expect(diffs).toHaveLength(5);

    const modified = diffs[0];
    expect(modified.oldPath).toBe("src/app.ts");
    expect(modified.newPath).toBe("src/app.ts");
    expect(modified.insertions).toBe(1);
    expect(modified.deletions).toBe(0);
    expect(modified.isNew).toBe(false);
    expect(modified.hunks).toHaveLength(1);
    expect(modified.hunks[0]?.newStart).toBe(1);
    // The "index" header line is dropped from the retained diff text.
    expect(modified.diffText).not.toContain("index 1234567");

    const added = diffs[1];
    expect(added.isNew).toBe(true);
    expect(added.insertions).toBe(2);

    const deleted = diffs[2];
    expect(deleted.isDeleted).toBe(true);
    expect(deleted.newPath).toBe("/dev/null");
    expect(deleted.deletions).toBe(2);

    const binary = diffs[3];
    expect(binary.isBinary).toBe(true);

    const renamed = diffs[4];
    expect(renamed.isRenamed).toBe(true);
    expect(renamed.oldPath).toBe("src/before.ts");
    expect(renamed.newPath).toBe("src/after.ts");
  });

  it("parses hunk headers with and without counts", () => {
    const hunks = parseHunks("@@ -1 +1 @@\n-a\n+b");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.oldCount).toBe(1);
    expect(hunks[0]?.newCount).toBe(1);
    expect(hunks[0]?.lines).toEqual([
      { type: "deleted", content: "a" },
      { type: "added", content: "b" },
    ]);
  });

  it("does not count +++/--- headers as insertions outside hunks", async () => {
    const diffs = await parseDiffText(MODIFIED_DIFF);
    const d = diffs[0];
    expect(d.insertions).toBe(1);
    expect(d.deletions).toBe(0);
  });

  it("unquotes git C-style paths", () => {
    expect(unquoteGitPath('"src/a b.ts"')).toBe("src/a b.ts");
    expect(unquoteGitPath('"src/a\\tb.ts"')).toBe("src/a\tb.ts");
    expect(unquoteGitPath("plain.ts")).toBe("plain.ts");
  });

  it("reads new file content through the injected reader", async () => {
    const diffs = await parseDiffText(MODIFIED_DIFF, {
      readNewFileContent: () => Promise.resolve("file body"),
    });
    expect(diffs[0].newFileContent).toBe("file body");
  });
});

describe("selection", () => {
  it("applies user excludes and reports them", () => {
    const diffs = [
      { ...makeFileDiff("src/app.ts"), insertions: 1 },
      { ...makeFileDiff("src/generated.pb.go"), insertions: 1 },
    ];
    const summary = summarizeSelection(
      selectFiles(diffs, { excludePatterns: ["**/*.pb.go"] }),
    );
    expect(summary.selectedCount).toBe(1);
    expect(summary.excluded).toEqual([
      { path: "src/generated.pb.go", reason: "user-rule" },
    ]);
  });

  it("selects, retains deletions for context, and reports exclusions", async () => {
    const diffs = await parseDiffText(
      [MODIFIED_DIFF, NEW_FILE_DIFF, DELETED_DIFF, BINARY_DIFF].join("\n"),
    );
    const decisions = selectFiles(diffs);
    const summary = summarizeSelection(decisions);
    expect(summary.selectedCount).toBe(2);
    // Deletions are retained (prompt context) but not selected (never reviewed).
    expect(summary.retained).toHaveLength(3);
    expect(summary.excluded).toEqual([
      { path: "src/old.ts", reason: "deleted" },
      { path: "imgs/logo.png", reason: "binary" },
    ]);
  });

  it("applies the per-file token size gate", async () => {
    const diffs = await parseDiffText(MODIFIED_DIFF);
    const decisions = selectFiles(diffs, { fileTokenLimit: 1 });
    expect(decisions[0]?.reason).toBe("too-large");
  });

  it("estimates tokens and resolves effective paths", async () => {
    expect(estimateTokens("abcd")).toBe(1);
    const diffs = await parseDiffText(DELETED_DIFF);
    expect(effectivePath(diffs[0])).toBe("src/old.ts");
  });
});

describe("resolve", () => {
  it("matches existing_code on the hunk new side with exact line numbers", async () => {
    const diffs = await parseDiffText(MODIFIED_DIFF);
    const d = diffs[0];
    const cm = makeComment();
    expect(resolveComment(cm, d)).toBe(true);
    expect(cm.resolution).toBe("hunk");
    // "const port = 8080;" is added as new-side line 3.
    expect(cm.startLine).toBe(3);
    expect(cm.endLine).toBe(3);
  });

  it("falls back to old-side matching for deleted code", async () => {
    const diffs = await parseDiffText(RENAMED_DIFF);
    const d = diffs[0];
    const cm = makeComment({
      path: "src/after.ts",
      existingCode: "const y = 2;",
    });
    expect(resolveFromHunk(d, cm)).toBe(true);
    expect(cm.startLine).toBe(2);
  });

  it("falls back to full-file content scan", async () => {
    const diffs = await parseDiffText(MODIFIED_DIFF, {
      readNewFileContent: () =>
        Promise.resolve(
          'import express from "express";\n\nconst port = 8080;\nconst app = express();\n',
        ),
    });
    const d = diffs[0];
    const cm = makeComment({ existingCode: "const app = express();" });
    // Present both in hunk context and file content; hunk wins.
    expect(resolveComment(cm, d)).toBe(true);
    const cm2 = makeComment({ existingCode: 'import express from "express";' });
    d.hunks = [];
    expect(resolveFromFileContent(d, cm2)).toBe(true);
    expect(cm2.startLine).toBe(1);
    expect(cm2.resolution).toBe("file-content");
  });

  it("relocates across files only on a unique hit", async () => {
    const diffs = await parseDiffText(
      [MODIFIED_DIFF, NEW_FILE_DIFF].join("\n"),
    );
    // Comment filed against new.ts but its code lives in app.ts.
    const cm = makeComment({ path: "src/new.ts" });
    expect(relocateAcrossFiles(cm, diffs)).toBe("src/app.ts");
    expect(cm.path).toBe("src/app.ts");
    expect(cm.startLine).toBe(3);
    expect(cm.resolution).toBe("cross-file");

    // Ambiguous: same snippet in two other files → decline.
    const dupA = makeComment({
      path: "a.ts",
      existingCode: "const port = 8080;",
    });
    const dupDiffs = [
      { ...diffs[0], newPath: "x.ts" },
      { ...diffs[0], newPath: "y.ts" },
    ];
    expect(relocateAcrossFiles(dupA, dupDiffs)).toBeNull();
    expect(dupA.path).toBe("a.ts");
  });

  it("declines cross-file re-filing onto deleted files", async () => {
    const diffs = await parseDiffText([MODIFIED_DIFF, DELETED_DIFF].join("\n"));
    // The snippet exists only among deleted lines; deleted code is
    // reference-only, so the relocation must decline rather than produce a
    // "/dev/null" path.
    const cm = makeComment({
      path: "src/other.ts",
      existingCode: "export const gone = true;",
    });
    expect(relocateAcrossFiles(cm, diffs)).toBeNull();
    expect(cm.path).toBe("src/other.ts");
  });

  it("restores the original snippet when LLM re-location fails to resolve", async () => {
    const diffs = await parseDiffText(MODIFIED_DIFF);
    const d = diffs[0];
    const cm = makeComment({
      existingCode: "definitely not present",
    });
    const fakeClient = (text: string): LLMClient => ({
      protocol: "anthropic",
      setSystemPrompt: () => {
        /* noop */
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      stream: async function* () {
        yield { type: "text_delta", text };
      },
    });
    const ok = await relocateWithLlm(
      fakeClient("```\nalso not present\n```"),
      cm,
      d,
    );
    expect(ok).toBe(false);
    expect(cm.existingCode).toBe("definitely not present");
    expect(cm.startLine).toBe(0);
  });
});

describe("grouping", () => {
  const fileDiffs = (n: number): FileDiff[] =>
    Array.from({ length: n }, (_, i) => ({
      oldPath: `src/f${String(i)}.ts`,
      newPath: `src/f${String(i)}.ts`,
      diffText: "@@ -1 +1 @@\n-a\n+b",
      hunks: [],
      isBinary: false,
      isDeleted: false,
      isNew: false,
      isRenamed: false,
      insertions: 1,
      deletions: 1,
    }));

  it("parses a valid grouping response and covers unseen files", () => {
    const diffs = fileDiffs(4);
    const groups = parseGroupingResponse(
      '[{"label": "core", "files": [0, 1]}]',
      diffs,
    );
    expect(groups).toHaveLength(3);
    expect(groups[0]?.label).toBe("core");
    expect(groups[0]?.diffs).toHaveLength(2);
    // Uncovered files become single-file groups.
    expect(groups[1]?.diffs).toHaveLength(1);
    expect(groups[2]?.diffs).toHaveLength(1);
  });

  it("strips markdown fences and skips duplicates/out-of-range indices", () => {
    const diffs = fileDiffs(3);
    const groups = parseGroupingResponse(
      '```json\n[{"label": "a", "files": [0, 0, 9]}, {"label": "b", "files": [0, 1, 2]}]\n```',
      diffs,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]?.diffs).toHaveLength(1);
    expect(groups[1]?.diffs).toHaveLength(2);
  });

  it("throws on unparsable responses so the caller can fall back", () => {
    expect(() => parseGroupingResponse("not json", fileDiffs(2))).toThrow();
  });

  it("splits groups over the 10-file cap", () => {
    const groups = enforceMaxFilesPerGroup([
      { label: "big", diffs: fileDiffs(12) },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.diffs).toHaveLength(10);
    expect(groups[1]?.diffs).toHaveLength(2);
  });

  it("chunks deterministically as fallback", () => {
    const groups = chunkGroups(fileDiffs(11));
    expect(groups).toHaveLength(2);
  });

  it("formats diff entries", () => {
    const d = fileDiffs(1)[0];
    expect(formatDiffEntry(d)).toBe("MODIFIED   src/f0.ts (+1/-1)");
    expect(formatDiffEntry({ ...d, isNew: true })).toContain("ADDED");
    expect(formatDiffEntry({ ...d, isDeleted: true })).toContain("DELETED");
    expect(formatDiffEntry({ ...d, isRenamed: true })).toContain("RENAMED");
  });
});

describe("filter", () => {
  it("extracts removal ids and ignores out-of-range values", () => {
    const removed = parseFilterResponse(
      '{"analysis": ["c-1 contradicts line X"], "remove_ids": ["c-1", "c-9", "bogus"]}',
      3,
    );
    expect([...removed]).toEqual([1]);
  });

  it("approves everything on unparsable output", () => {
    expect(parseFilterResponse("I approve", 3).size).toBe(0);
    expect(parseFilterResponse('{"remove_ids": "c-1"}', 3).size).toBe(0);
  });

  it("handles fenced JSON", () => {
    const removed = parseFilterResponse(
      '```json\n{"remove_ids": ["c-0"]}\n```',
      2,
    );
    expect([...removed]).toEqual([0]);
  });
});

describe("comment-tool", () => {
  it("parses valid comment batches", () => {
    const parsed = parseComments(
      {
        comments: [
          {
            path: "src/app.ts",
            content: "port hardcoded",
            existing_code: "const port = 8080;",
            category: "bug",
            severity: "high",
          },
        ],
      },
      "fallback.ts",
    );
    expect(parsed.error).toBeUndefined();
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0]?.category).toBe("bug");
    expect(parsed.comments[0]?.severity).toBe("high");
  });

  it("repairs a single object and a JSON string payload", () => {
    const single = parseComments(
      {
        comments: {
          path: "a.ts",
          content: "x",
          existing_code: "y",
          category: "bug",
          severity: "low",
        },
      },
      "a.ts",
    );
    expect(single.comments).toHaveLength(1);

    const stringified = parseComments(
      {
        comments: JSON.stringify([
          { path: "a.ts", content: "x", existing_code: "y" },
        ]),
      },
      "a.ts",
    );
    expect(stringified.comments).toHaveLength(1);
  });

  it("drops unusable entries and keeps the rest of the batch", () => {
    const parsed = parseComments(
      {
        comments: [
          { path: "a.ts", content: "good", existing_code: "x" },
          "not an object",
          { path: "b.ts", existing_code: "y" },
        ],
      },
      "fallback.ts",
    );
    expect(parsed.error).toBeUndefined();
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0]?.path).toBe("a.ts");
    expect(parsed.droppedEntries).toBe(2);

    const allBad = parseComments({ comments: [{ path: "b.ts" }] }, "f.ts");
    expect(allBad.error).toContain("no valid comments");
  });

  it("defaults missing paths and normalizes unknown enums", () => {
    const parsed = parseComments(
      {
        comments: [
          {
            content: "x",
            existing_code: "y",
            category: "weird",
            severity: "urgent",
          },
        ],
      },
      "group/main.ts",
    );
    expect(parsed.comments[0]?.path).toBe("group/main.ts");
    expect(parsed.defaultedPaths).toBe(1);
    expect(parsed.comments[0]?.category).toBe("other");
    expect(parsed.comments[0]?.severity).toBe("low");
  });

  it("normalizes comment paths", () => {
    expect(normalizeCommentPath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeCommentPath("/src/a.ts")).toBe("src/a.ts");
    expect(normalizeCommentPath("src\\nested\\a.ts")).toBe("src/nested/a.ts");
    expect(normalizeCommentPath("src//double.ts")).toBe("src/double.ts");
  });

  it("collector supports snapshot deltas and index removal", () => {
    const collector = new CommentCollector();
    collector.add(makeComment({ content: "one" }));
    const mark = collector.snapshot();
    collector.add(makeComment({ content: "two" }));
    collector.add(makeComment({ content: "three" }));
    expect(collector.since(mark).map((c) => c.content)).toEqual([
      "two",
      "three",
    ]);
    collector.removeAt([mark + 1]);
    expect(collector.all().map((c) => c.content)).toEqual(["one", "two"]);
    expect(collector.forPath("src/app.ts")).toHaveLength(2);
  });
});

describe("format", () => {
  it("renders per-file XML diffs", async () => {
    const diffs = await parseDiffText(MODIFIED_DIFF);
    const xml = buildConcatenatedDiffs(diffs);
    expect(xml).toContain('<file path="src/app.ts">');
    expect(xml).toContain("+const port = 8080;");
  });

  it("escapes the path attribute", () => {
    const xml = buildConcatenatedDiffs([makeFileDiff('weird"<>&.ts')]);
    expect(xml).toContain('<file path="weird&quot;&lt;&gt;&amp;.ts">');
  });

  it("excludes group members and binaries from the change-files list", async () => {
    const diffs = await parseDiffText(
      [MODIFIED_DIFF, NEW_FILE_DIFF, BINARY_DIFF].join("\n"),
    );
    const list = buildChangeFilesExceptGroup(diffs, [diffs[0]]);
    expect(list).toContain("src/new.ts");
    expect(list).not.toContain("src/app.ts");
    expect(list).not.toContain("logo.png");
  });

  it("builds the confirmed-findings block with truncation", () => {
    expect(buildConfirmedCommentsBlock([])).toBe("");
    const block = buildConfirmedCommentsBlock([
      makeComment({ content: "x".repeat(400) }),
    ]);
    expect(block).toContain("<confirmed_findings>");
    expect(block).toContain("...");
    expect(block.length).toBeLessThan(700);
  });

  it("strips empty plan/confirmed sections from the main task message", () => {
    const msg = buildMainTaskMessage({
      changeFiles: "",
      diffs: "<file/>",
      currentDateTime: "2026-01-01 00:00",
      background: "",
      planGuidance: "",
      confirmedComments: "",
    });
    expect(msg).not.toContain("### Review Plan");
    expect(msg).not.toContain("### Previously Confirmed Findings");
    expect(msg).toContain("<review_files>");

    const withPlan = buildMainTaskMessage({
      changeFiles: "",
      diffs: "<file/>",
      currentDateTime: "2026-01-01 00:00",
      background: "bg",
      planGuidance: "the plan",
      confirmedComments: "prior findings",
    });
    expect(withPlan).toContain("### Review Plan\nthe plan");
    expect(withPlan).toContain("bg");
  });
});

describe("prompts/relocate helpers", () => {
  it("strips markdown fences", () => {
    expect(stripMarkdownFences("```json\n{}\n```")).toBe("{}");
    expect(stripMarkdownFences("plain")).toBe("plain");
  });

  it("extracts the first fenced code block", () => {
    expect(extractCodeBlock("text\n```ts\nconst a = 1;\n```\nmore")).toBe(
      "const a = 1;",
    );
    expect(extractCodeBlock("no fence here")).toBe("no fence here");
  });
});

describe("runner helpers", () => {
  it("maps review args to workspace, range, and commit modes", () => {
    const workspace = parseReviewArgs("");
    expect(workspace).toEqual({
      from: undefined,
      to: undefined,
      commit: undefined,
      excludePatterns: [],
      background: "",
    });
    expect(deriveReviewMode(workspace)).toBe("workspace");

    const range = parseReviewArgs(
      '--from main --to feature focus on "the auth flow"',
    );
    expect(range).toEqual({
      from: "main",
      to: "feature",
      commit: undefined,
      excludePatterns: [],
      background: "focus on the auth flow",
    });
    expect(deriveReviewMode(range)).toBe("range");

    const commit = parseReviewArgs("--commit=abc123");
    expect(commit).toEqual({
      from: undefined,
      to: undefined,
      commit: "abc123",
      excludePatterns: [],
      background: "",
    });
    expect(deriveReviewMode(commit)).toBe("commit");
  });

  it("preserves slash-command args and applies repeatable excludes", () => {
    const command = parseCommand(
      '/review --exclude **/*.pb.go --exclude="fixtures/generated files/**" --from main --to dev fix the thing',
    );
    expect(command).not.toBeNull();
    if (!command) {
      throw new Error("expected /review to parse");
    }

    const parsed = parseReviewArgs(command.args);
    expect(command.name).toBe("review");
    expect(parsed.excludePatterns).toEqual([
      "**/*.pb.go",
      "fixtures/generated files/**",
    ]);
    expect(parsed.from).toBe("main");
    expect(parsed.to).toBe("dev");
    expect(parsed.background).toBe("fix the thing");

    const decisions = selectFiles(
      [
        makeFileDiff("src/app.ts"),
        makeFileDiff("api/generated.pb.go"),
        makeFileDiff("fixtures/generated files/output.ts"),
      ],
      { excludePatterns: parsed.excludePatterns },
    );
    expect(decisions.map((decision) => decision.reason)).toEqual([
      "none",
      "user-rule",
      "user-rule",
    ]);
  });

  it("rejects malformed and unknown review options", () => {
    expect(() => parseReviewArgs("--exlcude dist/**")).toThrow(
      'did you mean "--exclude"',
    );
    expect(() => parseReviewArgs("--unknown value")).toThrow(
      'Unknown option "--unknown"',
    );
    expect(() => parseReviewArgs("--exclude --from main --to dev")).toThrow(
      'Option "--exclude" requires a value',
    );
    expect(() => parseReviewArgs("--commit=")).toThrow(
      'Option "--commit" requires a value',
    );
    expect(() => parseReviewArgs("--commit one --commit two")).toThrow(
      'Option "--commit" may only be specified once',
    );
    expect(() => parseReviewArgs('--exclude "unterminated')).toThrow(
      "unterminated quote",
    );
    expect(parseReviewArgs("-- --exclude is focus").background).toBe(
      "--exclude is focus",
    );
  });

  it("validates ref combinations", () => {
    expect(() => {
      validateReviewInput("main", undefined, undefined);
    }).toThrow("--from and --to");
    expect(() => {
      validateReviewInput("main", "dev", "abc");
    }).toThrow("--commit cannot be combined");
    expect(() => {
      validateReviewInput("--frobnicate", "dev", undefined);
    }).toThrow('must not start with "-"');
    expect(() => {
      validateReviewInput(undefined, undefined, "abc");
    }).not.toThrow();
    expect(() => {
      validateReviewInput("main", "dev", undefined);
    }).not.toThrow();
  });

  it("dedupes and sorts finalized comments", () => {
    const comments = [
      makeComment({ path: "b.ts", startLine: 2, severity: "low" }),
      makeComment({ path: "a.ts", startLine: 5, severity: "critical" }),
      makeComment({ path: "a.ts", startLine: 5, severity: "critical" }),
      makeComment({ path: "a.ts", startLine: 1, severity: "low" }),
    ];
    const out = finalizeComments(comments);
    expect(out).toHaveLength(3);
    expect(out.map((c) => `${c.path}:${String(c.startLine)}`)).toEqual([
      "a.ts:1",
      "a.ts:5",
      "b.ts:2",
    ]);
  });
});

describe("file-read-diff tool", () => {
  it("serves diffs of changed files and rejects unknown paths", async () => {
    const diffs = await parseDiffText([MODIFIED_DIFF, DELETED_DIFF].join("\n"));
    const byPath = new Map<string, FileDiff>();
    for (const d of diffs) {
      byPath.set(d.newPath, d);
      byPath.set(d.oldPath, d);
    }
    const tool = new FileReadDiffTool(byPath);
    expect(tool.name).toBe("FileReadDiff");
    expect(tool.category).toBe("read");

    const hit = await tool.execute({ workDir: "/tmp" }, { path: "src/app.ts" });
    expect(hit.isError).toBe(false);
    expect(hit.output).toContain("diff --git a/src/app.ts");

    const deleted = await tool.execute(
      { workDir: "/tmp" },
      { path: "src/old.ts" },
    );
    expect(deleted.isError).toBe(false);
    expect(deleted.output).toContain("src/old.ts");

    const miss = await tool.execute({ workDir: "/tmp" }, { path: "nope.ts" });
    expect(miss.isError).toBe(true);
  });
});

describe("report", () => {
  it("renders findings grouped by file", async () => {
    const { formatReviewReport } = await import("@/code-review/report.js");
    const report = formatReviewReport({
      mode: "workspace",
      comments: [
        makeComment({ startLine: 3, endLine: 3, content: "hardcoded port" }),
      ],
      filesReviewed: 1,
      filesChanged: 2,
      groups: [{ label: "g", files: ["src/app.ts"] }],
      excluded: [{ path: "x.lock", reason: "user-rule" }],
      filteredOut: 1,
      aborted: false,
    });
    expect(report).toContain("## Code Review");
    expect(report).toContain("### src/app.ts");
    expect(report).toContain("src/app.ts:3");
    expect(report).toContain("hardcoded port");
    expect(report).toContain("1 excluded");
    expect(report).toContain("1 filtered by fact-check");
  });

  it("reports a clean run", async () => {
    const { formatReviewReport } = await import("@/code-review/report.js");
    const report = formatReviewReport({
      mode: "workspace",
      comments: [],
      filesReviewed: 1,
      filesChanged: 1,
      groups: [],
      excluded: [],
      filteredOut: 0,
      aborted: false,
    });
    expect(report).toContain("No issues found");
  });
});
