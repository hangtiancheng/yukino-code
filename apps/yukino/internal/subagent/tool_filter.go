package subagent

import (
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/tools"
)

var SubagentDisallowedTools = map[string]bool{
	"Workflow": true, "ComputerUse": true, "AskUserQuestion": true, "EnterPlanMode": true, "ExitPlanMode": true, "Goal": true, "Agent": true, "TeamCreate": true, "TeamDelete": true, "SendMessage": true,
}
var AsyncAgentAllowedTools = map[string]bool{
	"TodoWrite": true, "TaskOutput": true, "TaskStop": true, "ReadFile": true, "WebFetch": true, "Grep": true, "Glob": true, "Bash": true, "PowerShell": true, "EditFile": true, "WriteFile": true, "LoadSkill": true, "SyntheticOutput": true, "ToolSearch": true, "EnterWorktree": true, "ExitWorktree": true, "McpCall": true,
}
var TeammateDisallowedTools = []string{"TeamCreate", "TeamDelete"}

func IsMCPTool(name string) bool { return strings.HasPrefix(name, tools.MCPToolPrefix) }
func registerScopedTool(registry *tools.Registry, tool tools.Tool) {
	switch t := tool.(type) {
	case *tools.EnterPlanModeTool:
		registry.Register(&tools.EnterPlanModeTool{Registry: registry})
	case *tools.ToolSearchTool:
		registry.Register(&tools.ToolSearchTool{Registry: registry})
	case *tools.McpCallTool:
		registry.Register(&tools.McpCallTool{Registry: registry})
	case interface{ ForSubagent() tools.Tool }:
		registry.Register(t.ForSubagent())
	case interface{ ForDelegatedAgent() tools.Tool }:
		registry.Register(t.ForDelegatedAgent())
	default:
		registry.RegisterBorrowed(tool)
	}
}
func FilterToolsForAgent(registry *tools.Registry, allowedTools, disallowedTools []string, isAsync bool, permissionModes ...string) *tools.Registry {
	allowed, disallowed := map[string]bool{}, map[string]bool{}
	for _, name := range allowedTools {
		allowed[name] = true
	}
	for _, name := range disallowedTools {
		disallowed[name] = true
	}
	whitelist := len(allowed) > 0 && !allowed["*"]
	mode := ""
	if len(permissionModes) > 0 {
		mode = permissionModes[0]
	}
	filtered := tools.NewRegistry()
	filtered.CopyLoadingStateFrom(registry)
	for _, tool := range registry.ListTools() {
		name := tool.Name()
		planExit := name == "ExitPlanMode" && mode == "plan"
		if !IsMCPTool(name) && (!planExit && SubagentDisallowedTools[name] || !planExit && isAsync && !AsyncAgentAllowedTools[name]) {
			continue
		}
		if disallowed[name] || whitelist && !allowed[name] {
			continue
		}
		registerScopedTool(filtered, tool)
	}
	return filtered
}
func CloneRegistryForTeammate(registry *tools.Registry, permissionMode string) *tools.Registry {
	teammate := tools.NewRegistry()
	teammate.CopyLoadingStateFrom(registry)
	for _, tool := range registry.ListTools() {
		name := tool.Name()
		planExit := name == "ExitPlanMode" && permissionMode == "plan"
		if !planExit && SubagentDisallowedTools[name] || name == "TaskStop" {
			continue
		}
		registerScopedTool(teammate, tool)
	}
	return teammate
}
