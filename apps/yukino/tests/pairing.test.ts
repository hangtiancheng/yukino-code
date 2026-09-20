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

import { describe, it, expect } from "vitest";

import type { Message } from "@/conversation/index.js";
import { ensureToolPairing, INTERRUPTED_TOOL_RESULT } from "@/conversation/pairing.js";

function assistantWithTool(id: string): Message {
  return {
    role: "assistant",
    content: "let me check",
    toolUses: [{ toolUseId: id, toolName: "ReadFile", arguments: {} }],
  };
}

function resultFor(id: string, content: string): Message {
  return {
    role: "user",
    content: "",
    toolResults: [{ toolUseId: id, content, isError: false }],
  };
}

describe("ensureToolPairing", () => {
  it("leaves a fully paired history alone", () => {
    const got = ensureToolPairing([
      { role: "user", content: "hi" },
      assistantWithTool("t1"),
      resultFor("t1", "content"),
    ]);
    expect(got).toHaveLength(3);
    expect(got[2].toolResults?.[0].content).toBe("content");
  });

  it("fills a dangling tool_use with an error result", () => {
    const got = ensureToolPairing([{ role: "user", content: "hi" }, assistantWithTool("t1")]);
    expect(got).toHaveLength(3);
    const filled = got[2].toolResults?.[0];
    expect(filled?.toolUseId).toBe("t1");
    expect(filled?.isError).toBe(true);
    expect(filled?.content).toBe(INTERRUPTED_TOOL_RESULT);
  });

  it("drops an orphan tool_result", () => {
    const got = ensureToolPairing([
      { role: "user", content: "hi" },
      resultFor("ghost", "leftover"),
      { role: "assistant", content: "ok" },
    ]);
    expect(got).toHaveLength(2);
    for (const m of got) {
      for (const tr of m.toolResults ?? []) {
        expect(tr.toolUseId).not.toBe("ghost");
      }
    }
  });

  it("does not fill the same tool_use twice", () => {
    const got = ensureToolPairing([
      assistantWithTool("t1"),
      { role: "assistant", content: "still going" },
    ]);
    const count = got
      .flatMap((m) => m.toolResults ?? [])
      .filter((tr) => tr.toolUseId === "t1").length;
    expect(count).toBe(1);
  });
});
