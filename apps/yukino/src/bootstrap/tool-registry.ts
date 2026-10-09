import type { Command, CommandRegistry } from "@/commands/commands.js";
import type { LspServerConfig } from "@/lsp/config.js";
import { MCP_TOOL_PREFIX } from "@/mcp/tool-wrapper.js";
import type { SkillCatalog } from "@/skills/catalog.js";
import { runInline as runSkillInline } from "@/skills/executor.js";
import type { SkillHost } from "@/skills/index.js";
import type { TeamManager } from "@/teams/index.js";
import { registerLeaderTaskTools } from "@/teams/task-tools.js";
import type { TaskList } from "@/todo/index.js";
import {
  TaskCreateTool,
  TaskGetTool,
  TaskListTool,
  TaskUpdateTool,
  TodoWriteTool,
} from "@/todo/tools.js";
import { BashTool } from "@/tools/bash.js";
import { ComputerUseTool } from "@/tools/computer-use.js";
import { EditFileTool } from "@/tools/edit-file.js";
import { EnterWorktreeTool } from "@/tools/enter-worktree.js";
import { ExitPlanModeTool } from "@/tools/exit-plan-mode.js";
import { ExitWorktreeTool } from "@/tools/exit-worktree.js";
import { GlobTool } from "@/tools/glob.js";
import { GoalTool } from "@/tools/goal.js";
import { GrepTool } from "@/tools/grep.js";
import { LspTool } from "@/tools/lsp.js";
import { McpCallTool } from "@/tools/mcp-call.js";
import { PowerShellTool } from "@/tools/powershell.js";
import { ReadFileTool } from "@/tools/read-file.js";
import { ToolRegistry } from "@/tools/registry.js";
import { TaskOutputTool } from "@/tools/task-output.js";
import { ToolSearchTool } from "@/tools/tool-search.js";
import { WebFetchTool } from "@/tools/web-fetch.js";
import { WebSearchTool } from "@/tools/web-search.js";
import { WriteFileTool } from "@/tools/write-file.js";

export function countMcpTools(registry: ToolRegistry): number {
  return registry
    .listTools()
    .filter((tool) => tool.name.startsWith(MCP_TOOL_PREFIX)).length;
}

/**
 * Removes MCP tool wrappers from the registry, optionally limited to a set of
 * server names. Used during /mcp reload so removed servers and stale schemas do
 * not linger while unchanged wrappers keep their discovery state.
 */
export function removeMcpTools(
  registry: ToolRegistry,
  serverNames?: ReadonlySet<string>,
): void {
  for (const tool of registry.listTools()) {
    if (
      tool.name.startsWith(MCP_TOOL_PREFIX) &&
      (!serverNames ||
        ("mcpServerName" in tool &&
          typeof tool.mcpServerName === "string" &&
          serverNames.has(tool.mcpServerName)))
    ) {
      registry.unregister(tool.name);
    }
  }
}

export function createToolRegistry(
  cwd: string,
  taskList: TaskList,
  options: {
    interactionMode?: "interactive" | "non-interactive";
    lspServers?: readonly LspServerConfig[];
    teamManager?: TeamManager;
  } = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new GoalTool());
  const trackingMode =
    options.interactionMode === "non-interactive" ? "todos" : "tasks";
  if (options.teamManager) {
    registerLeaderTaskTools(
      registry,
      options.teamManager,
      taskList,
      trackingMode,
    );
  } else if (trackingMode === "todos") {
    registry.register(new TodoWriteTool(taskList));
  } else {
    registry.register(new TaskCreateTool(taskList));
    registry.register(new TaskGetTool(taskList));
    registry.register(new TaskListTool(taskList));
    registry.register(new TaskUpdateTool(taskList));
  }
  registry.register(new TaskOutputTool());
  registry.register(new LspTool(options.lspServers ?? []));
  registry.register(new BashTool());
  registry.register(new PowerShellTool());
  registry.register(new ComputerUseTool());
  registry.register(new EditFileTool());
  registry.register(new EnterWorktreeTool());
  registry.register(new ExitPlanModeTool());
  registry.register(new ExitWorktreeTool());
  registry.register(new ReadFileTool());
  registry.register(new ToolSearchTool(registry));
  registry.register(new McpCallTool(registry));
  registry.register(new WriteFileTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  registry.register(new WebFetchTool());
  registry.register(new WebSearchTool());
  return registry;
}

export function wireSkillsToRegistry(
  catalog: SkillCatalog,
  commandRegistry: CommandRegistry,
  skillHost: SkillHost,
): void {
  for (const meta of catalog.list()) {
    if (commandRegistry.find(meta.name)) {
      continue;
    }

    const skill = catalog.get(meta.name);
    if (!skill) {
      continue;
    }

    const command: Command = {
      name: meta.name,
      type: skill.meta.mode === "fork" ? "skill_fork" : "prompt",
      description: `${meta.description} [skill]`,
      isSkill: true,
      handler:
        skill.meta.mode === "fork"
          ? () => ""
          : (context) => runSkillInline(skill, context.args, skillHost),
    };

    try {
      commandRegistry.register(command);
    } catch {
      continue;
    }
  }
}

export function buildComposedToolFilter(
  coordinator: (name: string) => boolean,
  skillFilter: ((name: string) => boolean) | null,
): (name: string) => boolean {
  return skillFilter
    ? (name: string) => coordinator(name) && skillFilter(name)
    : coordinator;
}
