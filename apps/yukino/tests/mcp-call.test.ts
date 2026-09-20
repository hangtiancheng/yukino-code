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

import { describe, expect, test } from "vitest";

import { needsToolSearchBeta } from "@/llm/anthropic.js";
import {
  applyMode,
  decideMode,
  isOfficialAnthropicEndpoint,
  measureSchemaChars,
} from "@/mcp/strategy.js";
import { buildMcpToolName, mcpToolNamePrefix } from "@/mcp/tool-wrapper.js";
import { extractContent } from "@/permissions/index.js";
import { McpCallTool, coerceBySchema, mcpCallPermissionContent } from "@/tools/mcp-call.js";
import { ToolRegistry } from "@/tools/registry.js";
import { ToolSearchTool } from "@/tools/tool-search.js";
import type {
  McpLoadingMode,
  MCPToolLike,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@/tools/types.js";
import { asRecord, strArg } from "@/utils/index.js";

const toolContext: ToolContext = { workDir: process.cwd() };

const inputSchema: ToolSchema["input_schema"] = {
  type: "object",
  properties: {
    issueId: { type: "string" },
    limit: { type: "integer" },
    ratio: { type: "number" },
    flag: { type: "boolean" },
    labels: { type: "array", items: { type: "string" } },
    ports: { type: "array", items: { type: "integer" } },
    config: {
      type: "object",
      properties: {
        replicas: { type: "integer" },
        features: { type: "array", items: { type: "string" } },
      },
    },
  },
};

const toolSchema: ToolSchema = {
  name: "",
  description: "",
  input_schema: inputSchema,
};

/** A good-enough MCP tool stand-in: exposes its schema and records received arguments. */
class FakeMcpTool implements MCPToolLike {
  name: string;
  description = "fake";
  category = "command" as const;
  deferred = true;
  mcpServerName: string;
  received: Record<string, unknown> | null = null;

  constructor(
    server: string,
    tool: string,
    private schemaObj: ToolSchema["input_schema"] = {
      type: "object" as const,
      properties: {},
    },
  ) {
    this.name = buildMcpToolName(server, tool);
    this.mcpServerName = server;
  }

  mcpInputSchema(): Record<string, unknown> {
    return this.schemaObj;
  }

  setDeferLoading(on: boolean): void {
    this.deferred = on;
  }

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.schemaObj,
    };
  }

  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    this.received = args;
    return Promise.resolve({ output: "ok", isError: false });
  }
}

