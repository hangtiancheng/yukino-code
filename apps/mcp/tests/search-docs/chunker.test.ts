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

import { CHUNK_OVERLAP, CHUNK_SIZE, splitMarkdown } from "@/tools/docs/chunker.js";

describe("splitMarkdown", () => {
  it("keeps a small document as a single chunk with its heading title", async () => {
    const chunks = await splitMarkdown("# One\nalpha\nbeta");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].title).toBe("One");
    expect(chunks[0].content).toContain("alpha");
  });

  it("splits large documents into chunks within the size budget", async () => {
    const md = Array.from(
      { length: 8 },
      (_, i) => `# Section ${String(i)}\n${"word ".repeat(120)}`,
    ).join("\n");
    const chunks = await splitMarkdown(md);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(CHUNK_SIZE);
    }
  });

  it("annotates chunks with the nearest heading title", async () => {
    const md = `# Alpha\n${"a ".repeat(400)}\n# Bravo\n${"b ".repeat(400)}`;
    const chunks = await splitMarkdown(md);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk maps to one of the two sections; order follows the document.
    const titles = chunks.map((c) => c.title);
    expect(titles[0]).toBe("Alpha");
    expect(titles[titles.length - 1]).toBe("Bravo");
    expect(new Set(titles)).toEqual(new Set(["Alpha", "Bravo"]));
  });

  it("carries the previous heading into continuation chunks (overlap-aware)", async () => {
    const md = `# Only Title\n${"text ".repeat(600)}`;
    const chunks = await splitMarkdown(md);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.title).toBe("Only Title");
    }
  });

  it("hard-splits pathological single lines", async () => {
    const chunks = await splitMarkdown("x".repeat(CHUNK_SIZE * 3));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(CHUNK_SIZE);
    }
  });

  it("returns no chunks for empty or whitespace-only content", async () => {
    expect(await splitMarkdown("")).toEqual([]);
    expect(await splitMarkdown("  \n  ")).toEqual([]);
  });

  it("uses an empty title for content without headings", async () => {
    const chunks = await splitMarkdown("plain text file");
    expect(chunks).toEqual([{ content: "plain text file", title: "" }]);
  });

  it("exposes sane constants", () => {
    expect(CHUNK_OVERLAP).toBeLessThan(CHUNK_SIZE);
  });
});
