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

import type { Command, CommandRegistry } from "@/commands/commands.js";
import { MCP_TOOL_PREFIX } from "@/mcp/tool-wrapper.js";
import type { SkillCatalog } from "@/skills/catalog.js";
import { runInline as runSkillInline } from "@/skills/executor.js";
import type { SkillHost } from "@/skills/index.js";
import type { TaskList } from "@/todo/index.js";
import {
  TaskCreateTool,
  TaskGetTool,
  TaskListTool,
  TaskUpdateTool,
} from "@/todo/tools.js";
import { BashTool } from "@/tools/bash.js";
import { ComputerUseTool } from "@/tools/computer-use.js";
import { EditFileTool } from "@/tools/edit-file.js";
import { EnterWorktreeTool } from "@/tools/enter-worktree.js";
import { ExitPlanModeTool } from "@/tools/exit-plan-mode.js";
import { ExitWorktreeTool } from "@/tools/exit-worktree.js";
import { GlobTool } from "@/tools/glob.js";
import { GrepTool } from "@/tools/grep.js";
import { McpCallTool } from "@/tools/mcp-call.js";
import { PowerShellTool } from "@/tools/powershell.js";
import { ReadFileTool } from "@/tools/read-file.js";
import { ToolRegistry } from "@/tools/registry.js";
import { ToolSearchTool } from "@/tools/tool-search.js";
import { WebFetchTool } from "@/tools/web-fetch.js";
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
  workDir: string,
  taskList: TaskList,
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new TaskCreateTool(taskList));
  registry.register(new TaskGetTool(taskList));
  registry.register(new TaskListTool(taskList));
  registry.register(new TaskUpdateTool(taskList));
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
      aliases: [],
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
