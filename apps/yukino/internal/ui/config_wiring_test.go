package ui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/memory"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/skills"
)

// TestUIRegistryOrderMatchesReference pins the full tool registration order:
// the mount-time createToolRegistry core set followed by the initClient
// additions (skill tools, ask tool, team/task tools, SyntheticOutput, Agent).
func TestUIRegistryOrderMatchesReference(t *testing.T) {
	provider := config.ProviderConfig{Name: "test", Protocol: "anthropic", Model: "m", APIKey: "k"}
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	m := New([]config.ProviderConfig{provider}, nil, nil, nil, 0, "", false)
	m.skillCatalog = skills.LoadCatalog(dir)
	m.registerAgentTools(nil, &provider, "anthropic", dir)
	var names []string
	for _, tool := range m.registry.ListTools() {
		names = append(names, tool.Name())
	}
	want := []string{
		"Goal", "TodoWrite", "TaskOutput", "Bash", "PowerShell", "ComputerUse", "EditFile",
		"EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree",
		"ReadFile", "ToolSearch", "McpCall", "WriteFile", "Glob", "Grep", "WebFetch",
		"LoadSkill", "InstallSkill", "AskUserQuestion",
		"TeamCreate", "SendMessage", "TeamList", "TeamDelete", "TaskStop",
		"SyntheticOutput", "Agent",
	}
	if len(names) != len(want) {
		t.Fatalf("tool count = %d (%v), want %d", len(names), names, len(want))
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("order[%d] = %q, want %q (full: %v)", i, names[i], want[i], names)
		}
	}
}

func TestInitialPermissionMode(t *testing.T) {
	cases := map[string]permissions.PermissionMode{
		"":                  permissions.ModeDefault,
		"default":           permissions.ModeDefault,
		"acceptEdits":       permissions.ModeAcceptEdits,
		"bypassPermissions": permissions.ModeBypass,
		"plan":              permissions.ModeDefault, // plan is not a startup mode
		"bogus":             permissions.ModeDefault,
	}
	for in, want := range cases {
		if got := initialPermissionMode(in); got != want {
			t.Errorf("initialPermissionMode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNewWiresPermissionMode(t *testing.T) {
	provider := config.ProviderConfig{Name: "test", Protocol: "anthropic", Model: "m", APIKey: "k"}
	m := New([]config.ProviderConfig{provider}, nil, nil, nil, 0, "bypassPermissions", true)
	if m.permissionMode != permissions.ModeBypass {
		t.Fatalf("permissionMode = %q, want bypassPermissions", m.permissionMode)
	}
	if !m.memoryEnabled {
		t.Fatal("memoryEnabled should be true")
	}
}

func TestNewHonorsDefaultProvider(t *testing.T) {
	p0 := config.ProviderConfig{Name: "a", Protocol: "anthropic", Model: "m", APIKey: "k", BaseURL: "u0"}
	p1 := config.ProviderConfig{Name: "b", Protocol: "anthropic", Model: "m", APIKey: "k", BaseURL: "u1"}
	m := New([]config.ProviderConfig{p0, p1}, nil, nil, nil, 1, "", true)
	if m.defaultProvider != 1 || m.providerCursor != 1 {
		t.Fatalf("defaultProvider=%d providerCursor=%d, want 1/1", m.defaultProvider, m.providerCursor)
	}
	if m.selectedProvider == nil || m.selectedProvider.Name != "b" {
		t.Fatalf("selectedProvider = %+v, want provider b", m.selectedProvider)
	}
}

func TestNewClampsOutOfRangeDefaultProvider(t *testing.T) {
	p0 := config.ProviderConfig{Name: "a", Protocol: "anthropic", Model: "m", APIKey: "k", BaseURL: "u0"}
	m := New([]config.ProviderConfig{p0}, nil, nil, nil, 5, "", true)
	if m.providerCursor != 0 {
		t.Fatalf("providerCursor = %d, want clamped to 0", m.providerCursor)
	}
}

func TestRebuildSystemPromptGatesMemory(t *testing.T) {
	provider := config.ProviderConfig{Name: "test", Protocol: "anthropic", Model: "m", APIKey: "k"}
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()

	memDir := memory.GetAutoMemPath(dir)
	if err := os.MkdirAll(memDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(memDir, "topic.md"), []byte("---\nname: topic\ndescription: a saved memory\ntype: reference\n---\nbody"), 0o600); err != nil {
		t.Fatal(err)
	}

	enabled := New([]config.ProviderConfig{provider}, nil, nil, nil, 0, "", true)
	enabled.selectedProvider = &provider
	enabled.memoryMgr = memory.NewManager(dir, nil)
	enabled.rebuildSystemPrompt(dir)
	if !strings.Contains(enabled.memoryContent, "Active memories:") {
		t.Errorf("memoryContent should be populated when enable_memory is on, got %q", enabled.memoryContent)
	}

	disabled := New([]config.ProviderConfig{provider}, nil, nil, nil, 0, "", false)
	disabled.selectedProvider = &provider
	disabled.rebuildSystemPrompt(dir)
	if disabled.memoryContent != "" {
		t.Errorf("memoryContent should be empty when enable_memory is off, got %q", disabled.memoryContent)
	}
	if disabled.memoryMgr != nil {
		t.Error("memoryMgr must stay nil until registerAgentTools, and is gated there")
	}
}

func TestBuildMemoryStatusDisabled(t *testing.T) {
	provider := config.ProviderConfig{Name: "test", Protocol: "anthropic", Model: "m", APIKey: "k"}
	m := New([]config.ProviderConfig{provider}, nil, nil, nil, 0, "", false)
	got := m.buildMemoryStatus("")
	want := "Auto memory is disabled (enable_memory: false in config.yaml)."
	if got != want {
		t.Errorf("buildMemoryStatus() = %q, want %q", got, want)
	}
}

func TestBuildSessionStatusShowsDisabledMemory(t *testing.T) {
	provider := config.ProviderConfig{Name: "test", Protocol: "anthropic", Model: "m", APIKey: "k"}
	m := New([]config.ProviderConfig{provider}, nil, nil, nil, 0, "bypassPermissions", false)
	m.selectedProvider = &provider
	// activateInitialProvider builds the checker from m.permissionMode; mirror
	// that here so /status renders the configured startup mode.
	m.ag = &agent.Agent{}
	m.ag.Checker = permissions.NewChecker(
		permissions.NewPathSandbox(t.TempDir(), true),
		permissions.NewRuleEngine(t.TempDir()),
		m.permissionMode,
	)
	got := m.buildSessionStatus()
	for _, want := range []string{
		"Mode:      bypassPermissions",
		"Memories:  disabled (enable_memory: false)",
		"Provider:  test (anthropic)",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("status missing %q:\n%s", want, got)
		}
	}
}
