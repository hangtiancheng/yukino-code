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
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { GlobTool } from "@/tools/glob.js";
import { GrepTool } from "@/tools/grep.js";
import type { ToolContext } from "@/tools/types.js";

const workDir = mkdtempSync(join(tmpdir(), "yukino-search-tools-"));
mkdirSync(join(workDir, "src", "js"), { recursive: true });
mkdirSync(join(workDir, "src", "md"), { recursive: true });
mkdirSync(join(workDir, "node_modules", "pkg"), { recursive: true });
writeFileSync(join(workDir, "main.js"), "console.log('entry');\n");
writeFileSync(
  join(workDir, "src", "js", "promise.js"),
  "class PromiseV2 {}\nconst PENDING = 'pending';\n",
);
writeFileSync(
  join(workDir, "src", "js", "curry.js"),
  "function curry(fn) {}\n",
);
writeFileSync(join(workDir, "src", "md", "notes.md"), "function notes() {}\n");
writeFileSync(
  join(workDir, "node_modules", "pkg", "index.js"),
  "function hidden() {}\n",
);
writeFileSync(
  join(workDir, "unicode.txt"),
  "日本語注釈\nemoji 😁 line\n全角数字１２３\nmixed 変数名abc end\nplain ascii only\n",
);
writeFileSync(join(workDir, "legacy.txt"), "match foo{ here\n");
writeFileSync(
  join(workDir, "bin.dat"),
  Buffer.from("BINARY_NEEDLE\0\x01\x02binary junk"),
);
mkdirSync(join(workDir, "links"));
writeFileSync(
  join(workDir, "links", "target.txt"),
  "NEEDLE_LINK in real file\n",
);
symlinkSync(
  join(workDir, "links", "target.txt"),
  join(workDir, "links", "alias.txt"),
);
// Directory symlink cycle back to the root: the walk must not descend it.
symlinkSync(workDir, join(workDir, "links", "loop"));

const ctx: ToolContext = { workDir };

const lines = (output: string | Record<string, unknown>[]): string[] => {
  if (typeof output !== "string") {
    throw new Error("expected string output");
  }
  return output.split("\n");
};

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
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

  it("resolves relative path args against workDir", async () => {
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

  it("does not crash on out-of-range \\x{...} values", async () => {
    const res = await grep.execute(ctx, {
      pattern: "\\x{110000}",
      include: "*.txt",
    });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("No matches found.");
  });

  it("falls back to legacy mode for patterns invalid in unicode mode", async () => {
    const res = await grep.execute(ctx, { pattern: "foo{", include: "*.txt" });
    expect(res.isError).toBe(false);
    expect(res.output).toContain("legacy.txt:1:match foo{ here");
  });

  it("rejects patterns invalid in both modes", async () => {
    const res = await grep.execute(ctx, {
      pattern: "(unclosed",
      include: "*.txt",
    });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("invalid regex pattern");
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
