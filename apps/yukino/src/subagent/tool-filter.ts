import type { PermissionMode } from "@/permissions/index.js";
import { LoadSkillTool } from "@/skills/load-skill-tool.js";
import {
  ASYNC_AGENT_ALLOWED_TOOLS,
  SUBAGENT_DISALLOWED_TOOLS,
} from "@/subagent/constants.js";
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
  permissionMode?: PermissionMode,
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

    const planExit = name === "ExitPlanMode" && permissionMode === "plan";
    if (!planExit && SUBAGENT_DISALLOWED_TOOLS.has(name)) {
      continue;
    }

    if (!planExit && isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(name)) {
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

/**
 * Clone the Leader's registry for an in-process teammate: globally disallowed
 * subagent tools and Leader-only team management tools are stripped. Team-level
 * task tools and the teammate-named SendMessage are added by the caller.
 */
export function cloneRegistryForTeammate(
  registry: ToolRegistry,
  permissionMode?: PermissionMode,
): ToolRegistry {
  const teammate = new ToolRegistry();
  const tasks = new TaskList();
  teammate.copyLoadingStateFrom(registry);
  for (const tool of registry.listTools()) {
    const planExit = tool.name === "ExitPlanMode" && permissionMode === "plan";
    if (
      (!planExit && SUBAGENT_DISALLOWED_TOOLS.has(tool.name)) ||
      tool.name === "TaskStop"
    ) {
      continue;
    }
    registerScopedTool(teammate, tool, tasks);
  }
  return teammate;
}
