package commands

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

func setupPromptsDir(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	dir := storage.YukinoPath(PromptsDirName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

func writePrompt(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestLoadUserCommandsBOMFrontmatter(t *testing.T) {
	dir := setupPromptsDir(t)
	writePrompt(t, dir, "bom.md", "\uFEFF---\r\ndescription: BOM command\r\n---\r\nBody $1")
	var cmd *Command
	for _, c := range LoadUserCommands() {
		if c.Name == "bom" {
			cmd = c
		}
	}
	if cmd == nil {
		t.Fatal("bom command not loaded")
	}
	if cmd.Description != "BOM command [custom]" {
		t.Errorf("description = %q", cmd.Description)
	}
	if got := cmd.Handler(&Context{Cwd: t.TempDir(), Args: "argument"}); got != "Body argument" {
		t.Errorf("handler = %q", got)
	}
}

func TestParseCommandArgsAndRenderBody(t *testing.T) {
	args := `"two words" '' escaped\ space fourth`
	want := []string{"two words", "", "escaped space", "fourth"}
	if got := ParseCommandArgs(args); !reflect.DeepEqual(got, want) {
		t.Fatalf("parseCommandArgs = %v, want %v", got, want)
	}
	if got := RenderBody("$1 | ${2:-fallback} | ${@:3:1} | ${@:4} | ${9:-missing}", args); got != "two words | fallback | escaped space | fourth | missing" {
		t.Errorf("renderBody = %q", got)
	}
	if got := RenderBody("$ARGUMENTS", args); got != args {
		t.Errorf("$ARGUMENTS = %q", got)
	}
	if got := RenderBody("$@", args); got != "two words  escaped space fourth" {
		t.Errorf("$@ = %q", got)
	}
	if got := RenderBody("${ARGUMENTS:-default} ${@:-all}", ""); got != "default all" {
		t.Errorf("defaults = %q", got)
	}
}

func TestRenderBodyNoRecursiveSubstitution(t *testing.T) {
	if got := RenderBody("$1 | $2 | ${3:-$1}", "'$ARGUMENTS' '$@'"); got != "$ARGUMENTS | $@ | $1" {
		t.Errorf("renderBody = %q", got)
	}
	want := []string{`C:\project\file`, `a\b`}
	if got := ParseCommandArgs(`"C:\project\file" 'a\b'`); !reflect.DeepEqual(got, want) {
		t.Errorf("parseCommandArgs = %v, want %v", got, want)
	}
}

func TestLoadUserCommandsWithFrontmatter(t *testing.T) {
	dir := setupPromptsDir(t)
	writePrompt(t, dir, "deploy.md", "---\ndescription: Deploy it\n---\nDeploy $ARGUMENTS to production.")
	var deploy *Command
	for _, c := range LoadUserCommands() {
		if c.Name == "deploy" {
			deploy = c
		}
	}
	if deploy == nil {
		t.Fatal("deploy command not loaded")
	}
	if deploy.Description != "Deploy it [custom]" {
		t.Errorf("description = %q", deploy.Description)
	}
	if deploy.Type != TypePrompt {
		t.Errorf("type = %q, want prompt", deploy.Type)
	}
	if got := deploy.Handler(&Context{Cwd: t.TempDir(), Args: "staging"}); got != "Deploy staging to production." {
		t.Errorf("handler = %q", got)
	}
}

func TestLoadUserCommandsNamespacesSubdirectories(t *testing.T) {
	dir := setupPromptsDir(t)
	sub := filepath.Join(dir, "git")
	if err := os.MkdirAll(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	writePrompt(t, sub, "sync.md", "Sync the repo.")
	var cmd *Command
	for _, c := range LoadUserCommands() {
		if c.Name == "git:sync" {
			cmd = c
		}
	}
	if cmd == nil {
		t.Fatal("git:sync command not loaded")
	}
	if cmd.Description != "custom command [custom]" {
		t.Errorf("description = %q", cmd.Description)
	}
	if got := cmd.Handler(&Context{Cwd: t.TempDir(), Args: ""}); got != "Sync the repo." {
		t.Errorf("handler = %q", got)
	}
}

func TestRenderBodyAppendsArgsWithoutPlaceholder(t *testing.T) {
	if got := RenderBody("Do the thing.", "extra"); got != "Do the thing.\n\nextra" {
		t.Errorf("renderBody = %q", got)
	}
	if got := RenderBody("Echo $ARGUMENTS!", "hi"); got != "Echo hi!" {
		t.Errorf("renderBody = %q", got)
	}
	if got := RenderBody("Echo $ARGUMENTS!", "$& $$ $` $'"); got != "Echo $& $$ $` $'!" {
		t.Errorf("renderBody = %q", got)
	}
	if got := RenderBody("No args needed.", ""); got != "No args needed." {
		t.Errorf("renderBody = %q", got)
	}
}

func TestHelpListingExcludesSkillCommands(t *testing.T) {
	registry := CreateDefaultRegistry()
	registry.Register(&Command{
		Name:        "demo-skill",
		Type:        TypePrompt,
		Description: "Demo skill [skill]",
		IsSkill:     true,
		Handler:     func(ctx *Context) string { return "" },
	})
	help := registry.Find("help")
	if help == nil {
		t.Fatal("help command missing")
	}
	output := help.Handler(&Context{Cwd: t.TempDir(), Args: ""})
	if !strings.Contains(output, "/help") {
		t.Error("help listing should mention /help")
	}
	if strings.Contains(output, "demo-skill") {
		t.Error("help listing must exclude skill-derived commands")
	}
}

func TestCommandRawBodyAndAtomicFrontmatterValidation(t *testing.T) {
	dir := setupPromptsDir(t)
	writePrompt(t, dir, "raw.md", "\ufeff  indented\n\n")
	writePrompt(t, dir, "invalid.md", "---\ndescription: accepted?\nargument-hint: 42\n---\n  body  \n")
	for _, cmd := range LoadUserCommands() {
		switch cmd.Name {
		case "raw":
			if got := cmd.Handler(&Context{}); got != "  indented\n\n" {
				t.Fatal(got)
			}
		case "invalid":
			if cmd.Description != "custom command [custom]" || cmd.Handler(&Context{}) != "body" {
				t.Fatal(cmd.Description, cmd.Handler(&Context{}))
			}
		}
	}
	if got := RenderBody("before${@:1:0}after", "one two"); got != "beforeafter" {
		t.Fatal(got)
	}
	name, args, ok := Parse("/review\u3000target")
	if !ok || name != "review" || args != "target" {
		t.Fatal(name, args, ok)
	}
}
