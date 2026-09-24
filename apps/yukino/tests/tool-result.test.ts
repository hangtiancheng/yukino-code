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

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import type { ToolResultBlock } from "@/conversation/index.js";
import {
  applyBudget,
  isSpillReadback,
  persistLargeResult,
} from "@/tool-result/index.js";
function batch(...sizes: number[]): ToolResultBlock[] {
  return sizes.map((n, i) => ({
    toolUseId: `t${String(i + 1)}`,
    content: "x".repeat(n),
    isError: false,
  }));
}

function totalLen(rs: ToolResultBlock[]): number {
  return rs.reduce((sum, r) => sum + r.content.length, 0);
}

describe("tool result budget", () => {
  it("leaves an under-limit batch untouched", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-tr-"));
    const rs = batch(40000, 40000);

    applyBudget(rs, workDir, "s");

    expect(rs[0].content).toBe("x".repeat(40000));
    expect(rs[1].content).toBe("x".repeat(40000));
  });

  it("spills the largest results until aggregate is within limit", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-tr-"));
    // 5 results totaling 225K+1; spilling only the largest, t3, is enough to get back within the limit
    const rs = batch(45000, 45000, 45001, 45000, 45000);

    applyBudget(rs, workDir, "s");

    expect(totalLen(rs)).toBeLessThanOrEqual(200000);
    const replaced = rs.filter((result) =>
      result.content.includes("<persisted-output>"),
    );
    expect(replaced.length).toBe(1);
    expect(rs[2].content).toContain("<persisted-output>");
    // The spill file stores the complete content
    const spilled = readFileSync(
      join(workDir, ".yukino", "sessions", "s", "tool-results", "t3.txt"),
      "utf-8",
    );
    expect(spilled.length).toBe(45001);
  });

  it("skips exempt ids and spills the next largest instead", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-tr-"));
    const rs = batch(45000, 45000, 45001, 45000, 45000);

    applyBudget(rs, workDir, "s", new Set(["t3"]));

    expect(rs[2].content).toBe("x".repeat(45001));
    expect(totalLen(rs)).toBeLessThanOrEqual(200000);
  });

  it("accepts overage when everything is exempt", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-tr-"));
    const rs = batch(105000, 105000);

    applyBudget(rs, workDir, "s", new Set(["t1", "t2"]));

    expect(rs[0].content).toBe("x".repeat(105000));
    expect(rs[1].content).toBe("x".repeat(105000));
  });

  it("produces byte-identical output for identical input", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-tr-"));
    const rs1 = batch(45000, 45000, 45001, 45000, 45000);
    const rs2 = batch(45000, 45000, 45001, 45000, 45000);

    applyBudget(rs1, workDir, "s");
    applyBudget(rs2, workDir, "s");

    for (let i = 0; i < rs1.length; i++) {
      expect(rs2[i].content).toBe(rs1[i].content);
    }
  });

  it("is a no-op on an already-processed batch", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-tr-"));
    const rs = batch(45000, 45000, 45001, 45000, 45000);
    applyBudget(rs, workDir, "s");
    const snapshot = rs.map((r) => r.content);

    applyBudget(rs, workDir, "s");

    expect(rs.map((r) => r.content)).toEqual(snapshot);
  });

  it("spills rich text while preserving non-text blocks", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-tr-"));
    const result: ToolResultBlock = {
      toolUseId: "rich",
      content: "x".repeat(250_000),
      contentBlocks: [
        { type: "text", text: "x".repeat(250_000) },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "QUJD" },
        },
      ],
      isError: false,
    };

    applyBudget([result], workDir, "s");

    expect(result.content).toContain("<persisted-output>");
    expect(result.contentBlocks?.[0]).toEqual({
      type: "text",
      text: result.content,
    });
    expect(result.contentBlocks?.[1]?.type).toBe("image");
    expect(
      readFileSync(
        join(workDir, ".yukino", "sessions", "s", "tool-results", "rich.txt"),
        "utf-8",
      ),
    ).toHaveLength(250_000);
  });

  it("detects spill readbacks", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-tr-"));
    const inside = join(
      workDir,
      ".yukino",
      "sessions",
      "s",
      "tool-results",
      "toolu_abc.txt",
    );
    const outside = join(workDir, "main.ts");

    expect(
      isSpillReadback("ReadFile", { file_path: inside }, workDir, "s"),
    ).toBe(true);
    expect(
      isSpillReadback("ReadFile", { file_path: outside }, workDir, "s"),
    ).toBe(false);
    expect(isSpillReadback("Bash", { file_path: inside }, workDir, "s")).toBe(
      false,
    );
    expect(isSpillReadback("ReadFile", {}, workDir, "s")).toBe(false);
  });

  it("persistLargeResult round-trips deterministically", () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-tr-"));
    const content = "y".repeat(60000);

    const preview = persistLargeResult(workDir, "s", "t_big", content);

    expect(preview).toContain("<persisted-output>");
    expect(preview).toContain("saved to");
    const spilled = readFileSync(
      join(workDir, ".yukino", "sessions", "s", "tool-results", "t_big.txt"),
      "utf-8",
    );
    expect(spilled.length).toBe(60000);
    // A second call (the file already exists) returns a byte-identical preview
    expect(persistLargeResult(workDir, "s", "t_big", content)).toBe(preview);
  });
});
