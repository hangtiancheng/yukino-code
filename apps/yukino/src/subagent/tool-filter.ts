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

import type { AgentTool } from "./agent-tool.js";

import { ToolRegistry } from "@/tools/registry.js";

type AllTools =
  | "InstallSkill"
  | "LoadSkill"
  | "Agent"
  | "TaskStop"
  | "TaskCreate"
  | "TaskGet"
  | "TaskList"
  | "TaskUpdate"

  // === team run agent ===
  | "TeamCreate"
  | "SpawnTeammate"
  | "SendMessage"
  | "ListTeams"
  | "TeamDelete"
  | "SyntheticOutput"
  // === team run agent ===
  | "AskUserQuestion"
  | "Bash"
  | "PowerShell"
  | "ComputerUse"
  | "EditFile"
  | "EnterWorktree"
  | "ExitPlanMode"
  | "ExitWorktree"
  | "ReadFile"
  | "ToolSearch"
  | "WriteFile"
  | "Glob"
  | "Grep"
  | "WebFetch"
  | "McpCall";

// Tools that only work correctly on the main thread: each depends on main-thread
// UI state or a singleton device, so it is stripped from every delegated agent —
// both forks (cloneRegistryForFork) and defined subagents (via the spread below).
//   ComputerUse     — drives the physical screen/mouse/keyboard; delegated agents
//                     would fight over one device.
//   AskUserQuestion — prompts through a single modal dialog; a delegated agent
//                     would hijack it and race parallel siblings (the loser hangs).
//   ExitPlanMode    — ends the caller's loop and expects the main-thread approval
//                     dialog, which never fires from a delegated agent.
export const MAIN_AGENT_ONLY_TOOLS = new Set<AllTools>([
  "ComputerUse",
  "AskUserQuestion",
  "ExitPlanMode",
]);

// Global list of tools disallowed for subagents — MAIN_AGENT_ONLY_TOOLS plus
// delegation-policy restrictions (recursive Agent spawning, lead-only TaskStop).
// Forks keep Agent (as a tagged clone) and TaskStop; only MAIN_AGENT_ONLY_TOOLS
// is stripped from them.
export const SUBAGENT_DISALLOWED_TOOLS = new Set<AllTools>([
  ...MAIN_AGENT_ONLY_TOOLS,
  "Agent", // Prevents recursive spawning of subagents
  "TaskStop",
]);

// Additional tools blocked for teammates beyond the global subagent list.
// Team creation and dissolution are the Lead's responsibility; teammates
// only execute work and coordinate with peers.
export const TEAMMATE_DISALLOWED_TOOLS = new Set<AllTools>([
  "TeamCreate",
  "TeamDelete",
]);

// Additional tools disallowed for custom Agents (loaded from .yukino/agents/);
// currently a subset of the global list (same except ComputerUse, which Layer 2
// already strips), but maintained separately for future extensibility
export const CUSTOM_AGENT_DISALLOWED_TOOLS = new Set<AllTools>([
  "ExitPlanMode",
  "Agent",
  "AskUserQuestion",
  "TaskStop",
]);

// Asynchronous (background) Agents are restricted to only these tools
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set<AllTools>([
  "ReadFile",
  // "WebSearch",
  "Grep",
  "Glob",
  "Bash",
  "PowerShell",
  "EditFile",
  "WriteFile",
  "LoadSkill",
  "SyntheticOutput",
  "ToolSearch",
  "EnterWorktree",
  "ExitWorktree",
  // ToolSearch only reads out schemas; actual invocation relies on McpCall.
  // The two must be allowed together, or the subagent sees tools but cannot call them
  "McpCall",
]);

function isMCPTool(name: string): boolean {
  return name.startsWith("mcp__");
}

/**
 * Multi-layer tool filtering, applied in order:
 * 1. MCP tools (mcp__*) — exempt from layers 2-4, but still subject to
 *    definition-level disallowedTools/tools (layers 5-6)
 * 2. SUBAGENT_DISALLOWED_TOOLS — Globally disallowed (prevents recursion)
 * 3. CUSTOM_AGENT_DISALLOWED_TOOLS — Additional restrictions for custom Agents
 * 4. ASYNC_AGENT_ALLOWED_TOOLS — Whitelist for background Agents
 * 5. Definition-level disallowedTools — Blacklist
 * 6. Definition-level tools — Whitelist intersection ("*" disables this layer)
 */
export function filterToolsForAgent(
  registry: ToolRegistry,
  allowedTools: string[] | undefined,
  disallowedTools: string[] | undefined,
  isAsync: boolean,
  isCustom = false,
): ToolRegistry {
  const disallowed = new Set(disallowedTools ?? []);
  const allowed = new Set(allowedTools ?? []);
  // Enable whitelist intersection if a tools list is defined and is not the wildcard "*"
  const hasWhitelist =
    allowed.size > 0 && !(allowed.size === 1 && allowed.has("*"));

  const filtered = new ToolRegistry();
  filtered.mcpLoadingMode = registry.mcpLoadingMode;

  for (const tool of registry.listTools()) {
    const name = tool.name;

    // Layer 1: MCP tools skip layers 2-4; definition-level lists still apply
    if (isMCPTool(name)) {
      if (!disallowed.has(name) && (!hasWhitelist || allowed.has(name))) {
        filtered.register(tool);
      }
      continue;
    }

    // Layer 2: Global disallow — no subagent can use these

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    if ((SUBAGENT_DISALLOWED_TOOLS as Set<string>).has(name)) {
      continue;
    }

    // Layer 3: Additional restrictions for custom Agents

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    if (isCustom && (CUSTOM_AGENT_DISALLOWED_TOOLS as Set<string>).has(name)) {
      continue;
    }

    // Layer 4: Whitelist filtering for asynchronous Agents

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    if (isAsync && !(ASYNC_AGENT_ALLOWED_TOOLS as Set<string>).has(name)) {
      continue;
    }

    // Layer 5: Definition-level blacklist
    if (disallowed.has(name)) {
      continue;
    }

    // Layer 6: Definition-level whitelist intersection
    if (hasWhitelist && !allowed.has(name)) {
      continue;
    }

    filtered.register(tool);
  }

  return filtered;
}
export const FORK_QUERY_SOURCE = "agent:builtin:fork";
export function cloneRegistryForFork(registry: ToolRegistry): ToolRegistry {
  const forked = new ToolRegistry();
  forked.mcpLoadingMode = registry.mcpLoadingMode;
  for (const tool of registry.listTools()) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    if ((MAIN_AGENT_ONLY_TOOLS as Set<string>).has(tool.name)) {
      continue;
    }
    if (tool.name === "Agent" && "querySource" in tool) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const clone = Object.create(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        Object.getPrototypeOf(tool),
        Object.getOwnPropertyDescriptors(tool),
      ) as AgentTool;
      clone.querySource = FORK_QUERY_SOURCE;
      forked.register(clone);
    } else {
      forked.register(tool);
    }
  }
  return forked;
}
