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
	"strings"
	"testing"

	"github.com/hangtiancheng/yukino-code/yukino/commands"
	"github.com/hangtiancheng/yukino-code/yukino/skills"
	"github.com/hangtiancheng/yukino-code/yukino/todo"
	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

func newTestTaskList(t *testing.T) *todo.TaskList {
	t.Helper()
	return todo.NewTaskList(todo.NewStore(t.TempDir(), "test"))
}

func TestCreateToolRegistryRegistersBuiltins(t *testing.T) {
	registry := CreateToolRegistry(t.TempDir(), newTestTaskList(t), "")

	expected := []string{
		"TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
		"Bash", "PowerShell", "ComputerUse",
		"EditFile", "ReadFile", "WriteFile",
		"EnterWorktree", "ExitWorktree", "ExitPlanMode",
		"ToolSearch", "McpCall", "Glob", "Grep", "WebFetch",
	}
	for _, name := range expected {
		if registry.Get(name) == nil {
			t.Errorf("built-in tool %q not registered", name)
		}
	}
	if CountMcpTools(registry) != 0 {
		t.Error("fresh registry must contain no MCP tools")
	}
}

// fakeMCPTool satisfies tools.MCPTool.
type fakeMCPTool struct {
	name   string
	server string
}

func (f *fakeMCPTool) Name() string                 { return f.name }
func (f *fakeMCPTool) Description() string          { return "" }
func (f *fakeMCPTool) Category() tools.ToolCategory { return tools.CategoryRead }
func (f *fakeMCPTool) Schema() map[string]any       { return nil }
func (f *fakeMCPTool) Execute(context.Context, map[string]any) tools.ToolResult {
	return tools.ToolResult{}
}
func (f *fakeMCPTool) MCPServerName() string          { return f.server }
func (f *fakeMCPTool) MCPInputSchema() map[string]any { return nil }
func (f *fakeMCPTool) SetDeferLoading(bool)           {}

func TestCountAndRemoveMcpTools(t *testing.T) {
	registry := tools.NewRegistry()
	registry.Register(&fakeMCPTool{name: "mcp__a__tool1", server: "a"})
	registry.Register(&fakeMCPTool{name: "mcp__a__tool2", server: "a"})
	registry.Register(&fakeMCPTool{name: "mcp__b__tool1", server: "b"})
	registry.Register(&tools.GlobTool{})

	if got := CountMcpTools(registry); got != 3 {
		t.Fatalf("want 3 MCP tools, got %d", got)
	}

	// Scoped removal only drops server "a".
	RemoveMcpTools(registry, map[string]bool{"a": true})
	if registry.Get("mcp__a__tool1") != nil || registry.Get("mcp__a__tool2") != nil {
		t.Fatal("server a tools must be removed")
	}
	if registry.Get("mcp__b__tool1") == nil {
		t.Fatal("server b tools must survive a scoped removal")
	}
	if registry.Get("Glob") == nil {
		t.Fatal("built-in tools must never be removed")
	}

	// Nil set removes every remaining wrapper.
	RemoveMcpTools(registry, nil)
	if got := CountMcpTools(registry); got != 0 {
		t.Fatalf("want 0 MCP tools after full removal, got %d", got)
	}
}

type recordingSkillHost struct {
	activated map[string]string
	registry  *tools.Registry
}

func (h *recordingSkillHost) ActivateSkill(name, body string) { h.activated[name] = body }
func (h *recordingSkillHost) ToolRegistry() *tools.Registry   { return h.registry }

func TestWireSkillsToRegistry(t *testing.T) {
	catalog := skills.NewCatalog()
	catalog.Register(&skills.Skill{
		Meta:       skills.SkillMeta{Name: "inline-skill", Description: "does things", Mode: "inline"},
		PromptBody: "SOP body",
	}, "test")
	catalog.Register(&skills.Skill{
		Meta:       skills.SkillMeta{Name: "fork-skill", Description: "forks", Mode: "fork"},
		PromptBody: "fork body",
	}, "test")

	cmdRegistry := commands.NewRegistry()
	// A built-in with the same name must win over the skill.
	cmdRegistry.Register(&commands.Command{
		Name: "inline-skill", Type: commands.TypeLocal,
		Handler: func(*commands.Context) string { return "builtin" },
	})

	host := &recordingSkillHost{activated: map[string]string{}}
	WireSkillsToRegistry(catalog, cmdRegistry, host)

	// Built-in kept.
	if cmd := cmdRegistry.Find("inline-skill"); cmd == nil || cmd.Type != commands.TypeLocal {
		t.Fatalf("built-in command must win: %+v", cmd)
	}

	// Fork skill registered as skill-fork with the [skill] suffix.
	fork := cmdRegistry.Find("fork-skill")
	if fork == nil {
		t.Fatal("fork-skill command missing")
	}
	if fork.Type != commands.TypeSkillFork || !fork.IsSkill {
		t.Fatalf("fork command wrong: %+v", fork)
	}
	if fork.Description != "forks [skill]" {
		t.Fatalf("description wrong: %q", fork.Description)
	}
	if out := fork.Handler(&commands.Context{}); out != "" {
		t.Fatalf("fork handler must return empty (host dispatches), got %q", out)
	}
}

func TestWireSkillsToRegistryInlineHandler(t *testing.T) {
	catalog := skills.NewCatalog()
	catalog.Register(&skills.Skill{
		Meta:       skills.SkillMeta{Name: "inline-only", Description: "d"},
		PromptBody: "do $ARGUMENTS now",
	}, "test")

	cmdRegistry := commands.NewRegistry()
	host := &recordingSkillHost{activated: map[string]string{}}
	WireSkillsToRegistry(catalog, cmdRegistry, host)

	cmd := cmdRegistry.Find("inline-only")
	if cmd == nil || cmd.Type != commands.TypePrompt || !cmd.IsSkill {
		t.Fatalf("inline command wrong: %+v", cmd)
	}
	out := cmd.Handler(&commands.Context{Args: "it"})
	// RunInline returns the TS execution envelope (SKILL_INSTRUCTIONS +
	// <skill-metadata> + <skill-body> + <skill-arguments>), not the bare body.
	if !strings.Contains(out, "<skill-body>\ndo it now\n</skill-body>") {
		t.Fatalf("inline handler must render the body inside the envelope, got %q", out)
	}
	if !strings.Contains(out, "<skill-arguments>it</skill-arguments>") {
		t.Fatalf("inline handler must wrap the args, got %q", out)
	}
	if host.activated["inline-only"] != out {
		t.Fatalf("skill was not activated on the host: %v", host.activated)
	}
}

func TestBuildComposedToolFilter(t *testing.T) {
	coordinator := func(name string) bool { return name != "Bash" }
	skillFilter := func(name string) bool { return name != "Grep" }

	composed := BuildComposedToolFilter(coordinator, skillFilter)
	if composed("Bash") || composed("Grep") {
		t.Fatal("composed filter must AND both predicates")
	}
	if !composed("ReadFile") {
		t.Fatal("unrelated tools must pass")
	}

	only := BuildComposedToolFilter(coordinator, nil)
	if only("Bash") || !only("Grep") {
		t.Fatal("nil skill filter must leave the coordinator predicate untouched")
	}
}
