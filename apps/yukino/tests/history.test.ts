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

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { append, load, MAX_HISTORY_ENTRIES } from "@/history/index.js";

describe("prompt history", () => {
  it("keeps the in-memory return value and file bounded", () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-history-"));
    let retained: string[] = [];

    for (let index = 0; index < 250; index++) {
      retained = append(dir, `prompt-${String(index)}`);
    }

    expect(retained).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(retained[0]).toBe("prompt-50");
    expect(retained.at(-1)).toBe("prompt-249");
    expect(load(dir)).toEqual(retained);
    expect(
      readFileSync(join(dir, "prompt_history.jsonl"), "utf-8")
        .trim()
        .split("\n"),
    ).toHaveLength(MAX_HISTORY_ENTRIES);
  });

  it("filters malformed and empty entries while loading", () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-history-"));
    writeFileSync(
      join(dir, "prompt_history.jsonl"),
      ['{"text":"first"}', "not-json", '{"text":""}', '{"text":"last"}'].join(
        "\n",
      ),
      "utf-8",
    );

    expect(load(dir)).toEqual(["first", "last"]);
  });

  it("deduplicates the latest prompt and rewrites legacy oversized files", () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-history-"));
    const filePath = join(dir, "prompt_history.jsonl");
    const legacy = Array.from({ length: 250 }, (_, index) =>
      JSON.stringify({ text: `prompt-${String(index)}` }),
    );
    writeFileSync(filePath, legacy.join("\n") + "\n", "utf-8");

    const retained = append(dir, "prompt-249");

    expect(retained).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(retained.at(-1)).toBe("prompt-249");
    expect(readFileSync(filePath, "utf-8").trim().split("\n")).toHaveLength(
      MAX_HISTORY_ENTRIES,
    );
  });
});