// Coercion contract: these cases must match verbatim across all four languages
describe("coerceBySchema contract", () => {
  const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["string ← integer", { issueId: 8891 }, { issueId: "8891" }],
    ["string ← float", { issueId: 1.5 }, { issueId: "1.5" }],
    ["integer ← numeric string", { limit: "5" }, { limit: 5 }],
    ["number ← numeric string with whitespace", { ratio: " 1.5 " }, { ratio: 1.5 }],
    ["boolean ← true", { flag: "true" }, { flag: true }],
    ["boolean ← uppercase FALSE", { flag: "FALSE" }, { flag: false }],
    [
      "array ← single-key object unwrapped",
      { labels: { item: ["a", "b"] } },
      { labels: ["a", "b"] },
    ],
    ["array ← comma-separated string", { labels: "a, b" }, { labels: ["a", "b"] }],
    ["array recurses through items", { ports: ["8080", "9090"] }, { ports: [8080, 9090] }],
    [
      "object recurses through properties, including nested levels",
      { config: { replicas: "4", features: { item: ["x"] } } },
      { config: { replicas: 4, features: ["x"] } },
    ],
  ];
  for (const [desc, given, want] of cases) {
    test(desc, () => {
      expect(coerceBySchema(given, inputSchema)).toEqual(want);
    });
  }

  test("boolean is not treated as a number and stringified", () => {
    expect(coerceBySchema({ issueId: true }, inputSchema)).toEqual({
      issueId: true,
    });
  });

  test("values that cannot be coerced are passed through, letting the MCP server report its own error", () => {
    expect(coerceBySchema({ limit: "many" }, inputSchema)).toEqual({
      limit: "many",
    });
    expect(coerceBySchema({ flag: "yes" }, inputSchema)).toEqual({
      flag: "yes",
    });
    expect(coerceBySchema({ limit: "5abc" }, inputSchema)).toEqual({
      limit: "5abc",
    });
  });

  // String-to-number leniency differs per language; these cases pin down shapes all four languages reject
  test("integer does not truncate floats, nor accept underscores or exponents", () => {
    expect(coerceBySchema({ limit: "5.7" }, inputSchema)).toEqual({
      limit: "5.7",
    });
    expect(coerceBySchema({ limit: "1_000" }, inputSchema)).toEqual({
      limit: "1_000",
    });
    expect(coerceBySchema({ limit: "1e3" }, inputSchema)).toEqual({
      limit: "1e3",
    });
    expect(coerceBySchema({ limit: "+5" }, inputSchema)).toEqual({ limit: 5 });
  });

  test("number accepts exponents but not inf / nan", () => {
    expect(coerceBySchema({ ratio: "1e3" }, inputSchema)).toEqual({
      ratio: 1000,
    });
    expect(coerceBySchema({ ratio: "inf" }, inputSchema)).toEqual({
      ratio: "inf",
    });
    expect(coerceBySchema({ ratio: "nan" }, inputSchema)).toEqual({
      ratio: "nan",
    });
  });

  test("array given a multi-key object does not guess and passes it through", () => {
    const given = { labels: { item: "metrics", tracing: "" } };
    expect(coerceBySchema(given, inputSchema)).toEqual(given);
  });

  test("keys not present in the schema are left untouched", () => {
    expect(coerceBySchema({ extra: 1 }, inputSchema)).toEqual({ extra: 1 });
  });

  test("already-correct arguments are left untouched", () => {
    const good = { issueId: "X-1", limit: 3, flag: false, ports: [1, 2] };
    expect(coerceBySchema(good, inputSchema)).toEqual(good);
  });

  test("empty schema is a no-op", () => {
    expect(coerceBySchema({ a: "1" }, {})).toEqual({ a: "1" });
  });
});

