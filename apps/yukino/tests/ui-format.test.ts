import { stripVTControlCharacters } from "node:util";

import { describe, expect, it } from "vitest";

import {
  expandTabs,
  plainTerminalLine,
  visibleWidth,
  wrapToLines,
  wrapWordsToLines,
} from "@yukino.js/ui/terminal-text.js";
import { formatToolOutputPreview } from "@yukino.js/ui/tool-preview.js";
import { plainTerminalText } from "@yukino.js/utils";

describe("UI v2 tool previews", () => {
  it.each([
    ["\t\tcode", "    code"],
    ["a\tb\tc", "a b c"],
    ["ab\tc\n\tx", "ab  c\n  x"],
    ["日\tx\te\u0301\tz", "日  x e\u0301 z"],
    ["  code", "  code"],
  ])("expands %j at two-column stops", (source, expected) => {
    expect(expandTabs(source)).toBe(expected);
  });

  it("expands styled tabs before wrapping and single-line normalization", () => {
    const source = "\x1b[31ma\x1b[0m\tb";
    for (const wrap of [wrapToLines, wrapWordsToLines]) {
      expect(wrap(source, 20).map(stripVTControlCharacters)).toEqual(["a b"]);
    }
    expect(wrapToLines("\txy", 3)).toEqual(["  x", "y"]);
    expect(plainTerminalLine("\tfirst\n\tsecond")).toBe("  first   second");
  });

  it("removes raw terminal controls and expands tabs before wrapping", () => {
    const source =
      "\x1b[2J\x1b]52;c;clipboard\x07\x1b[31mhello\x1b[0m\0\tworld\r\nnext";
    const preview = stripVTControlCharacters(
      formatToolOutputPreview("ReadFile", source, 10),
    );
    expect(preview).not.toContain("clipboard");
    expect(preview).not.toContain("\x1b");
    expect(preview).not.toContain("\0");
    expect(preview).not.toContain("\t");
    expect(preview).toContain("hello");
    expect(preview.split("\n").every((line) => visibleWidth(line) <= 10)).toBe(
      true,
    );
    expect(plainTerminalText(source)).toBe("hello\tworld\nnext");
  });

  it("shows the tail of shell output", () => {
    const output = Array.from(
      { length: 8 },
      (_, index) => `line ${String(index + 1)}`,
    ).join("\n");
    const preview = formatToolOutputPreview("Bash", output);
    expect(preview).not.toContain("line 1\n");
    expect(preview).toContain("line 8");
    expect(preview).toContain("3 more lines, Ctrl+O to expand");
  });

  it("allows larger grep previews", () => {
    const output = Array.from(
      { length: 16 },
      (_, index) => `match ${String(index + 1)}`,
    ).join("\n");
    const preview = formatToolOutputPreview("Grep", output);
    expect(preview).toContain("match 1");
    expect(preview).toContain("1 more lines, Ctrl+O to expand");
  });
});
