import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as Execa from "execa";
import { execa } from "execa";
import { afterAll, describe, expect, it, vi } from "vitest";

import { PermissionChecker } from "@/permissions/index.js";
import { GlobTool } from "@/tools/glob.js";
import { GrepTool } from "@/tools/grep.js";
import type { ToolContext } from "@/tools/types.js";
import { canonicalPath } from "@/utils/paths.js";

vi.mock("execa", async (importOriginal) => {
  const actual = await importOriginal<typeof Execa>();
  return { ...actual, execa: vi.fn(actual.execa) };
});

const cwd = mkdtempSync(join(tmpdir(), "yukino-search-tools-"));
mkdirSync(join(cwd, "src", "js"), { recursive: true });
mkdirSync(join(cwd, "src", "md"), { recursive: true });
mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
writeFileSync(join(cwd, "main.js"), "console.log('entry');\n");
writeFileSync(
  join(cwd, "src", "js", "promise.js"),
  "class PromiseV2 {}\nconst PENDING = 'pending';\n",
);
writeFileSync(join(cwd, "src", "js", "curry.js"), "function curry(fn) {}\n");
writeFileSync(join(cwd, "src", "md", "notes.md"), "function notes() {}\n");
writeFileSync(
  join(cwd, "node_modules", "pkg", "index.js"),
  "function hidden() {}\n",
);
writeFileSync(
  join(cwd, "unicode.txt"),
  "日本語注釈\nemoji 😁 line\n全角数字１２３\nmixed 変数名abc end\nplain ascii only\n",
);
writeFileSync(join(cwd, "legacy.txt"), "match foo{ here\n");
writeFileSync(
  join(cwd, "bin.dat"),
  Buffer.from("BINARY_NEEDLE\0\x01\x02binary junk"),
);
mkdirSync(join(cwd, "links"));
writeFileSync(join(cwd, "links", "target.txt"), "NEEDLE_LINK in real file\n");
symlinkSync(join(cwd, "links", "target.txt"), join(cwd, "links", "alias.txt"));
// Directory symlink cycle back to the root: the walk must not descend it.
symlinkSync(cwd, join(cwd, "links", "loop"));

const ctx: ToolContext = { cwd };

const lines = (output: string | Record<string, unknown>[]): string[] => {
  if (typeof output !== "string") {
    throw new Error("expected string output");
  }
  return output.split("\n");
};

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("GrepTool include filter", () => {
  const grep = new GrepTool();

  it("matches include patterns containing path separators", async () => {
    const res = await grep.execute(ctx, {
      pattern: "^(function|class|const|async function) ",
      include: "src/js/*.js",
    });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("src/js/promise.js:1:class PromiseV2 {}");
    expect(res.output).toContain("src/js/curry.js:1:function curry(fn) {}");
    expect(res.output).not.toContain("main.js");
    expect(res.output).not.toContain("No matches found.");
  });

  it("matches an exact relative file path as include", async () => {
    const res = await grep.execute(ctx, {
      pattern: "const",
      include: "src/js/promise.js",
    });
    expect(res.output).toBe("src/js/promise.js:2:const PENDING = 'pending';");
  });

  it("matches bare include patterns at any depth and skips node_modules", async () => {
    const res = await grep.execute(ctx, {
      pattern: "function|console",
      include: "*.js",
    });
    expect(res.output).toContain("main.js:1:console.log('entry');");
    expect(res.output).toContain("src/js/curry.js:1:function curry(fn) {}");
    expect(res.output).not.toContain("node_modules");
  });

  it("supports brace include patterns", async () => {
    const res = await grep.execute(ctx, {
      pattern: "function",
      include: "*.{js,md}",
    });
    expect(res.output).toContain("src/md/notes.md:1:function notes() {}");
    expect(res.output).toContain("src/js/curry.js:1:function curry(fn) {}");
  });

  it("matches case-insensitively", async () => {
    const res = await grep.execute(ctx, {
      pattern: "CLASS PROMISEV2",
      include: "*.js",
    });
    expect(res.output).toContain("src/js/promise.js:1:class PromiseV2 {}");
  });

  it("resolves relative path args against cwd", async () => {
    const res = await grep.execute(ctx, { pattern: "curry", path: "src/js" });
    expect(res.output).toContain("src/js/curry.js:1:function curry(fn) {}");
  });
});

