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

/**
 * Unified call entry point for MCP tools (dispatch mode only — see
 * mcp/strategy.ts for the eager/native modes, where MCP tools ship in tools[]
 * directly or stay there flagged with defer_loading).
 *
 * In dispatch mode MCP tools never enter tools[]. The model first reads the
 * schema via ToolSearch, then passes the tool name and arguments through
 * McpCall. This keeps the tools array byte-identical throughout the whole
 * session, so the prompt cache prefix is never broken — tools render after
 * system and before messages, so any change to the array forces the entire
 * trailing history to be recomputed.
 *
 * The trade-off is that arguments are generated freely by the model with no schema
 * constraint at the interface level, so the JSON type is occasionally wrong.
 * coerceBySchema fixes values level by level against the target tool's full schema.
 * The fix-up rules must be identical, item by item, across all four languages:
 *
 *   schema declares   model provides             coerced to
 *   string            number (not boolean)       "8891"
 *   integer / number  numeric-looking string     5 / 5.0
 *   boolean           "true" / "false"           true / false
 *   array             single-key obj, array val  unwrap the inner array
 *   array             comma-separated string     split on commas, trim spaces
 *   object            object                     recurse over properties
 *   array             array                      recurse each element via items
 *
 * Values that can't be fixed are passed through as-is, letting the MCP server
 * report its own error — a server-side domain error is more instructive to the
 * model than a local type error.
 */

import type { ToolRegistry } from "./registry.js";
import type {
  MCPToolLike,
  Tool,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "./types.js";

import {
  MCP_NAME_SEP,
  MCP_TOOL_PREFIX,
  buildMcpToolName,
  sanitizeSegment,
} from "@/mcp/tool-wrapper.js";
import { asRecord, strArg } from "@/utils/index.js";

function coerceScalar(value: unknown, want: string): unknown {
  // boolean must be excluded first: typeof true !== "number", but in other
  // languages bool is a subclass of int, so all four languages uniformly treat
  // booleans as not participating in numeric conversion
  if (
    want === "string" &&
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return String(value);
  }
  if ((want === "integer" || want === "number") && typeof value === "string") {
    const text = value.trim();
    if (text === "") {
      return value;
    }
    // Only accept when the whole string is numeric; "5abc" is left untouched.
    // integer further requires no fractional part, and "5.7" is not truncated —
    // it's passed through as-is so the MCP server reports its own domain error
    const shape =
      want === "integer"
        ? /^[+-]?\d+$/
        : /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
    if (!shape.test(text)) {
      return value;
    }
    const parsed =
      want === "integer" ? Number.parseInt(text, 10) : Number.parseFloat(text);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (want === "boolean" && typeof value === "string") {
    const low = value.trim().toLowerCase();
    if (low === "true") {
      return true;
    }
    if (low === "false") {
      return false;
    }
  }
  return value;
}

export function coerceBySchema(value: unknown, schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null) {
    return value;
  }
  const schemaObj = asRecord(schema);
  const want = strArg(schemaObj, "type", "");

  if (
    want === "object" &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const props = asRecord(schemaObj.properties ?? {});
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = key in props ? coerceBySchema(item, props[key]) : item;
    }
    return out;
  }

  if (want === "array") {
    const itemSchema = schemaObj.items ?? {};
    let working: unknown = value;
    // The model often wraps arrays in single-key objects like {"item": [...]}
    if (
      typeof working === "object" &&
      working !== null &&
      !Array.isArray(working)
    ) {
      const entries = Object.values(working);
      if (entries.length === 1 && Array.isArray(entries[0])) {
        working = entries[0];
      }
    } else if (typeof working === "string") {
      // It also often joins them into a comma-separated string
      working = working
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== "");
    }
    if (Array.isArray(working)) {
      return working.map((item) => coerceBySchema(item, itemSchema));
    }
    return working;
  }

  if (want !== "") {
    return coerceScalar(value, want);
  }
  return value;
}

/**
 * The content used for permission rule matching, normalized to server__tool.
 *
 * It carries no mcp__ prefix and is unaffected by per-language wrapper naming
 * differences, so the permissions.yaml syntax is completely identical across all
 * four languages: McpCall(linear__create_issue).
 *
 * Both segments must go through sanitize. The model may pass a short name or a full
 * name; the segments in a full name are already processed by the wrapper, while a
 * short name is given by the model as-is. Without uniform handling, the same call
 * would yield different content for a short name vs. a full name, and rules would
 * fail to match.
 */
