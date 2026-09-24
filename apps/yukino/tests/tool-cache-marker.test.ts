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

// Cache breakpoint placement.
//
// Expected behavior: the breakpoint lands on the last non-deferred tool. A tool carrying
// both defer_loading and cache_control causes the API to reject the entire request (400),
// and MCP tools are registered after built-in tools, so the array tail is often a deferred
// tool — we cannot simply mark the last element.
import { describe, it, expect } from "vitest";

import { markToolsForCache } from "@/llm/anthropic.js";
import type { ToolSchema } from "@/tools/types.js";

function marked(tools: ToolSchema[]): string[] {
  return tools.filter((t) => t.cache_control !== undefined).map((t) => t.name);
}
const rest: Omit<ToolSchema, "name"> = {
  description: "",
  input_schema: {
    type: "object",
    properties: {},
  },
};
describe("cache breakpoint placement", () => {
  it("scans backwards when the tail is a deferred tool", () => {
    const tools: ToolSchema[] = [
      { name: "ReadFile", ...rest },
      { name: "WriteFile", ...rest },
      { name: "ToolSearch", ...rest },
      { name: "mcp__linear__create_issue", defer_loading: true, ...rest },
      { name: "mcp__sentry__resolve", defer_loading: true, ...rest },
    ];
    markToolsForCache(tools);
    expect(marked(tools)).toEqual(["ToolSearch"]);
  });

  it("marks the last tool when none are deferred", () => {
    const tools: ToolSchema[] = [
      { name: "ReadFile", ...rest },
      { name: "Bash", ...rest },
    ];
    markToolsForCache(tools);
    expect(marked(tools)).toEqual(["Bash"]);
  });

  it("skips deferred tools interleaved in the middle", () => {
    const tools: ToolSchema[] = [
      { name: "Bash", ...rest },
      { name: "mcp__a__x", defer_loading: true, ...rest },
      { name: "Grep", ...rest },
      { name: "mcp__z__y", defer_loading: true, ...rest },
    ];
    markToolsForCache(tools);
    expect(marked(tools)).toEqual(["Grep"]);
  });

  it("marks nothing when all tools are deferred", () => {
    // The API requires at least one non-deferred tool; in practice built-in tools are
    // never deferred, so this is a defensive branch: skip caching rather than emit a
    // request that would be rejected with 400
    const tools: ToolSchema[] = [
      { name: "mcp__a__x", defer_loading: true, ...rest },
      { name: "mcp__b__y", defer_loading: true, ...rest },
    ];
    markToolsForCache(tools);
    expect(marked(tools)).toEqual([]);
  });

  it("does not throw on an empty array", () => {
    expect(() => {
      markToolsForCache([]);
    }).not.toThrow();
  });
});