describe("GrepTool unicode", () => {
  const grep = new GrepTool();

  it("matches literal CJK text", async () => {
    const res = await grep.execute(ctx, { pattern: "注釈", include: "*.txt" });
    expect(res.output).toContain("unicode.txt:1:日本語注釈");
  });

  it("supports unicode property escapes", async () => {
    const res = await grep.execute(ctx, {
      pattern: "^\\p{Script=Han}+$",
      include: "*.txt",
    });
    expect(res.output).toContain("unicode.txt:1:日本語注釈");
    expect(res.output).not.toContain("plain ascii only");
  });

  it("supports astral character class ranges", async () => {
    const res = await grep.execute(ctx, {
      pattern: "[😀-😜]",
      include: "*.txt",
    });
    expect(res.output).toContain("unicode.txt:2:emoji 😁 line");
  });

  it("treats \\w and \\b as unicode-aware like ripgrep", async () => {
    const word = await grep.execute(ctx, {
      pattern: "^mixed \\w+ end$",
      include: "*.txt",
    });
    expect(word.output).toContain("unicode.txt:4:mixed 変数名abc end");

    const boundary = await grep.execute(ctx, {
      pattern: "\\b変数名",
      include: "*.txt",
    });
    expect(boundary.output).toContain("unicode.txt:4:mixed 変数名abc end");
  });

  it("matches full-width digits with \\d", async () => {
    const res = await grep.execute(ctx, {
      pattern: "数字\\d{3}",
      include: "*.txt",
    });
    expect(res.output).toContain("unicode.txt:3:全角数字１２３");
  });

  it("supports ripgrep-style \\x{...} hex escapes", async () => {
    const res = await grep.execute(ctx, {
      pattern: "[\\x{4e00}-\\x{9fff}]",
      include: "*.txt",
    });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("unicode.txt:1:日本語注釈");
    expect(res.output).not.toContain("plain ascii only");
  });

  it("rejects out-of-range \\x{...} values", async () => {
    const res = await grep.execute(ctx, {
      pattern: "\\x{110000}",
      include: "*.txt",
    });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("regex parse error");
  });

  it("requires escaping a literal opening brace", async () => {
    const res = await grep.execute(ctx, {
      pattern: "foo\\{",
      include: "*.txt",
    });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("legacy.txt:1:match foo{ here");
  });

  it("reports native regex syntax errors", async () => {
    const res = await grep.execute(ctx, {
      pattern: "(unclosed",
      include: "*.txt",
    });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("regex parse error");
  });

  it("skips binary files containing NUL bytes", async () => {
    const res = await grep.execute(ctx, { pattern: "BINARY_NEEDLE" });
    expect(res.output).toBe("No matches found.");
  });

  it("greps symlinked files but never descends symlinked directories", async () => {
    const res = await grep.execute(ctx, { pattern: "NEEDLE_LINK" });
    expect(res.output).toContain("links/target.txt:1:NEEDLE_LINK in real file");
    expect(res.output).toContain("links/alias.txt:1:NEEDLE_LINK in real file");
    expect(res.output).not.toContain("loop/");
  });
});