export function mcpCallPermissionContent(server: string, tool: string): string {
  if (tool.startsWith(MCP_TOOL_PREFIX)) {
    const rest = tool.slice(MCP_TOOL_PREFIX.length);
    const idx = rest.indexOf(MCP_NAME_SEP);
    if (idx >= 0) {
      // The full name already carries the server segment; use it to avoid building linear__linear__x
      return (
        sanitizeSegment(rest.slice(0, idx)) +
        MCP_NAME_SEP +
        sanitizeSegment(rest.slice(idx + MCP_NAME_SEP.length))
      );
    }
  }
  return sanitizeSegment(server) + MCP_NAME_SEP + sanitizeSegment(tool);
}

export function isMcpToolLike(tool: Tool): tool is MCPToolLike {
  return "mcpInputSchema" in tool && typeof tool.mcpInputSchema === "function";
}

export class McpCallTool implements Tool {
  name = "McpCall";
  description =
    "Invoke a tool on a connected MCP server. Call ToolSearch first to load the " +
    "tool's schema, then pass its arguments here exactly as that schema requires, " +
    "using the same JSON types.";
  category = "command" as const;
  // This tool must stay in tools[] itself, otherwise the model has no entry point
  deferred = false;

  constructor(private registry: ToolRegistry) {}

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          server: {
            type: "string",
            description: "MCP server name, e.g. 'linear'.",
          },
          tool: {
            type: "string",
            description:
              "Full tool name as returned by ToolSearch, e.g. 'mcp__linear__create_issue'.",
          },
          arguments: {
            type: "object",
            description:
              "The target tool's arguments. Must match that tool's input_schema " +
              "exactly, including JSON types: bare numbers for integer fields, bare " +
              "true/false for boolean fields, quoted strings for string fields, and " +
              "plain JSON arrays for array fields.",
          },
        },
        required: ["server", "tool", "arguments"],
      },
    };
  }

  resolveTarget(args: Record<string, unknown>): MCPToolLike | undefined {
    const server = strArg(args, "server");
    const name = strArg(args, "tool");
    if (!server || !name) {
      return undefined;
    }
    const fullName = name.startsWith(MCP_TOOL_PREFIX)
      ? name
      : buildMcpToolName(server, name);
    const target = this.registry.get(fullName);
    // The routed server must be the one that permission rules evaluated.
    return target &&
      isMcpToolLike(target) &&
      sanitizeSegment(target.mcpServerName) === sanitizeSegment(server)
      ? target
      : undefined;
  }

  private availableNames(): string[] {
    return this.registry
      .listTools()
      .filter((t) => t.name.startsWith(MCP_TOOL_PREFIX))
      .map((t) => t.name)
      .sort();
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const server = strArg(args, "server", "");
    const tool = strArg(args, "tool", "");
    if (tool === "") {
      return { output: "McpCall requires a 'tool' name", isError: true };
    }

    const target = this.resolveTarget(args);
    if (!target) {
      const names = this.availableNames();
      const hint = names.length > 0 ? names.join(", ") : "(none connected)";
      return {
        output: `Unknown MCP tool '${tool}' on server '${server}'. Available tools: ${hint}`,
        isError: true,
      };
    }

    if (
      typeof args.arguments !== "object" ||
      args.arguments === null ||
      Array.isArray(args.arguments)
    ) {
      return {
        output:
          "McpCall requires an 'arguments' object matching the target schema",
        isError: true,
      };
    }
    let inner = asRecord(args.arguments);

    if (isMcpToolLike(target)) {
      const schema = target.mcpInputSchema();
      if (Object.keys(schema).length > 0) {
        const fixed = coerceBySchema(inner, schema);
        if (
          typeof fixed === "object" &&
          fixed !== null &&
          !Array.isArray(fixed)
        ) {
          inner = asRecord(fixed);
        }
      }
    }

    ctx.abortSignal?.throwIfAborted();
    return target.execute(ctx, inner);
  }
}
