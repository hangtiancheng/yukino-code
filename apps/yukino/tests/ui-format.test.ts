import { describe, expect, it } from "vitest";

import { formatToolOutputPreview } from "@/ui/tool-preview.js";

describe("UI v2 tool previews", () => {
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