describe("McpCall tool name resolution", () => {
  function setup() {
    const registry = new ToolRegistry();
    registry.mcpLoadingMode = "dispatch";
    const tool = new FakeMcpTool("linear", "create_issue", inputSchema);
    registry.register(tool);
    const dispatcher = new McpCallTool(registry);
    registry.register(dispatcher);
    return { registry, dispatcher, tool };
  }

  test("fully qualified name", async () => {
    const { dispatcher, tool } = setup();
    const res = await dispatcher.execute(toolContext, {
      server: "linear",
      tool: "mcp__linear__create_issue",
      arguments: { issueId: "A" },
    });
    expect(res.isError).toBe(false);
    expect(tool.received).toEqual({ issueId: "A" });
  });

  // Models very often pass only the short name (~30% of observed calls); this must be
  // tolerated, otherwise we waste an extra retry round-trip
  test("server + short name", async () => {
    const { dispatcher, tool } = setup();
    const res = await dispatcher.execute(toolContext, {
      server: "linear",
      tool: "create_issue",
      arguments: { issueId: "A" },
    });
    expect(res.isError).toBe(false);
    expect(tool.received).toEqual({ issueId: "A" });
  });

  test("rejects a server mismatch even for a fully qualified target", async () => {
    const { dispatcher, tool } = setup();
    const result = await dispatcher.execute(toolContext, {
      server: "other",
      tool: tool.name,
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(tool.received).toBeNull();
  });

  test("does not dispatch a built-in tool by name or recurse into itself", async () => {
    const { dispatcher, registry } = setup();
    registry.register(new ToolSearchTool(registry));
    for (const name of ["ToolSearch", "McpCall"]) {
      expect(
        (
          await dispatcher.execute(toolContext, {
            server: "linear",
            tool: name,
            arguments: {},
          })
        ).isError,
      ).toBe(true);
    }
  });

  test("does not reroute a misspelled server outside the checked permission scope", async () => {
    const { dispatcher, tool } = setup();
    const res = await dispatcher.execute(toolContext, {
      server: "typo",
      tool: "create_issue",
      arguments: { issueId: "A" },
    });
    expect(res.isError).toBe(true);
    expect(tool.received).toBeNull();
  });

  test("ambiguous suffix errors out and lists the available tools", async () => {
    const registry = new ToolRegistry();
    registry.register(new FakeMcpTool("linear", "create_issue"));
    registry.register(new FakeMcpTool("jira", "create_issue"));
    const dispatcher = new McpCallTool(registry);
    const res = await dispatcher.execute(toolContext, {
      server: "nope",
      tool: "create_issue",
      arguments: {},
    });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("mcp__linear__create_issue");
  });

  test("coerces arguments against the schema before forwarding", async () => {
    const { dispatcher, tool } = setup();
    await dispatcher.execute(toolContext, {
      server: "linear",
      tool: "create_issue",
      arguments: { issueId: 8891, ports: ["1"] },
    });
    expect(tool.received).toEqual({ issueId: "8891", ports: [1] });
  });
});

describe("three-way routing", () => {
  test("official endpoint detection", () => {
    expect(isOfficialAnthropicEndpoint("")).toBe(true);
    expect(isOfficialAnthropicEndpoint("https://api.anthropic.com")).toBe(true);
    expect(isOfficialAnthropicEndpoint("https://api.minimaxi.com/anthropic")).toBe(false);
  });

  test("small schema size loads everything eagerly", () => {
    expect(decideMode("https://proxy.example.com", 200000, 1000)).toBe("eager");
  });

  test("no MCP tools at all also loads eagerly", () => {
    expect(decideMode("https://proxy.example.com", 200000, 0)).toBe("eager");
  });

  test("official endpoint uses native deferred loading", () => {
    expect(decideMode("", 200000, 500000)).toBe("native");
  });

  test("third-party endpoint uses McpCall dispatch", () => {
    expect(decideMode("https://api.minimaxi.com/anthropic", 200000, 500000)).toBe("dispatch");
  });

  test("only MCP tools count toward schema size", () => {
    const registry = new ToolRegistry();
    expect(measureSchemaChars(registry)).toBe(0);
    registry.register(new FakeMcpTool("linear", "create_issue", inputSchema));
    expect(measureSchemaChars(registry)).toBeGreaterThan(0);
  });
});

describe("applyMode effect on tools[]", () => {
  function mcpSchemas(registry: ToolRegistry) {
    return registry.getAllSchemas("anthropic").filter((s) => s.name.startsWith("mcp__"));
  }

  test("eager: included in the array without defer_loading", () => {
    const registry = new ToolRegistry();
    registry.register(new FakeMcpTool("linear", "create_issue", inputSchema));
    applyMode(registry, "eager");
    const mcp = mcpSchemas(registry);
    expect(mcp).toHaveLength(1);
    expect(mcp[0].defer_loading).toBeUndefined();
  });

  test("native: included in the array with defer_loading", () => {
    const registry = new ToolRegistry();
    registry.register(new FakeMcpTool("linear", "create_issue", inputSchema));
    applyMode(registry, "native");
    const mcp = mcpSchemas(registry);
    expect(mcp).toHaveLength(1);
    expect(mcp[0].defer_loading).toBe(true);
  });

  test("dispatch: excluded from the array entirely", () => {
    const registry = new ToolRegistry();
    registry.register(new FakeMcpTool("linear", "create_issue", inputSchema));
    applyMode(registry, "dispatch");
    expect(mcpSchemas(registry)).toHaveLength(0);
  });

  test("openai protocol does not leak defer_loading", () => {
    // defer_loading is an Anthropic-only field
    const registry = new ToolRegistry();
    registry.register(new FakeMcpTool("linear", "create_issue", inputSchema));
    applyMode(registry, "native");
    const names = registry.getAllSchemas("openai").map((s) => {
      const fn: unknown = Reflect.get(s, "function");
      return strArg(asRecord(fn), "name");
    });
    expect(names.some((n) => n.startsWith("mcp__"))).toBe(false);
  });
});

describe("permission content normalization", () => {
  const cases: [string, string, string][] = [
    ["linear", "mcp__linear__create_issue", "linear__create_issue"],
    ["linear", "create_issue", "linear__create_issue"],
    ["chrome-2", "mcp__chrome_2__click", "chrome_2__click"],
    // Short name and fully qualified name must produce the same content,
    // otherwise permission rules would fail to match
    ["chrome-devtools", "click", "chrome_devtools__click"],
    ["chrome-devtools", "mcp__chrome_devtools__click", "chrome_devtools__click"],
  ];
  for (const [server, tool, want] of cases) {
    test(`${server} + ${tool}`, () => {
      expect(mcpCallPermissionContent(server, tool)).toBe(want);
    });
  }

  test("extractContent routes McpCall to the normalization logic", () => {
    expect(
      extractContent("McpCall", {
        server: "linear",
        tool: "mcp__linear__create_issue",
      }),
    ).toBe("linear__create_issue");
  });

  test("content extraction for other tools is unchanged", () => {
    expect(extractContent("Bash", { command: "ls" })).toBe("ls");
    expect(extractContent("mcp__linear__create_issue", { title: "x" })).toBe("");
  });
});

// Gate for the beta header: send it only when some tool actually carries defer_loading.
//
// The official-endpoint path cannot be verified against third-party endpoints in the wild,
// so we pin down exactly what the request must look like: a missing header makes the server
// reject defer_loading outright, while sending it to an endpoint that does not recognize it
// gets rejected just the same.
describe("beta header for native deferred loading", () => {
  test("no tools", () => {
    expect(needsToolSearchBeta([])).toBe(false);
  });

  test("no tool is deferred", () => {
    expect(
      needsToolSearchBeta([
        { ...toolSchema, name: "Bash" },
        { ...toolSchema, name: "ToolSearch" },
      ]),
    ).toBe(false);
  });

  test("one tool carries defer_loading", () => {
    expect(
      needsToolSearchBeta([
        { ...toolSchema, name: "Bash" },
        { ...toolSchema, name: "mcp__linear__x", defer_loading: true },
      ]),
    ).toBe(true);
  });

  test("defer_loading set to false does not count", () => {
    expect(needsToolSearchBeta([{ ...toolSchema, name: "x", defer_loading: false }])).toBe(false);
  });
});

describe("tool naming", () => {
  test("double underscore separator", () => {
    expect(buildMcpToolName("linear", "create_issue")).toBe("mcp__linear__create_issue");
  });

  test("hyphens and dots become underscores, consistent with Go/Python", () => {
    expect(buildMcpToolName("chrome-devtools", "take.snapshot")).toBe(
      "mcp__chrome_devtools__take_snapshot",
    );
  });

  test("the prefix helper matches the composed name", () => {
    expect(buildMcpToolName("chrome-2", "click").startsWith(mcpToolNamePrefix("chrome-2"))).toBe(
      true,
    );
  });
});

// Search and dispatch tools are only sent to the model in modes that need them. In eager
// mode every MCP tool is already in tools[], so there is nothing to search and no dispatch
// entry point needed — sending both would just waste tokens.
describe("per-mode tool selection", () => {
  function names(mode: McpLoadingMode): string[] {
    const registry = new ToolRegistry();
    registry.register(new ToolSearchTool(registry));
    registry.register(new McpCallTool(registry));
    registry.register(new FakeMcpTool("linear", "create_issue", inputSchema));
    applyMode(registry, mode);
    return registry
      .getAllSchemas("anthropic")
      .map((s) => s.name)
      .sort();
  }

  test("eager: neither is sent", () => {
    expect(names("eager")).toEqual(["mcp__linear__create_issue"]);
  });

  test("native: only ToolSearch is sent", () => {
    expect(names("native")).toEqual(["ToolSearch", "mcp__linear__create_issue"]);
  });

  test.each(["select:mcp__linear__create_issue", "fake"])(
    "native ToolSearch returns references for %s",
    async (query) => {
      const registry = new ToolRegistry();
      const tool = new FakeMcpTool("linear", "create_issue", inputSchema);
      registry.register(tool);
      applyMode(registry, "native");

      const result = await new ToolSearchTool(registry).execute(toolContext, {
        query,
      });

      expect(result.output).toContain(tool.name);
      expect(result.contentBlocks).toContainEqual({
        type: "tool_reference",
        tool_name: tool.name,
      });
    },
  );

  test("dispatch: both are sent, MCP tools are not", () => {
    expect(names("dispatch")).toEqual(["McpCall", "ToolSearch"]);
  });

  test("neither is sent when no MCP server is connected", () => {
    // applyMode is never called, so the toggles stay off by default
    const registry = new ToolRegistry();
    registry.register(new ToolSearchTool(registry));
    registry.register(new McpCallTool(registry));
    expect(registry.getAllSchemas("anthropic")).toHaveLength(0);
  });
});
