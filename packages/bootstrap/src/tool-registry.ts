import type { Command, CommandRegistry } from "@yukino.js/commands/commands.js";
import type { LspServerConfig } from "@yukino.js/lsp/config.js";
import { MCP_TOOL_PREFIX } from "@yukino.js/model-context-protocol/constants.js";
import type { SkillHost } from "@yukino.js/skills";
import type { SkillCatalog } from "@yukino.js/skills/catalog.js";
import { runInline as runSkillInline } from "@yukino.js/skills/executor.js";
import type { TeamManager } from "@yukino.js/teams";
import { TeamTodoWriteTool } from "@yukino.js/teams/task-tools.js";
import type { TaskList } from "@yukino.js/todo";
import { TodoWriteTool } from "@yukino.js/todo/tools.js";
import { BashTool } from "@yukino.js/tools/bash.js";
import { ComputerUseTool } from "@yukino.js/tools/computer-use.js";
import { EditFileTool } from "@yukino.js/tools/edit-file.js";
import { EnterPlanModeTool } from "@yukino.js/tools/enter-plan-mode.js";
import { EnterWorktreeTool } from "@yukino.js/tools/enter-worktree.js";
import { ExitPlanModeTool } from "@yukino.js/tools/exit-plan-mode.js";
import { ExitWorktreeTool } from "@yukino.js/tools/exit-worktree.js";
import { GlobTool } from "@yukino.js/tools/glob.js";
import { GoalTool } from "@yukino.js/tools/goal.js";
import { GrepTool } from "@yukino.js/tools/grep.js";
import { LspTool } from "@yukino.js/tools/lsp.js";
import { McpCallTool } from "@yukino.js/tools/mcp-call.js";
import { PowerShellTool } from "@yukino.js/tools/powershell.js";
import { ReadFileTool } from "@yukino.js/tools/read-file.js";
import { ToolRegistry } from "@yukino.js/tools/registry.js";
import { TaskOutputTool } from "@yukino.js/tools/task-output.js";
import { ToolSearchTool } from "@yukino.js/tools/tool-search.js";
import { WebFetchTool } from "@yukino.js/tools/web-fetch.js";
import { WriteFileTool } from "@yukino.js/tools/write-file.js";

export function countMcpTools(registry: ToolRegistry): number {
  return registry
    .listTools()
    .filter((tool) => tool.name.startsWith(MCP_TOOL_PREFIX)).length;
}

/**
 * Removes every MCP tool wrapper from the registry. Used by /mcp reload, which
 * reconnects all servers from scratch, so no wrapper survives the reload.
 */
export function removeMcpTools(registry: ToolRegistry): void {
  for (const tool of registry.listTools()) {
    if (tool.name.startsWith(MCP_TOOL_PREFIX)) {
      registry.unregister(tool.name);
    }
  }
}

export function createToolRegistry(
  cwd: string,
  taskList: TaskList,
  options: {
    enableModelPlanMode?: boolean;
    interactionMode?: "interactive" | "non-interactive";
    lspServers?: readonly LspServerConfig[];
    teamManager?: TeamManager;
  } = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new GoalTool());
  registry.register(
    options.teamManager
      ? new TeamTodoWriteTool(
          options.teamManager,
          undefined,
          undefined,
          taskList,
        )
      : new TodoWriteTool(taskList),
  );
  registry.register(new TaskOutputTool());
  registry.register(new LspTool(options.lspServers ?? []));
  registry.register(new BashTool());
  registry.register(new PowerShellTool());
  registry.register(new ComputerUseTool());
  registry.register(new EditFileTool());
  if (
    options.enableModelPlanMode ??
    options.interactionMode !== "non-interactive"
  ) {
    registry.register(new EnterPlanModeTool(registry));
  }
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
