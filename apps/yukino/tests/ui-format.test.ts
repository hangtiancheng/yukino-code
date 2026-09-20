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
