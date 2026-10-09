import { AgentTool } from "./agent-tool.js";

import { LoadSkillTool } from "@/skills/load-skill-tool.js";
import { TaskStopTool } from "@/teams/task-stop.js";
import { TaskList } from "@/todo/index.js";
import { isLocalTaskTool } from "@/todo/tools.js";
import { McpCallTool } from "@/tools/mcp-call.js";
import { ToolRegistry } from "@/tools/registry.js";
import { ToolSearchTool } from "@/tools/tool-search.js";
import type { Tool } from "@/tools/types.js";

function registerScopedTool(
  registry: ToolRegistry,
  tool: Tool,
  tasks: TaskList,
): void {
  const scoped = isLocalTaskTool(tool)
    ? tool.forList(tasks)
    : tool instanceof ToolSearchTool
      ? new ToolSearchTool(registry)
      : tool instanceof McpCallTool
        ? new McpCallTool(registry)
        : tool instanceof LoadSkillTool
          ? tool.forDelegatedAgent()
          : tool instanceof TaskStopTool
            ? tool.forSubagent()
            : tool;
  registry[scoped === tool ? "registerBorrowed" : "register"](scoped);
}

type AllTools =
  | "InstallSkill"
  | "LoadSkill"
  | "Agent"
  | "TaskStop"
  | "TaskCreate"
  | "TaskGet"
  | "TaskList"
  | "TaskUpdate"
  | "TodoWrite"
  | "TaskOutput"
  | "LSP"
  | "WebSearch"
  | "TeamCreate"
  | "SendMessage"
  | "ListTeams"
  | "TeamDelete"
  | "SyntheticOutput"
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
  | "Goal"
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
export const MAIN_AGENT_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "ComputerUse",
  "AskUserQuestion",
  "ExitPlanMode",
  "Goal",
] satisfies readonly AllTools[]);

// Global list of tools disallowed for subagents — MAIN_AGENT_ONLY_TOOLS plus
// delegation-policy restrictions (recursive Agent spawning and team authority).
// Forks keep Agent (as a tagged clone). TaskStop only controls owned tasks;
// delegated agents never inherit leader messaging or team lifecycle authority.
const SUBAGENT_EXTRA_TOOLS = [
  "Agent",
  "TeamCreate",
  "TeamDelete",
  "SendMessage",
] satisfies readonly AllTools[];
export const SUBAGENT_DISALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ...MAIN_AGENT_ONLY_TOOLS,
  ...SUBAGENT_EXTRA_TOOLS,
]);

export const ASYNC_AGENT_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TodoWrite",
  "TaskOutput",
  "TaskStop",
  "LSP",
  "WebSearch",
  "ReadFile",
  "WebFetch",
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
] satisfies readonly AllTools[]);

function isMCPTool(name: string): boolean {
  return name.startsWith("mcp__");
}

/**
 * Multi-layer tool filtering, applied in order:
 * 1. MCP tools (mcp__*) — exempt from layers 2-3, but still subject to
 *    definition-level disallowedTools/tools (layers 4-5)
 * 2. SUBAGENT_DISALLOWED_TOOLS — Globally disallowed (prevents recursion)
 * 3. ASYNC_AGENT_ALLOWED_TOOLS — Whitelist for background Agents
 * 4. Definition-level disallowedTools — Blacklist
 * 5. Definition-level tools — Whitelist intersection ("*" disables this layer)
 */
export function filterToolsForAgent(
  registry: ToolRegistry,
  allowedTools: string[] | undefined,
  disallowedTools: string[] | undefined,
  isAsync: boolean,
): ToolRegistry {
  const disallowed = new Set(disallowedTools ?? []);
  const allowed = new Set(allowedTools ?? []);
  const hasWhitelist = allowed.size > 0 && !allowed.has("*");

  const filtered = new ToolRegistry();
  const tasks = new TaskList();
  filtered.copyLoadingStateFrom(registry);

  for (const tool of registry.listTools()) {
    const name = tool.name;

    if (isMCPTool(name)) {
      if (!disallowed.has(name) && (!hasWhitelist || allowed.has(name))) {
        registerScopedTool(filtered, tool, tasks);
      }
      continue;
    }

    if (SUBAGENT_DISALLOWED_TOOLS.has(name)) {
      continue;
    }

    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(name)) {
      continue;
    }

    if (disallowed.has(name)) {
      continue;
    }

    if (hasWhitelist && !allowed.has(name)) {
      continue;
    }

    registerScopedTool(filtered, tool, tasks);
  }

  return filtered;
}
export const FORK_QUERY_SOURCE = "agent:builtin:fork";

/**
 * Clone the Leader's registry for an in-process teammate: globally disallowed
 * subagent tools and Leader-only team management tools are stripped. Team-level
 * task tools and the teammate-named SendMessage are added by the caller.
 */
export function cloneRegistryForTeammate(registry: ToolRegistry): ToolRegistry {
  const teammate = new ToolRegistry();
  const tasks = new TaskList();
  teammate.copyLoadingStateFrom(registry);
  for (const tool of registry.listTools()) {
    if (SUBAGENT_DISALLOWED_TOOLS.has(tool.name) || tool.name === "TaskStop") {
      continue;
    }
    registerScopedTool(teammate, tool, tasks);
  }
  return teammate;
}

export function cloneRegistryForFork(registry: ToolRegistry): ToolRegistry {
  const forked = new ToolRegistry();
  const tasks = new TaskList();
  forked.copyLoadingStateFrom(registry);
  for (const tool of registry.listTools()) {
    if (MAIN_AGENT_ONLY_TOOLS.has(tool.name)) {
      continue;
    }
    if (["TeamCreate", "TeamDelete", "SendMessage"].includes(tool.name)) {
      continue;
    }
    if (tool instanceof AgentTool) {
      forked.register(tool.forFork(forked));
    } else {
      registerScopedTool(forked, tool, tasks);
    }
  }
  return forked;
}
