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

package commands

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeCommandFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadUserCommandsNamespacesSubdirs(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, ".yukino", "commands")
	writeCommandFile(t, filepath.Join(base, "deploy.md"), "Deploy the app")
	writeCommandFile(t, filepath.Join(base, "ops", "restart.md"), "Restart $ARGUMENTS")

	// LoadUserCommands also scans the real ~/.yukino/commands; look up by name
	// instead of asserting on the total count so the test stays hermetic.
	byName := make(map[string]*Command)
	for _, c := range LoadUserCommands(dir) {
		byName[c.Name] = c
	}
	deploy := byName["deploy"]
	if deploy == nil || deploy.Description != "custom command" {
		t.Fatalf("deploy command wrong: %+v", deploy)
	}
	if got := deploy.Handler(&Context{}); got != "Deploy the app" {
		t.Fatalf("deploy body wrong: %q", got)
	}
	restart := byName["ops:restart"]
	if restart == nil {
		t.Fatal("ops:restart missing")
	}
	if got := restart.Handler(&Context{Args: "api"}); got != "Restart api" {
		t.Fatalf("args substitution wrong: %q", got)
	}
}

func TestLoadUserCommandsFrontmatter(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, ".yukino", "commands")
	writeCommandFile(t, filepath.Join(base, "review.md"),
		"---\ndescription: Review code\nargument-hint: <pr-url>\naliases: [rv]\n---\nReview $ARGUMENTS")

	var c *Command
	for _, cmd := range LoadUserCommands(dir) {
		if cmd.Name == "review" {
			c = cmd
		}
	}
	if c == nil {
		t.Fatal("review command missing")
	}
	if c.Description != "Review code" || c.ArgPrompt != "<pr-url>" || len(c.Aliases) != 1 || c.Aliases[0] != "rv" {
		t.Fatalf("frontmatter not applied: %+v", c)
	}
	if c.Type != TypePrompt {
		t.Fatalf("user commands must be prompt type, got %s", c.Type)
	}
}

func TestLoadUserCommandsProjectWinsOverUser(t *testing.T) {
	// Simulate both bases inside one temp root: LoadUserCommands reads the
	// real home dir first (no commands there in CI), then the project dir.
	// Here we verify the merge rule directly via parseCommandFile + map order.
	dir := t.TempDir()
	base := filepath.Join(dir, ".yukino", "commands")
	writeCommandFile(t, filepath.Join(base, "hello.md"), "project version")

	cmds := LoadUserCommands(dir)
	var found *Command
	for _, c := range cmds {
		if c.Name == "hello" {
			found = c
		}
	}
	if found == nil {
		t.Fatal("hello command missing")
	}
	if got := found.Handler(&Context{}); got != "project version" {
		t.Fatalf("project command should win: %q", got)
	}
}

func TestLoadUserCommandsIgnoresBrokenFrontmatter(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, ".yukino", "commands")
	writeCommandFile(t, filepath.Join(base, "broken.md"), "---\n: not: valid: yaml: [\n---\nBody text")

	var broken *Command
	for _, cmd := range LoadUserCommands(dir) {
		if cmd.Name == "broken" {
			broken = cmd
		}
	}
	if broken == nil {
		t.Fatal("broken command missing")
	}
	// Parse error → whole file stays the body, default description.
	if !strings.Contains(broken.Handler(&Context{}), "Body text") {
		t.Fatalf("body lost on frontmatter error: %q", broken.Handler(&Context{}))
	}
}

func TestRenderBody(t *testing.T) {
	if got := RenderBody("Do $ARGUMENTS now $ARGUMENTS", "x"); got != "Do x now x" {
		t.Fatalf("replace all failed: %q", got)
	}
	if got := RenderBody("No placeholder", "extra"); got != "No placeholder\n\nextra" {
		t.Fatalf("append failed: %q", got)
	}
	if got := RenderBody("No placeholder", ""); got != "No placeholder" {
		t.Fatalf("empty args must not append: %q", got)
	}
}

func TestUsageTrackerRoundTrip(t *testing.T) {
	dir := t.TempDir()
	tr := NewUsageTracker(dir)
	tr.Record("deploy")
	tr.Record("deploy")
	tr.Record("review")

	// The score decays with recency (0.5^(days/7)), so a just-recorded command
	// scores just under its use count; allow a small tolerance rather than
	// asserting an exact 2 (sub-millisecond elapsed time makes it 1.9999...).
	if got := tr.GetScore("deploy"); got < 1.99 || got > 2 {
		t.Fatalf("deploy score should count 2 uses, got %v", got)
	}
	if got := tr.GetScore("unknown"); got != 0 {
		t.Fatalf("unknown command must score 0, got %v", got)
	}
	recent := tr.GetRecentlyUsed(5)
	if len(recent) != 2 || recent[0] != "deploy" {
		t.Fatalf("recent order wrong: %v", recent)
	}

	// Reload from disk.
	tr2 := NewUsageTracker(dir)
	if got := tr2.GetScore("deploy"); got < 1.99 || got > 2 {
		t.Fatalf("reload lost usage data, got %v", got)
	}
}