describe("GrepTool traversal limits", () => {
  it("reports when the file traversal limit truncates a search", async () => {
    const grep = new GrepTool({ maxEntries: 1, maxDepth: 25 });
    const result = await grep.execute(ctx, { pattern: "never-present" });

    expect(result.isError).toBe(false);
    expect(result.output).toContain(
      "search truncated after visiting 1 entries",
    );
  });

  it("reports and skips directories beyond the depth limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-grep-depth-"));
    try {
      mkdirSync(join(dir, "one", "two"), { recursive: true });
      writeFileSync(join(dir, "one", "two", "deep.txt"), "DEEP_NEEDLE\n");
      const grep = new GrepTool({ maxEntries: 100, maxDepth: 1 });
      const result = await grep.execute(
        { cwd: dir },
        {
          pattern: "DEEP_NEEDLE",
        },
      );

      expect(result.output).not.toContain("deep.txt");
      expect(result.output).toContain(
        "search truncated: directories deeper than 1 levels were skipped",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GlobTool", () => {
  const glob = new GlobTool();

  it("matches path patterns", async () => {
    const res = await glob.execute(ctx, { pattern: "src/js/*.js" });
    expect(res.isError).toBe(false);
    expect(lines(res.output).sort()).toEqual([
      "src/js/curry.js",
      "src/js/promise.js",
    ]);
  });

  it("matches ** recursively and skips node_modules", async () => {
    const res = await glob.execute(ctx, { pattern: "**/*.js" });
    const matched = lines(res.output);
    expect(matched).toContain("main.js");
    expect(matched).toContain("src/js/promise.js");
    expect(matched.some((l) => l.startsWith("node_modules"))).toBe(false);
  });

  it("matches brace patterns", async () => {
    const res = await glob.execute(ctx, { pattern: "*.{js,md}" });
    const matched = lines(res.output);
    expect(matched).toContain("src/md/notes.md");
    expect(matched).toContain("main.js");
  });

  it("reports when nothing matches", async () => {
    const res = await glob.execute(ctx, { pattern: "*.rs" });
    expect(res.output).toBe("No files matched the pattern.");
  });
});

describe("GrepTool catastrophic backtracking", () => {
  const grep = new GrepTool();

  it("stops matching once the output limit is reached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-grep-cap-"));
    writeFileSync(
      join(dir, "many.txt"),
      "a\n".repeat(501) + "a".repeat(32) + "!\n",
    );
    try {
      const result = await grep.execute({ cwd: dir }, { pattern: "(a+)+$" });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("many.txt:1:a");
      expect(result.output).toContain("truncated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles nested quantifiers without catastrophic backtracking", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-grep-evil-"));
    writeFileSync(join(dir, "evil.txt"), `${"a".repeat(32)}!\n`);
    writeFileSync(join(dir, "ok.txt"), "normal aaa line\n");
    try {
      const start = Date.now();
      const res = await grep.execute(
        { cwd: dir },
        { pattern: "(a+)+$", path: dir },
      );
      const elapsed = Date.now() - start;
      expect(res.isError).toBe(false);
      expect(res.output).toContain("No matches found.");
      expect(elapsed).toBeLessThan(8000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("matches normal patterns as well", async () => {
    const res = await grep.execute(ctx, { pattern: "normal|NEEDLE_LINK" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("links/target.txt:1:NEEDLE_LINK in real file");
  });
});

describe("ripgrep file admission", () => {
  it("passes only authorized files to a non-recursive search process", async () => {
    const root = mkdtempSync(join(tmpdir(), "yukino-grep-admission-"));
    const denied = join(root, "secret.txt");
    const alias = join(root, "alias.txt");
    writeFileSync(denied, "PRIVATE_NEEDLE");
    writeFileSync(join(root, "allowed.txt"), "PUBLIC_NEEDLE");
    symlinkSync(denied, alias);
    const checker = new PermissionChecker(root);
    vi.spyOn(checker, "canReadSearchPath").mockImplementation(
      (path) => canonicalPath(path) !== canonicalPath(denied),
    );
    vi.mocked(execa).mockClear();
    try {
      const result = await new GrepTool().execute(
        { cwd: root, permissionChecker: checker },
        { pattern: "NEEDLE" },
      );
      expect(result.isError).toBe(false);
      expect(result.output).toContain("PUBLIC_NEEDLE");
      expect(result.output).not.toContain("PRIVATE_NEEDLE");
      for (const call of vi.mocked(execa).mock.calls) {
        expect(call[1]).toContain("--max-depth=0");
        expect(call[1]).not.toContain(denied);
        expect(call[1]).not.toContain(alias);
        expect(call[1]).not.toContain(root);
      }
      const direct = await new GrepTool().execute(
        { cwd: root, permissionChecker: checker },
        { pattern: "NEEDLE", path: denied },
      );
      expect(direct.output).toBe("No matches found.");
      expect(vi.mocked(execa).mock.calls.at(-1)?.[1]).toContain("-");
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
