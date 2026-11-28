import type { MCPExposure, MCPServerConfig } from "@/mcp/config.js";

export type ToolInvocationEntry =
  "direct" | "host" | "dispatch" | "codemode" | "app" | "resource";
export interface RegistryPolicy {
  role?: string;
  allowlist?: readonly string[];
  denylist?: readonly string[];
  codeModeEnabled?: boolean;
  codeModeMode?: "off" | "on" | "only";
  codeModeInlineBudget?: number;
}
export interface ToolAuthorization {
  name: string;
  entry: ToolInvocationEntry;
  generation: number;
  role?: string;
}

export function matchesToolPattern(pattern: string, name: string): boolean {
  return new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "u",
  ).test(name);
}

/** Exact names win; otherwise the first matching wildcard wins, then the server default. */
export function resolveMCPExposure(
  config: MCPServerConfig,
  name: string,
): MCPExposure {
  const rules = config.tool_exposure ?? [];
  return (
    rules.find((rule) => rule.tool === name)?.exposure ??
    rules.find(
      (rule) => rule.tool.includes("*") && matchesToolPattern(rule.tool, name),
    )?.exposure ??
    config.exposure ??
    "deferred"
  );
}

export function policyAllows(policy: RegistryPolicy, name: string): boolean {
  return (
    !policy.denylist?.some((pattern) => matchesToolPattern(pattern, name)) &&
    (!policy.allowlist ||
      policy.allowlist.some((pattern) => matchesToolPattern(pattern, name)))
  );
}
