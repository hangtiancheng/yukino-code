// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package bootstrap

import (
	"context"

	"github.com/hangtiancheng/yukino-code/yukino/commands"
	"github.com/hangtiancheng/yukino-code/yukino/skills"
	"github.com/hangtiancheng/yukino-code/yukino/todo"
	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

// CountMcpTools reports how many registered tools are MCP wrappers.
func CountMcpTools(registry *tools.Registry) int {
	count := 0
	for _, tool := range registry.ListTools() {
		if _, ok := tool.(tools.MCPTool); ok {
			count++
		}
	}
	return count
}

// RemoveMcpTools drops MCP tool wrappers from the registry, optionally limited
// to a set of server names. Used during MCP reload so removed servers and
// stale schemas do not linger while unchanged wrappers keep their discovery
// state. A nil set removes every MCP wrapper.
func RemoveMcpTools(registry *tools.Registry, serverNames map[string]bool) {
	for _, tool := range registry.ListTools() {
		mcpTool, ok := tool.(tools.MCPTool)
		if !ok {
			continue
		}
		if serverNames != nil && !serverNames[mcpTool.MCPServerName()] {
			continue
		}
		registry.Unregister(tool.Name())
	}
}

// CreateToolRegistry builds the built-in tool set (TS: createToolRegistry).
// protocol selects the tool-schema dialect for ToolSearch results ("anthropic"
// by default; "openai"/"openai-compat" for the OpenAI function shape) — the TS
// library has a single dialect, Go's registry is protocol-aware.
// The file-state cache is shared across ReadFile/WriteFile/EditFile so the
// read-before-edit tracking spans all three. Hosts wire optional subsystems
// afterwards: sandbox fields on BashTool, a BackgroundTaskManager via
// tools.AttachBackgroundTaskManager, plan-mode predicates on ExitPlanModeTool.
func CreateToolRegistry(workDir string, taskList *todo.TaskList, protocol string) *tools.Registry {
	fsc := tools.NewFileStateCache()
	registry := tools.NewRegistry()

	registry.Register(&todo.TaskCreateTool{List: taskList})
	registry.Register(&todo.TaskGetTool{List: taskList})
	registry.Register(&todo.TaskListTool{List: taskList})
	registry.Register(&todo.TaskUpdateTool{List: taskList})
	registry.Register(&tools.BashTool{WorkDir: workDir})
	registry.Register(&tools.PowerShellTool{WorkDir: workDir})
	registry.Register(&tools.ComputerUseTool{})
	registry.Register(&tools.EditFileTool{FileStateCache: fsc})
	registry.Register(&tools.EnterWorktreeTool{})
	registry.Register(&tools.ExitPlanModeTool{})
	registry.Register(&tools.ExitWorktreeTool{})
	registry.Register(&tools.ReadFileTool{FileStateCache: fsc})
	registry.Register(&tools.ToolSearchTool{Registry: registry, Protocol: protocol})
	registry.Register(&tools.McpCallTool{Registry: registry})
	registry.Register(&tools.WriteFileTool{FileStateCache: fsc})
	registry.Register(&tools.GlobTool{})
	registry.Register(&tools.GrepTool{})
	registry.Register(&tools.WebFetchTool{})
	return registry
}

// WireSkillsToRegistry exposes catalog skills as slash commands (TS:
// wireSkillsToRegistry). A built-in or user command with the same name wins;
// registration conflicts (e.g. alias collisions) are skipped so one bad skill
// does not hide its siblings.
func WireSkillsToRegistry(catalog *skills.Catalog, commandRegistry *commands.Registry, host skills.SkillHost) {
	for _, meta := range catalog.List() {
		if commandRegistry.Find(meta.Name) != nil {
			continue
		}
		skill := catalog.Get(meta.Name)
		if skill == nil {
			continue
		}

		cmdType := commands.TypePrompt
		var handler commands.Handler
		if meta.IsFork() {
			cmdType = commands.TypeSkillFork
			// Fork skills are dispatched by the host through Skills.RunFork;
			// the command entry only makes them visible and selectable.
			handler = func(*commands.Context) string { return "" }
		} else {
			captured := skill
			handler = func(ctx *commands.Context) string {
				out, err := skills.RunInline(context.Background(), captured, ctx.Args, host)
				if err != nil {
					return "Error: " + err.Error()
				}
				return out
			}
		}

		registerSkillCommand(commandRegistry, &commands.Command{
			Name:        meta.Name,
			Aliases:     nil,
			Type:        cmdType,
			Description: meta.Description + " [skill]",
			IsSkill:     true,
			Handler:     handler,
		})
	}
}

// registerSkillCommand swallows the duplicate-name panic of Registry.Register:
// TS wraps the same call in try/catch and continues on conflict.
func registerSkillCommand(registry *commands.Registry, cmd *commands.Command) {
	defer func() { _ = recover() }()
	registry.Register(cmd)
}

// BuildComposedToolFilter ANDs the coordinator-mode filter with an optional
// skill filter (TS: buildComposedToolFilter). A nil skill filter leaves the
// coordinator predicate untouched.
func BuildComposedToolFilter(coordinator, skillFilter func(name string) bool) func(name string) bool {
	if skillFilter != nil {
		return func(name string) bool { return coordinator(name) && skillFilter(name) }
	}
	return coordinator
}
