package bootstrap

import (
	"context"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/teams"
	"github.com/yukino-js/yukino/yukino/internal/todo"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func newTaskList(t *testing.T) *todo.TaskList {
	t.Helper()
	list, err := todo.NewTaskList(nil)
	if err != nil {
		t.Fatal(err)
	}
	return list
}

func registryToolNames(reg *tools.Registry) []string {
	var names []string
	for _, tool := range reg.ListTools() {
		names = append(names, tool.Name())
	}
	return names
}

func has(names []string, want string) bool {
	for _, n := range names {
		if n == want {
			return true
		}
	}
	return false
}

func TestCreateToolRegistryInteractiveOrder(t *testing.T) {
	teamMgr := teams.NewTeamManager(t.TempDir())
	dt := CreateToolRegistry(newTaskList(t), ToolRegistryOptions{
		InteractionMode: "interactive",
		TeamMgr:         teamMgr,
		WorkDir:         t.TempDir(),
	})
	names := registryToolNames(dt.Registry)
	want := []string{
		"Goal", "TodoWrite", "TaskOutput", "Bash", "PowerShell", "ComputerUse", "EditFile",
		"EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree",
		"ReadFile", "ToolSearch", "McpCall", "WriteFile", "Glob", "Grep", "WebFetch",
	}
	if len(names) != len(want) {
		t.Fatalf("tool count = %d (%v), want %d", len(names), names, len(want))
	}
	for i, name := range want {
		if names[i] != name {
			t.Fatalf("order[%d] = %q, want %q (full: %v)", i, names[i], name, names)
		}
	}
	if dt.WriteFile == nil || dt.EditFile == nil {
		t.Fatal("expected WriteFile/EditFile handles")
	}
}

func TestCreateToolRegistryNonInteractiveOmitsPlanMode(t *testing.T) {
	teamMgr := teams.NewTeamManager(t.TempDir())
	dt := CreateToolRegistry(newTaskList(t), ToolRegistryOptions{
		InteractionMode: "non-interactive",
		TeamMgr:         teamMgr,
	})
	names := registryToolNames(dt.Registry)
	if has(names, "EnterPlanMode") {
		t.Fatalf("non-interactive mode must omit EnterPlanMode: %v", names)
	}
	if !has(names, "ExitPlanMode") {
		t.Fatalf("ExitPlanMode must remain: %v", names)
	}
}

func TestCreateToolRegistryEnableModelPlanModeOverride(t *testing.T) {
	enabled := true
	dt := CreateToolRegistry(newTaskList(t), ToolRegistryOptions{
		InteractionMode:     "non-interactive",
		EnableModelPlanMode: &enabled,
	})
	if !has(registryToolNames(dt.Registry), "EnterPlanMode") {
		t.Fatal("EnableModelPlanMode=true must register EnterPlanMode even in non-interactive mode")
	}
}

func TestCreateToolRegistryTeamTodoWrite(t *testing.T) {
	teamMgr := teams.NewTeamManager(t.TempDir())
	dt := CreateToolRegistry(newTaskList(t), ToolRegistryOptions{TeamMgr: teamMgr})
	tool := dt.Registry.Get("TodoWrite")
	if _, ok := tool.(*teams.TeamTodoWriteTool); !ok {
		t.Fatalf("with a team manager, TodoWrite must be TeamTodoWriteTool, got %T", tool)
	}
	// Without a team manager the plain TodoWriteTool is used.
	dt2 := CreateToolRegistry(newTaskList(t), ToolRegistryOptions{})
	if _, ok := dt2.Registry.Get("TodoWrite").(*todo.TodoWriteTool); !ok {
		t.Fatalf("without a team manager, TodoWrite must be todo.TodoWriteTool, got %T", dt2.Registry.Get("TodoWrite"))
	}
}

func TestCountAndRemoveMcpTools(t *testing.T) {
	reg := tools.NewRegistry()
	reg.Register(&tools.GlobTool{})
	reg.Register(&fakeMcpTool{name: tools.MCPToolPrefix + "server__tool"})
	reg.Register(&fakeMcpTool{name: tools.MCPToolPrefix + "other__tool"})
	if got := CountMcpTools(reg); got != 2 {
		t.Fatalf("CountMcpTools = %d, want 2", got)
	}
	RemoveMcpTools(reg)
	if got := CountMcpTools(reg); got != 0 {
		t.Fatalf("after removal CountMcpTools = %d, want 0", got)
	}
	if reg.Get("Glob") == nil {
		t.Fatal("non-MCP tools must survive RemoveMcpTools")
	}
}

type fakeMcpTool struct{ name string }

func (f *fakeMcpTool) Name() string                 { return f.name }
func (f *fakeMcpTool) Description() string          { return "fake" }
func (f *fakeMcpTool) Category() tools.ToolCategory { return tools.CategoryRead }
func (f *fakeMcpTool) Schema() map[string]any       { return map[string]any{"name": f.name} }
func (f *fakeMcpTool) Execute(_ context.Context, _ map[string]any) tools.ToolResult {
	return tools.ToolResult{}
}

func TestBuildComposedToolFilter(t *testing.T) {
	coordinator := func(name string) bool { return name != "blocked" }
	if got := BuildComposedToolFilter(coordinator, nil); got == nil {
		t.Fatal("nil skill filter must return the coordinator")
	}
	composed := BuildComposedToolFilter(coordinator, func(name string) bool { return name != "skill-blocked" })
	if !composed("ok") {
		t.Fatal("ok should pass both")
	}
	if composed("blocked") || composed("skill-blocked") {
		t.Fatal("either filter rejecting must reject")
	}
}

func TestConfigureBashSandbox(t *testing.T) {
	dt := CreateToolRegistry(newTaskList(t), ToolRegistryOptions{WorkDir: t.TempDir()})
	enabled := true
	autoAllow := true
	cfg := &config.SandboxYamlConfig{Enabled: &enabled, AutoAllow: &autoAllow}
	checker := permissions.NewChecker(permissions.NewPathSandbox(t.TempDir(), true), permissions.NewRuleEngine(t.TempDir()), permissions.ModeDefault)

	ConfigureBashSandbox(dt.Registry, t.TempDir(), cfg, checker)
	bash := dt.Registry.Get("Bash").(*tools.BashTool)
	if !bash.SandboxRequired || bash.Sandbox == nil {
		t.Fatal("expected sandbox required and created")
	}
	if !checker.SandboxEnabled || !checker.SandboxAutoAllow {
		t.Fatal("expected checker flags mirrored")
	}
	if len(bash.SandboxConfig.AllowWrite) != 2 {
		t.Fatalf("allowWrite = %v, want cwd + tmpdir", bash.SandboxConfig.AllowWrite)
	}

	// Disabled config clears the requirement.
	off := false
	ConfigureBashSandbox(dt.Registry, t.TempDir(), &config.SandboxYamlConfig{Enabled: &off}, checker)
	if bash.SandboxRequired || checker.SandboxEnabled {
		t.Fatal("expected sandbox disabled")
	}
}

func TestConfigureBashSandboxNilConfig(t *testing.T) {
	dt := CreateToolRegistry(newTaskList(t), ToolRegistryOptions{})
	ConfigureBashSandbox(dt.Registry, t.TempDir(), nil, nil)
	bash := dt.Registry.Get("Bash").(*tools.BashTool)
	if bash.SandboxRequired {
		t.Fatal("nil config must leave the sandbox disabled")
	}
}
