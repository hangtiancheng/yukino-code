import { describe, expect, test, vi } from "vitest";

import { needsToolSearchBeta } from "@/llm/anthropic.js";
import {
  applyMode,
  decideAndApply,
  decideMode,
  isOfficialAnthropicEndpoint,
} from "@/mcp/strategy.js";
import { buildMcpToolName, mcpToolNamePrefix } from "@/mcp/tool-wrapper.js";
import { extractContent } from "@/permissions/index.js";
import { McpCallTool, mcpCallPermissionContent } from "@/tools/mcp-call.js";
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

const toolContext: ToolContext = { cwd: process.cwd() };

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

const linearCreateIssue = buildMcpToolName("linear", "create_issue");
const jiraCreateIssue = buildMcpToolName("jira", "create_issue");
const chrome2Click = buildMcpToolName("chrome-2", "click");
const chromeDevtoolsClick = buildMcpToolName("chrome-devtools", "click");

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

  execute(
    _ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    this.received = args;
    return Promise.resolve({ output: "ok", isError: false });
  }
}

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
      tool: linearCreateIssue,
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
    expect(res.output).toContain(linearCreateIssue);
    expect(res.output).toContain(jiraCreateIssue);
  });

  test("rejects incorrectly typed arguments without forwarding", async () => {
    const { dispatcher, tool } = setup();
    const result = await dispatcher.execute(toolContext, {
      server: "linear",
      tool: "create_issue",
      arguments: { issueId: 8891, ports: ["1"] },
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Invalid MCP arguments");
    expect(tool.received).toBeNull();
  });
});

describe("three-way routing", () => {
  test("official endpoint detection", () => {
    expect(isOfficialAnthropicEndpoint("")).toBe(true);
    expect(isOfficialAnthropicEndpoint("https://api.anthropic.com")).toBe(true);
    expect(
      isOfficialAnthropicEndpoint("https://api.deepseek.com/anthropic"),
    ).toBe(false);
  });

  test("uses dispatch for explicitly deferred tools on a third-party endpoint", () => {
    expect(decideMode("https://proxy.example.com", "anthropic", true)).toBe(
      "dispatch",
    );
  });

  test("no MCP tools at all also loads eagerly", () => {
    expect(decideMode("https://proxy.example.com", "anthropic", false)).toBe(
      "eager",
    );
  });

  test("official endpoint with the anthropic protocol uses native deferred loading", () => {
    expect(decideMode("", "anthropic", true)).toBe("native");
  });

  test("openai-protocol providers never use native mode even on official-looking endpoints", () => {
    // Empty base_url under the openai protocol is the OpenAI SDK default
    // (api.openai.com), not an Anthropic endpoint; native mode would hide
    // every deferred MCP tool (tool_reference is dropped, McpCall hidden).
    expect(decideMode("", "openai", true)).toBe("dispatch");
    expect(decideMode("", "openai-compat", true)).toBe("dispatch");
  });

  test("provider switches adapt only the wire protocol, not user exposure", () => {
    const registry = new ToolRegistry();
    const tool = new FakeMcpTool("linear", "create_issue", inputSchema);
    registry.register(tool);
    expect(decideAndApply(registry, "", "openai")).toBe("dispatch");
    expect(registry.exposeMcpCall).toBe(true);
    expect(decideAndApply(registry, "", "anthropic")).toBe("native");
    expect(registry.exposeMcpCall).toBe(false);
    expect(tool.deferred).toBe(true);
  });

  test("third-party endpoint uses McpCall dispatch", () => {
    expect(
      decideMode("https://api.deepseek.com/anthropic", "anthropic", true),
    ).toBe("dispatch");
  });

  test("routes from exposure without serializing tool schemas", () => {
    const registry = new ToolRegistry();
    expect(decideAndApply(registry, "", "anthropic")).toBe("eager");
    const tool = new FakeMcpTool("linear", "create_issue", inputSchema);
    registry.register(tool);
    const schema = vi.spyOn(tool, "schema");
    expect(decideAndApply(registry, "", "anthropic")).toBe("native");
    expect(schema).not.toHaveBeenCalled();
  });
});

describe("applyMode effect on tools[]", () => {
  function mcpSchemas(registry: ToolRegistry) {
    return registry
      .getAllSchemas("anthropic")
      .filter((s) => s.name.startsWith("mcp__"));
  }

  test("eager wire mode cannot promote deferred tools to direct", () => {
    const registry = new ToolRegistry();
    registry.register(new FakeMcpTool("linear", "create_issue", inputSchema));
    applyMode(registry, "eager");
    expect(mcpSchemas(registry)).toHaveLength(0);
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
    ["linear", linearCreateIssue, "linear__create_issue"],
    ["linear", "create_issue", "linear__create_issue"],
    ["chrome-2", chrome2Click, "chrome_2__click"],
    // Short name and fully qualified name must produce the same content,
    // otherwise permission rules would fail to match
    ["chrome-devtools", "click", "chrome_devtools__click"],
    ["chrome-devtools", chromeDevtoolsClick, "chrome_devtools__click"],
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
        tool: linearCreateIssue,
      }),
    ).toBe("linear__create_issue");
  });

  test("content extraction for other tools is unchanged", () => {
    expect(extractContent("Bash", { command: "ls" })).toBe("ls");
    expect(extractContent(linearCreateIssue, { title: "x" })).toBe("");
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
        {
          ...toolSchema,
          name: buildMcpToolName("linear", "x"),
          defer_loading: true,
        },
      ]),
    ).toBe(true);
  });

  test("defer_loading set to false does not count", () => {
    expect(
      needsToolSearchBeta([{ ...toolSchema, name: "x", defer_loading: false }]),
    ).toBe(false);
  });
});

describe("tool naming", () => {
  test("double underscore separator", () => {
    expect(buildMcpToolName("linear", "create_issue")).toBe(
      "mcp__linear__create_issue",
    );
  });

  test("hyphens and dots become underscores, consistent with Go/Python", () => {
    expect(buildMcpToolName("chrome-devtools", "take.snapshot")).toBe(
      "mcp__chrome_devtools__take_snapshot",
    );
  });

  test("the prefix helper matches the composed name", () => {
    expect(
      buildMcpToolName("chrome-2", "click").startsWith(
        mcpToolNamePrefix("chrome-2"),
      ),
    ).toBe(true);
  });
});

// Provider adaptation must not promote user-configured deferred tools.
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

  test("eager: deferred tools still require search/dispatch", () => {
    expect(names("eager")).toEqual(["McpCall", "ToolSearch"]);
  });

  test("native: only ToolSearch is sent", () => {
    expect(names("native")).toEqual(["ToolSearch", linearCreateIssue]);
  });

  test.each([`select:${linearCreateIssue}`, "fake"])(
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
