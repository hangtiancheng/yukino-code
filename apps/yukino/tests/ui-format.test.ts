import { stripVTControlCharacters } from "node:util";

import { describe, expect, it } from "vitest";

import { visibleWidth, plainTerminalText } from "@/ui/terminal-text.js";
import { formatToolOutputPreview } from "@/ui/tool-preview.js";

describe("UI v2 tool previews", () => {
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
