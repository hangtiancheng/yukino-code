package bootstrap

import (
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/commands"
	"github.com/yukino-js/yukino/yukino/internal/goal"
	"github.com/yukino-js/yukino/yukino/internal/skills"
	"github.com/yukino-js/yukino/yukino/internal/teams"
	"github.com/yukino-js/yukino/yukino/internal/todo"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

// CountMcpTools mirrors countMcpTools.
func CountMcpTools(registry *tools.Registry) int {
	count := 0
	for _, tool := range registry.ListTools() {
		if strings.HasPrefix(tool.Name(), tools.MCPToolPrefix) {
			count++
		}
	}
	return count
}

// RemoveMcpTools mirrors removeMcpTools: it removes every MCP tool wrapper
// from the registry. Used by /mcp reload, which reconnects all servers from
// scratch, so no wrapper survives the reload.
func RemoveMcpTools(registry *tools.Registry) {
	for _, tool := range registry.ListTools() {
		if strings.HasPrefix(tool.Name(), tools.MCPToolPrefix) {
			registry.Unregister(tool.Name())
		}
	}
}

// ToolRegistryOptions mirrors the reference createToolRegistry options. The
// extra construction dependencies exist because Go tools bind session state at
// construction time, where the reference resolves it per call from ToolContext.
type ToolRegistryOptions struct {
	EnableModelPlanMode *bool
	// "interactive" or "non-interactive"; EnterPlanMode is registered unless
	// EnableModelPlanMode is set or the mode is "non-interactive".
	InteractionMode string
	TeamMgr         *teams.TeamManager

	WorkDir     string
	GoalManager func() *goal.GoalManager
}

// CreateToolRegistry mirrors the reference createToolRegistry, registering the
// core tool set in the reference order.
func CreateToolRegistry(taskList *todo.TaskList, opts ToolRegistryOptions) tools.DefaultTools {
	fileStateCache := tools.NewFileStateCache()
	writeFile := &tools.WriteFileTool{FileStateCache: fileStateCache}
	editFile := &tools.EditFileTool{FileStateCache: fileStateCache}
	registry := tools.NewRegistry()
	registry.Register(&tools.GoalTool{Manager: opts.GoalManager})
	if opts.TeamMgr != nil {
		registry.Register(&teams.TeamTodoWriteTool{TeamMgr: opts.TeamMgr, Fallback: taskList})
	} else {
		registry.Register((&todo.TodoWriteTool{}).ForList(taskList))
	}
	registry.Register(&tools.TaskOutputTool{})
	registry.Register(&tools.BashTool{WorkDir: opts.WorkDir})
	registry.Register(&tools.PowerShellTool{})
	registry.Register(tools.NewComputerUseTool(tools.ComputerUseOptions{}))
	registry.Register(editFile)
	enableModelPlanMode := opts.InteractionMode != "non-interactive"
	if opts.EnableModelPlanMode != nil {
		enableModelPlanMode = *opts.EnableModelPlanMode
	}
	if enableModelPlanMode {
		registry.Register(&tools.EnterPlanModeTool{Registry: registry})
	}
	registry.Register(&tools.EnterWorktreeTool{})
	registry.Register(&tools.ExitPlanModeTool{})
	registry.Register(&tools.ExitWorktreeTool{})
	registry.Register(&tools.ReadFileTool{FileStateCache: fileStateCache})
	registry.Register(&tools.ToolSearchTool{Registry: registry})
	registry.Register(&tools.McpCallTool{Registry: registry})
	registry.Register(writeFile)
	registry.Register(&tools.GlobTool{})
	registry.Register(&tools.GrepTool{})
	registry.Register(&tools.WebFetchTool{})
	return tools.DefaultTools{Registry: registry, WriteFile: writeFile, EditFile: editFile}
}

// WireSkillsToRegistry mirrors wireSkillsToRegistry: every loaded skill becomes
// a slash command (inline -> prompt, fork -> skill_fork). Idempotent — names
// already taken (built-ins, user commands) are skipped.
func WireSkillsToRegistry(catalog *skills.Catalog, commandRegistry *commands.Registry, host skills.SkillHost) {
	if catalog == nil || commandRegistry == nil {
		return
	}
	for _, meta := range catalog.List() {
		if commandRegistry.Find(meta.Name) != nil {
			continue
		}
		skill := catalog.Get(meta.Name)
		if skill == nil {
			continue
		}
		command := &commands.Command{
			Name:        meta.Name,
			Description: meta.Description + " [skill]",
			IsSkill:     true,
		}
		if skill.Meta.IsFork() {
			command.Type = commands.TypeSkillFork
			command.Handler = func(ctx *commands.Context) string { return "" }
		} else {
			command.Type = commands.TypePrompt
			command.Handler = func(ctx *commands.Context) string {
				return skills.RunInline(skill, ctx.Args, host)
			}
		}
		commandRegistry.Register(command)
	}
}

// BuildComposedToolFilter mirrors buildComposedToolFilter.
func BuildComposedToolFilter(coordinator func(name string) bool, skillFilter func(name string) bool) func(name string) bool {
	if skillFilter != nil {
		return func(name string) bool { return coordinator(name) && skillFilter(name) }
	}
	return coordinator
}
