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

package memory

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/hangtiancheng/yukino-code/yukino/permissions"
	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

// commandTool is a minimal command-category tool used to assert that the scoped
// checker denies every command regardless of arguments.
type commandTool struct{}

func (commandTool) Name() string                 { return "Bash" }
func (commandTool) Description() string          { return "" }
func (commandTool) Category() tools.ToolCategory { return tools.CategoryCommand }
func (commandTool) Schema() map[string]any       { return nil }
func (commandTool) Execute(_ context.Context, _ map[string]any) tools.ToolResult {
	return tools.ToolResult{}
}

func TestSubAgentCheckerDeniesCommands(t *testing.T) {
	chk := NewSubAgentChecker(t.TempDir(), "", false)
	d := chk.Check(commandTool{}, map[string]any{"command": "ls"})
	if d.Effect != permissions.Deny {
		t.Fatalf("command category should be denied, got %q (%s)", d.Effect, d.Reason)
	}
}

func TestSubAgentCheckerWriteScope(t *testing.T) {
	projectRoot := t.TempDir()
	userMem := t.TempDir()
	chk := NewSubAgentChecker(projectRoot, userMem, false)

	reg := NewMemoryToolRegistry()
	write := reg.Get("WriteFile")

	// A .md inside the project memory dir is allowed.
	projMemMD := filepath.Join(projectRoot, ".yukino", "memory", "note.md")
	if d := chk.Check(write, map[string]any{"file_path": projMemMD}); d.Effect != permissions.Allow {
		t.Errorf("project memory .md write should be allowed, got %q (%s)", d.Effect, d.Reason)
	}

	// A .md inside the user memory dir is allowed.
	userMD := filepath.Join(userMem, "feedback.md")
	if d := chk.Check(write, map[string]any{"file_path": userMD}); d.Effect != permissions.Allow {
		t.Errorf("user memory .md write should be allowed, got %q (%s)", d.Effect, d.Reason)
	}

	// A non-.md inside the memory dir is denied.
	if d := chk.Check(write, map[string]any{"file_path": filepath.Join(projectRoot, ".yukino", "memory", "x.txt")}); d.Effect != permissions.Deny {
		t.Errorf("non-.md memory write should be denied, got %q", d.Effect)
	}

	// A .md outside the memory dirs is denied.
	if d := chk.Check(write, map[string]any{"file_path": filepath.Join(projectRoot, "src", "a.md")}); d.Effect != permissions.Deny {
		t.Errorf("out-of-memory write should be denied, got %q", d.Effect)
	}
}

func TestSubAgentCheckerReadScope(t *testing.T) {
	projectRoot := t.TempDir()
	userMem := t.TempDir()
	reg := NewMemoryToolRegistry()
	read := reg.Get("ReadFile")

	// allowProjectReads=false: a project file outside memory is denied.
	strict := NewSubAgentChecker(projectRoot, userMem, false)
	if d := strict.Check(read, map[string]any{"file_path": filepath.Join(projectRoot, "src", "a.go")}); d.Effect != permissions.Deny {
		t.Errorf("strict read outside memory should be denied, got %q", d.Effect)
	}

	// allowProjectReads=true: the same project file is allowed.
	loose := NewSubAgentChecker(projectRoot, userMem, true)
	if d := loose.Check(read, map[string]any{"file_path": filepath.Join(projectRoot, "src", "a.go")}); d.Effect != permissions.Allow {
		t.Errorf("project read should be allowed when allowProjectReads, got %q (%s)", d.Effect, d.Reason)
	}

	// A memory-dir read is allowed in both.
	memMD := filepath.Join(projectRoot, ".yukino", "memory", "note.md")
	if d := strict.Check(read, map[string]any{"file_path": memMD}); d.Effect != permissions.Allow {
		t.Errorf("memory read should be allowed, got %q", d.Effect)
	}
}
