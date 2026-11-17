package subagent

import (
	"context"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type dummyTool struct {
	name     string
	category tools.ToolCategory
}

func (d *dummyTool) Name() string                 { return d.name }
func (d *dummyTool) Description() string          { return "test tool" }
func (d *dummyTool) Category() tools.ToolCategory { return d.category }

func (d *dummyTool) Schema() map[string]any { return nil }
func (d *dummyTool) Execute(_ context.Context, _ map[string]any) tools.ToolResult {
	return tools.ToolResult{}
}

func makeRegistry(names ...string) *tools.Registry {
	reg := tools.NewRegistry()
	for _, n := range names {
		reg.Register(&dummyTool{name: n, category: tools.CategoryRead})
	}
	return reg
}

func hasToolNamed(reg *tools.Registry, name string) bool {
	return reg.Get(name) != nil
}

func TestFilterRemovesAgentTool(t *testing.T) {
	reg := makeRegistry("ReadFile", "Agent", "Bash")
	filtered := FilterToolsForAgent(reg, nil, nil, false)
	if hasToolNamed(filtered, "Agent") {
		t.Error("Agent tool should be removed from sub-agent registry")
	}
	if !hasToolNamed(filtered, "ReadFile") {
		t.Error("ReadFile should remain")
	}
	if !hasToolNamed(filtered, "Bash") {
		t.Error("Bash should remain")
	}
}

func TestFilterRemovesAskUserQuestion(t *testing.T) {
	reg := makeRegistry("ReadFile", "AskUserQuestion")
	filtered := FilterToolsForAgent(reg, nil, nil, false)
	if hasToolNamed(filtered, "AskUserQuestion") {
		t.Error("AskUserQuestion should be removed from sub-agent registry")
	}
}

func TestAsyncFilterWhitelist(t *testing.T) {
	reg := makeRegistry("ReadFile", "WriteFile", "EditFile", "Glob", "Grep", "Bash", "ToolSearch", "Agent", "AskUserQuestion", "TodoWrite")
	filtered := FilterToolsForAgent(reg, nil, nil, true)

	allowed := []string{"ReadFile", "WriteFile", "EditFile", "Glob", "Grep", "Bash", "ToolSearch", "TodoWrite"}
	for _, name := range allowed {
		if !hasToolNamed(filtered, name) {
			t.Errorf("%s should be allowed for async agents", name)
		}
	}

	blocked := []string{"Agent", "AskUserQuestion"}
	for _, name := range blocked {
		if hasToolNamed(filtered, name) {
			t.Errorf("%s should be blocked for async agents", name)
		}
	}
}

func TestMCPToolsPassThrough(t *testing.T) {
	reg := makeRegistry("mcp__grafana__query", "Agent", "ReadFile")
	filtered := FilterToolsForAgent(reg, nil, nil, true)
	if !hasToolNamed(filtered, "mcp__grafana__query") {
		t.Error("MCP tools should always pass through filter")
	}
}

func TestGlobalDisallowedExpanded(t *testing.T) {
	reg := makeRegistry(
		"ReadFile",
		"TaskOutput",
		"ExitPlanMode",
		"EnterPlanMode",
		"Agent",
		"AskUserQuestion",
		"TaskStop",
		"Workflow",
	)
	filtered := FilterToolsForAgent(reg, []string{"*"}, nil, false)
	for _, blocked := range []string{
		"ExitPlanMode", "EnterPlanMode", "Agent", "AskUserQuestion", "Workflow",
	} {
		if hasToolNamed(filtered, blocked) {
			t.Errorf("%s should be in ALL_AGENT_DISALLOWED_TOOLS", blocked)
		}
	}
	if !hasToolNamed(filtered, "ReadFile") {
		t.Error("ReadFile should remain")
	}
}

func TestAsyncWhitelistExpanded(t *testing.T) {
	reg := makeRegistry(
		"ReadFile", "TaskOutput", "TodoWrite", "Grep", "WebFetch", "Glob",
		"Bash", "EditFile", "WriteFile", "TaskStop", "PowerShell",
		"SyntheticOutput", "ToolSearch", "EnterWorktree", "ExitWorktree",
	)
	filtered := FilterToolsForAgent(reg, nil, nil, true)
	for _, name := range []string{
		"ReadFile", "TaskOutput", "TodoWrite", "Grep", "WebFetch", "Glob",
		"Bash", "EditFile", "WriteFile", "TaskStop", "PowerShell",
		"SyntheticOutput", "ToolSearch", "EnterWorktree", "ExitWorktree",
	} {
		if !hasToolNamed(filtered, name) {
			t.Errorf("%s should be allowed for async agents", name)
		}
	}
}

func TestTeammateClonesStripLeaderAuthority(t *testing.T) {
	registry := makeRegistry("ReadFile", "TaskStop", "SendMessage", "Agent", "TeamCreate", "TeamDelete", "ComputerUse")
	teammate := CloneRegistryForTeammate(registry, "")
	for _, name := range []string{"TaskStop", "SendMessage", "Agent", "TeamCreate", "TeamDelete", "ComputerUse"} {
		if teammate.Get(name) != nil {
			t.Fatal("leader tool leaked", name)
		}
	}
	if teammate.Get("ReadFile") == nil {
		t.Fatal("read tool removed")
	}
}
func TestMCPDefinitionsStillRestrictTools(t *testing.T) {
	registry := makeRegistry("mcp__one__read", "mcp__two__write", "ReadFile")
	filtered := FilterToolsForAgent(registry, []string{"*", "ReadFile"}, []string{"mcp__two__write"}, true)
	if filtered.Get("mcp__one__read") == nil || filtered.Get("mcp__two__write") != nil {
		t.Fatal("MCP definition restrictions ignored")
	}
	filtered = FilterToolsForAgent(registry, []string{"ReadFile"}, nil, true)
	if filtered.Get("mcp__one__read") != nil {
		t.Fatal("MCP whitelist ignored")
	}
}

func TestDisallowedToolsApplied(t *testing.T) {
	reg := makeRegistry("ReadFile", "EditFile", "WriteFile", "Bash")
	filtered := FilterToolsForAgent(reg, nil, []string{"EditFile", "WriteFile"}, false)
	if hasToolNamed(filtered, "EditFile") {
		t.Error("EditFile should be blocked by disallowedTools")
	}
	if hasToolNamed(filtered, "WriteFile") {
		t.Error("WriteFile should be blocked by disallowedTools")
	}
	if !hasToolNamed(filtered, "ReadFile") {
		t.Error("ReadFile should remain")
	}
	if !hasToolNamed(filtered, "Bash") {
		t.Error("Bash should remain")
	}
}

func TestGeneralPurposeNoRecursion(t *testing.T) {
	reg := makeRegistry("ReadFile", "Agent", "Bash", "EditFile", "WriteFile", "Glob", "Grep", "ToolSearch", "AskUserQuestion")
	spec := BuiltinSpecs["general-purpose"]
	filtered := FilterToolsForAgent(reg, spec.Tools, spec.DisallowedTools, false)
	if hasToolNamed(filtered, "Agent") {
		t.Error("general-purpose sub-agent should NOT have Agent tool (prevents infinite recursion)")
	}
	if hasToolNamed(filtered, "AskUserQuestion") {
		t.Error("general-purpose sub-agent should NOT have AskUserQuestion")
	}
	if !hasToolNamed(filtered, "ReadFile") {
		t.Error("ReadFile should remain for general-purpose")
	}
	if !hasToolNamed(filtered, "EditFile") {
		t.Error("EditFile should remain for general-purpose (sync)")
	}
}

func TestTeammateFilterBlocksTeamManagement(t *testing.T) {
	reg := makeRegistry("ReadFile", "Bash", "EditFile", "Agent", "TeamCreate", "TeamDelete", "SendMessage")
	spec := BuiltinSpecs["general-purpose"]

	disallowed := append(append([]string{}, spec.DisallowedTools...), TeammateDisallowedTools...)
	filtered := FilterToolsForAgent(reg, spec.Tools, disallowed, false)

	for _, name := range []string{"Agent", "TeamCreate", "TeamDelete"} {
		if hasToolNamed(filtered, name) {
			t.Errorf("teammate tool set must not contain %s", name)
		}
	}
	for _, name := range []string{"ReadFile", "Bash", "EditFile"} {
		if !hasToolNamed(filtered, name) {
			t.Errorf("teammate tool set is missing %s", name)
		}
	}
}
