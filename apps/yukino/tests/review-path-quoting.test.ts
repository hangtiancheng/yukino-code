import { describe, expect, it } from "vitest";

import { quoteGitPath, unquoteGitPath } from "@/review/diff-parser.js";

describe("Git diff path quoting round trip", () => {
  const cases = [
    "plain.ts",
    "with space.ts",
    'with"quote.ts',
    "with\\backslash.ts",
    "tab\there.ts",
    "new\nline.ts",
    "cr\rreturn.ts",
    "control\x01char.ts",
    "del\x7fchar.ts",
    "中文文件名.ts",
    "emoji😁.ts",
    'mixed 中文\t"q" \\ end',
  ];

  it.each(cases)("round-trips %j", (path) => {
    expect(unquoteGitPath(quoteGitPath(path))).toBe(path);
  });

  it("does not quote a plain path", () => {
    expect(quoteGitPath("plain.ts")).toBe("plain.ts");
  });

  it("quotes a path with a space but keeps it literal inside", () => {
    const quoted = quoteGitPath("a b.ts");
    expect(quoted).toBe('"a b.ts"');
    expect(unquoteGitPath(quoted)).toBe("a b.ts");
  });

  it("escapes control bytes as octal, never JSON \\u", () => {
    const quoted = quoteGitPath("x\x01y");
    expect(quoted).toContain("\\001");
    expect(quoted).not.toContain("\\u");
    expect(unquoteGitPath(quoted)).toBe("x\x01y");
  });
});
