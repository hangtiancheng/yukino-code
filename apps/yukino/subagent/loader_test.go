package subagent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeAgent(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.md")
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}
func TestAgentDefinitionReferenceFields(t *testing.T) {
	path := writeAgent(t, "\ufeff---\nname: ' custom '\ndisallowed_tools: [EditFile, WriteFile]\nsystem_prompt: custom system\nmax_turns: 25\npermission_mode: acceptEdits\nbackground: true\nworktree: true\nmodel: INHERIT\n---\n\nTask body.")
	def, err := ParseAgentFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if def.AgentType != "custom" || def.WhenToUse != "Task body." || def.InitialPrompt != "Task body." || def.SystemPrompt != "custom system" || def.Model != "INHERIT" || def.MaxTurns != 25 || def.PermissionMode != "acceptEdits" || !def.Worktree || !def.Background || len(def.DisallowedTools) != 2 {
		t.Fatalf("%+v", def)
	}
	spec := def.ToSpec()
	if spec.InitialPrompt != def.InitialPrompt || spec.SystemPromptOverride != def.SystemPrompt || spec.MaxTurns != 25 {
		t.Fatalf("%+v", spec)
	}
}
func TestAgentDefinitionRejectsInvalidFields(t *testing.T) {
	for _, fields := range []string{"name: ' '", "name: x\ndescription: null", "name: x\nmodel: 12", "name: x\nbackground: yes", "name: x\nworktree: null", "name: x\nmax_turns: 0", "name: x\nmax_turns: 1.2", "name: x\npermission_mode: bogus", "name: x\ntools: [2]"} {
		t.Run(strings.ReplaceAll(fields, "\n", "/"), func(t *testing.T) {
			if _, err := ParseAgentFile(writeAgent(t, "---\n"+fields+"\n---\nbody")); err == nil {
				t.Fatal("invalid definition accepted")
			}
		})
	}
}

// TestAgentDefinitionIntegralFloatMaxTurns pins the zod parity edge: YAML
// parses 25.0 as a float, and the reference's z.number().int() accepts
// integral floats.
func TestAgentDefinitionIntegralFloatMaxTurns(t *testing.T) {
	def, err := ParseAgentFile(writeAgent(t, "---\nname: x\nmax_turns: 25.0\n---\nbody"))
	if err != nil {
		t.Fatal(err)
	}
	if def.MaxTurns != 25 {
		t.Fatalf("MaxTurns = %d, want 25", def.MaxTurns)
	}
}
func TestAgentDefinitionDropsOldFields(t *testing.T) {
	def, err := ParseAgentFile(writeAgent(t, "---\nname: x\nmaxTurns: 12\npermissionMode: bogus\ndisallowedTools: [Bash]\n---\nbody"))
	if err != nil {
		t.Fatal(err)
	}
	if def.MaxTurns != 0 || def.PermissionMode != "" || len(def.DisallowedTools) != 0 {
		t.Fatalf("obsolete fields interpreted: %+v", def)
	}
}
func TestAgentLoaderUsesUserDirectoryAndResets(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".yukino", "agents")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "explore.md")
	os.WriteFile(path, []byte("---\nname: explore\nmodel: test-model\n---\ncustom explore"), 0600)
	project := t.TempDir()
	os.MkdirAll(filepath.Join(project, ".yukino", "agents"), 0700)
	os.WriteFile(filepath.Join(project, ".yukino", "agents", "plan.md"), []byte("---\nname: plan\n---\nproject override"), 0600)
	loader := NewAgentLoader()
	loader.LoadAll()
	if len(loader.ListNames()) != 4 || loader.Get("explore").Source != "user" || loader.Get("explore").Model != "test-model" || !loader.Get("plan").ReadOnly {
		t.Fatal(loader.agents)
	}
	os.Remove(path)
	loader.LoadAll()
	if !loader.Get("explore").ReadOnly || loader.Get("explore").Model != "" {
		t.Fatal("removed definition survived reload")
	}
}
