import type { ProviderConfig } from "@/config/provider-config.js";
import { MCP_TOOL_PREFIX, OFFICIAL_HOSTS } from "@/mcp/constants.js";
import type { ToolRegistry } from "@/tools/registry.js";
import type { McpLoadingMode } from "@/tools/types.js";

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
/** Wire adaptation only. User exposure is never changed by a provider or context budget. */
export function decideMode(
  baseUrl: string,
  protocol: ProviderConfig["protocol"],
  hasDeferredMcpTools: boolean,
): McpLoadingMode {
  if (!hasDeferredMcpTools) {
    return "eager";
  }
  return protocol === "anthropic" && isOfficialAnthropicEndpoint(baseUrl)
    ? "native"
    : "dispatch";
}
export function applyMode(registry: ToolRegistry, mode: McpLoadingMode): void {
  registry.mcpLoadingMode = mode;
  const deferred = registry
    .listTools()
    .some((tool) => registry.exposure(tool.name) === "deferred");
  registry.exposeToolSearch = deferred;
  registry.exposeMcpCall = deferred && mode !== "native";
  registry.invalidate();
}
export function decideAndApply(
  registry: ToolRegistry,
  baseUrl: string,
  protocol: ProviderConfig["protocol"],
): McpLoadingMode {
  const hasDeferredMcpTools = registry
    .listTools()
    .some(
      (tool) =>
        tool.name.startsWith(MCP_TOOL_PREFIX) &&
        registry.exposure(tool.name) === "deferred",
    );
  const mode = decideMode(baseUrl, protocol, hasDeferredMcpTools);
  applyMode(registry, mode);
  return mode;
}
