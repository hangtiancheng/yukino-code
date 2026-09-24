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
 * Decides how MCP tools enter the context. Three modes, chosen once at session start
 * right after MCP connects:
 *
 *   eager    Total schema size is under one tenth of the context window, so load
 *            everything into tools[] with no deferral. The context saved is not worth
 *            taking on any extra risk for.
 *   native   Official Anthropic endpoints. Tools stay in tools[] with defer_loading but
 *            the server hides them from the model; ToolSearch returns tool_reference and
 *            the server expands the schema.
 *   dispatch Other endpoints (domestic vendors, various proxy gateways) support neither
 *            of the above, so we simulate it ourselves: MCP tools never enter tools[] and
 *            everything goes through the single McpCall entry point.
 *
 * Why three modes: tools is rendered after system and before messages, so any change to
 * the array invalidates the prompt cache for the entire conversation history that follows.
 * Measured with a 20k-token history, appending one tool to the end of tools drops the
 * cache hit rate from 99.4% to 9.5%, effectively recomputing the whole history.
 */

import { MCP_TOOL_PREFIX } from "./tool-wrapper.js";

import { isMcpToolLike } from "@/tools/mcp-call.js";
import type { ToolRegistry } from "@/tools/registry.js";
import type { McpLoadingMode } from "@/tools/types.js";

/** Below this share of the context window, skip deferral and load everything eagerly. */
export const DEFAULT_EAGER_THRESHOLD_PERCENT = 10;

/**
 * Estimation ratio used when real token counts are unavailable. MCP schemas are JSON
 * with high symbol density, so they have fewer characters per token than natural language.
 */
export const CHARS_PER_TOKEN = 2.5;

/** Beta header for official endpoints; defer_loading and tool_reference both require it. */
export const NATIVE_TOOL_USE_BETA = "advanced-tool-use-2025-11-20";

const OFFICIAL_HOSTS = new Set(["api.anthropic.com"]);
const ENV_OVERRIDE = "YUKINO_MCP_LOADING";

/** An empty baseUrl means the SDK default address, i.e. the official one. */
export function isOfficialAnthropicEndpoint(baseUrl: string): boolean {
  if (!baseUrl) {
    return true;
  }
  try {
    return OFFICIAL_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function estimateSchemaTokens(schemaChars: number): number {
  return Math.floor(schemaChars / CHARS_PER_TOKEN);
}

export function decideMode(
  baseUrl: string,
  contextWindow: number,
  mcpSchemaChars: number,
  thresholdPercent = DEFAULT_EAGER_THRESHOLD_PERCENT,
): McpLoadingMode {
  const override = (process.env[ENV_OVERRIDE] ?? "").trim().toLowerCase();
  if (
    override === "eager" ||
    override === "native" ||
    override === "dispatch"
  ) {
    return override;
  }

  // No MCP tools, any mode would behave the same, and eager is the simplest
  if (mcpSchemaChars <= 0) {
    return "eager";
  }

  const budget = (contextWindow * thresholdPercent) / 100;
  if (estimateSchemaTokens(mcpSchemaChars) < budget) {
    return "eager";
  }

  return isOfficialAnthropicEndpoint(baseUrl) ? "native" : "dispatch";
}

/** Character count of the serialized MCP tool schemas, for comparing against the threshold. */
export function measureSchemaChars(registry: ToolRegistry): number {
  let total = 0;
  for (const tool of registry.listTools()) {
    if (!tool.name.startsWith(MCP_TOOL_PREFIX)) {
      continue;
    }
    try {
      total += JSON.stringify(tool.schema()).length;
    } catch {
      total += tool.name.length + (tool.description?.length ?? 0);
    }
  }
  return total;
}

/**
 * Applies the decision to the registry.
 *
 * Under eager, the defer flag on MCP tools must be cleared so they appear in tools[];
 * the other two modes keep them deferred. McpCall is not registered here — it must
 * already be in tools[] before the MCP connection is established, otherwise adding it
 * after connecting would be a mid-session tools[] mutation and break the cache just the same.
 */
export function applyMode(registry: ToolRegistry, mode: McpLoadingMode): void {
  registry.mcpLoadingMode = mode;
  const eager = mode === "eager";
  for (const tool of registry.listTools()) {
    if (isMcpToolLike(tool) && typeof tool.setDeferLoading === "function") {
      tool.setDeferLoading(!eager);
    }
  }

  // Search and dispatch exposure is decided per mode. Under eager every tool is already in
  // tools[], so there is nothing to search and no need for a dispatch entry point. These two
  // flags are computed once here and fixed for the whole session, so tools[] never fluctuates.
  registry.exposeToolSearch = !eager;
  registry.exposeMcpCall = mode === "dispatch";
}

/** Entry point called once after MCP connects. */
export function decideAndApply(
  registry: ToolRegistry,
  baseUrl: string,
  contextWindow: number,
): McpLoadingMode {
  const mode = decideMode(baseUrl, contextWindow, measureSchemaChars(registry));
  applyMode(registry, mode);
  return mode;
}
