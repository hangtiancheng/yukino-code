// Cache breakpoint placement.
//
// Expected behavior: the breakpoint lands on the last non-deferred tool. A tool carrying
// both defer_loading and cache_control causes the API to reject the entire request,
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
    // Built-in tools are never deferred, so this is a defensive branch: skip caching
    // rather than place the breakpoint on a deferred tool
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
