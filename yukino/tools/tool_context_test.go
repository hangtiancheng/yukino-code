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

package tools

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// The ctx-carried file state cache is tri-state like TS ctx.fileStateCache:
// absent falls back to the instance field, present-but-nil disables the gate,
// present wins over the field.
func TestResolveFileStateCacheTriState(t *testing.T) {
	fallback := NewFileStateCache()
	ctx := context.Background()
	if got := ResolveFileStateCache(ctx, fallback); got != fallback {
		t.Error("absent key should fall back to the instance field")
	}
	if got := ResolveFileStateCache(WithFileStateCache(ctx, nil), fallback); got != nil {
		t.Error("present-but-nil should disable the cache, not fall back")
	}
	other := NewFileStateCache()
	if got := ResolveFileStateCache(WithFileStateCache(ctx, other), fallback); got != other {
		t.Error("present cache should win over the instance field")
	}
}

func TestSessionIDAndToolCallIDFromContext(t *testing.T) {
	ctx := context.Background()
	if _, ok := SessionIDFromContext(ctx); ok {
		t.Error("absent session id should report ok=false")
	}
	// An empty session id is meaningful (subagent runs) and must be present.
	if id, ok := SessionIDFromContext(WithSessionID(ctx, "")); !ok || id != "" {
		t.Errorf("present empty session id = (%q, %v), want (\"\", true)", id, ok)
	}
	if id := ToolCallIDFromContext(WithToolCallID(ctx, "toolu_1")); id != "toolu_1" {
		t.Errorf("tool call id = %q", id)
	}
}

// EditFile must gate on the ctx-carried cache even when the tool instance has
// none: shared tool instances serve subagent runs whose fresh cache lives on
// the context (TS ctx.fileStateCache).
func TestEditFileGatesOnContextCache(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.txt")
	if err := os.WriteFile(path, []byte("one"), 0o644); err != nil {
		t.Fatal(err)
	}
	tool := &EditFileTool{} // no instance cache
	ctx := WithWorkDir(context.Background(), dir)
	args := map[string]any{"file_path": "f.txt", "old_string": "one", "new_string": "two"}

	// Without any cache the gate is skipped (TS: ctx.fileStateCache undefined).
	if res := tool.Execute(ctx, args); res.IsError {
		t.Fatalf("edit without a cache should succeed: %s", res.Output)
	}

	// With a fresh ctx cache the read-before-edit gate rejects.
	args2 := map[string]any{"file_path": "f.txt", "old_string": "two", "new_string": "three"}
	ctx2 := WithFileStateCache(ctx, NewFileStateCache())
	res := tool.Execute(ctx2, args2)
	if !res.IsError {
		t.Fatal("a fresh ctx cache should gate the edit until the file is read")
	}

	// Reading through the same ctx cache unlocks the edit.
	rf := &ReadFileTool{}
	if rres := rf.Execute(ctx2, map[string]any{"file_path": "f.txt"}); rres.IsError {
		t.Fatalf("read failed: %s", rres.Output)
	}
	if res := tool.Execute(ctx2, args2); res.IsError {
		t.Fatalf("edit after read should succeed: %s", res.Output)
	}
}
