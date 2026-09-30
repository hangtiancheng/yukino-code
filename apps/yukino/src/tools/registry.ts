import type {
  AnthropicToolSchema,
  McpLoadingMode,
  OpenAICompatToolSchema,
  OpenAIResponsesToolSchema,
  ProviderToolSchema,
  Tool,
  ToolProtocol,
  ToolSchema,
} from "./types.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private discovered = new Set<string>();

  /**
   * How MCP tools are loaded, written by mcp/strategy after connecting to the
   * server. ToolSearch relies on it to decide what to return, and
   * getAllSchemas relies on it to decide whether deferred tools ship with
   * defer_loading (native) or are omitted from tools[] entirely (dispatch).
   * It stays eager when there is no MCP, which behaves the same as no
   * deferral.
   */
  mcpLoadingMode: McpLoadingMode = "eager";

  /**
   * Whether to expose the search and dispatch tools to the model is computed once
   * by applyMode in mcp/strategy at session start. It is not recomputed each turn
   * based on "are there still deferred tools": tools may be disabled at runtime,
   * and recomputing would drop one from tools[] mid-session — that's an array
   * change, which breaks the cache prefix just the same.
   */
  exposeToolSearch = false;
  exposeMcpCall = false;

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Removes a tool and forgets its discovery state, so a re-registered tool
   * with the same name starts deferred again. Used by /mcp reload to drop
   * tools of servers that disappeared from the config.
   */
  unregister(name: string): void {
    this.tools.delete(name);
    this.discovered.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Look up a tool and narrow it to a concrete class via instanceof. */
  getInstanceOf<T extends Tool>(
    name: string,
    ctor: abstract new (...args: never[]) => T,
  ): T | undefined {
    const tool = this.tools.get(name);
    return tool instanceof ctor ? tool : undefined;
  }

  listTools(): Tool[] {
    return [...this.tools.values()];
  }

  getAllSchemas(): ToolSchema[];
  getAllSchemas(
    protocol: "anthropic",
    filter?: (name: string) => boolean,
  ): AnthropicToolSchema[];
  getAllSchemas(
    protocol: "openai",
    filter?: (name: string) => boolean,
  ): OpenAIResponsesToolSchema[];
  getAllSchemas(
    protocol: "openai-compat",
    filter?: (name: string) => boolean,
  ): OpenAICompatToolSchema[];
  getAllSchemas(
    protocol: ToolProtocol,
    filter?: (name: string) => boolean,
  ): ProviderToolSchema[];
  getAllSchemas(
    protocol?: ToolProtocol,
    filter?: (name: string) => boolean,
  ): ProviderToolSchema[] {
    const resolvedProtocol = protocol ?? "anthropic";
    const isOpenAI =
      resolvedProtocol === "openai" || resolvedProtocol === "openai-compat";
    // Native deferral (strategy picks it for official endpoints): tools stay
    // in tools[] flagged with defer_loading, and the server decides whether to
    // show them to the model. This keeps the tools array byte-identical even
    // when new tools are discovered. defer_loading/tool_reference is not part
    // of the OpenAI protocols, so !isOpenAI forces the alternative path — hide
    // deferred tools entirely and fall back on McpCall.
    const native = this.mcpLoadingMode === "native" && !isOpenAI;

    const schemas: ProviderToolSchema[] = [];
    for (const tool of this.tools.values()) {
      if (!this.isToolVisible(tool, native, filter)) {
        continue;
      }
      const deferred =
        Boolean(tool.deferred) && !this.discovered.has(tool.name);
      const s = tool.schema();
      if (resolvedProtocol === "openai") {
        schemas.push({
          strict: s.strict ?? false,
          type: "function",
          name: s.name,
          description: s.description,
          parameters: s.input_schema,
        });
      } else if (resolvedProtocol === "openai-compat") {
        schemas.push({
          type: "function",
          function: {
            name: s.name,
            description: s.description,
            parameters: s.input_schema,
            strict: s.strict ?? false,
          },
        });
      } else {
        schemas.push({
          ...s,
          type: "custom",
          ...(deferred ? { defer_loading: true } : {}),
        });
      }
    }
    return schemas;
  }

  /**
   * Shared visibility predicate for getAllSchemas and listVisibleToolNames:
   * the caller's filter, the search/dispatch exposure rules, and deferred
   * hiding must agree everywhere tools are advertised.
   */
  private isToolVisible(
    tool: Tool,
    native: boolean,
    filter?: (name: string) => boolean,
  ): boolean {
    if (filter && !filter(tool.name)) {
      return false;
    }
    // Only expose search and dispatch in modes where they're useful. In eager
    // mode there are no deferred tools to search and no need to dispatch; sending
    // both would only waste tokens and might tempt the model into a detour.
    if (
      (tool.name === "ToolSearch" && !this.exposeToolSearch) ||
      (tool.name === "McpCall" && !this.exposeMcpCall)
    ) {
      return false;
    }
    const deferred = Boolean(tool.deferred) && !this.discovered.has(tool.name);
    return !deferred || native;
  }

  /**
   * Names of the tools getAllSchemas would emit for the same protocol and
   * filter — identical visibility rules, so anything that advertises
   * "available tools" (e.g. the compaction recovery attachment) matches what
   * the run can actually call.
   */
  listVisibleToolNames(
    protocol?: ToolProtocol,
    filter?: (name: string) => boolean,
  ): string[] {
    const resolvedProtocol = protocol ?? "anthropic";
    const isOpenAI =
      resolvedProtocol === "openai" || resolvedProtocol === "openai-compat";
    const native = this.mcpLoadingMode === "native" && !isOpenAI;
    const names: string[] = [];
    for (const tool of this.tools.values()) {
      if (this.isToolVisible(tool, native, filter)) {
        names.push(tool.name);
      }
    }
    return names;
  }

  /**
   * Names of deferred tools not yet discovered, in lexicographic order.
   *
   * Sorting is not cosmetic: callers compare this list to detect pool changes;
   * unstable ordering would produce different text for the same set of tools
   * and break the comparison.
   */
  getDeferredToolNames(): string[] {
    const names: string[] = [];
    for (const tool of this.tools.values()) {
      if (tool.deferred && !this.discovered.has(tool.name)) {
        names.push(tool.name);
      }
    }
    return names.sort();
  }

  getDeferredTools(): Tool[] {
    return [...this.tools.values()].filter(
      (t) => t.deferred && !this.discovered.has(t.name),
    );
  }

  searchDeferred(query: string, maxResults = 5): Tool[] {
    const lower = query.toLowerCase();
    const matches: Tool[] = [];
    for (const tool of this.tools.values()) {
      if (!tool.deferred || this.discovered.has(tool.name)) {
        continue;
      }
      if (
        tool.name.toLowerCase().includes(lower) ||
        tool.description.toLowerCase().includes(lower)
      ) {
        matches.push(tool);
        if (matches.length >= maxResults) {
          break;
        }
      }
    }
    return matches;
  }

  findDeferredByNames(names: string[]): Tool[] {
    const lowerMap = new Map<string, Tool>();
    for (const [name, tool] of this.tools) {
      lowerMap.set(name.toLowerCase(), tool);
    }
    return names
      .map((n) => lowerMap.get(n.toLowerCase()))
      .filter((t): t is Tool => t?.deferred ?? false);
  }

  markDiscovered(name: string): void {
    this.discovered.add(name);
  }

  isDiscovered(name: string): boolean {
    return this.discovered.has(name);
  }
}
