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

package extractor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/config"
	"github.com/hangtiancheng/yukino-code/yukino/conversation"
	"github.com/hangtiancheng/yukino-code/yukino/llm"
	"github.com/hangtiancheng/yukino-code/yukino/memory"
	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

// --- Mock infrastructure ---

type mockClient struct {
	mu       sync.Mutex
	handlers []func(msgs []conversation.Message) []llm.StreamEvent
	callIdx  int
}

func (m *mockClient) SetSystemPrompt(string) {}

func (m *mockClient) Protocol() string { return "" }

func (m *mockClient) GetThinkingLevel() config.ThinkingLevel { return config.ThinkingOff }
func (m *mockClient) SetThinkingLevel(level config.ThinkingLevel) config.ThinkingLevel {
	return level
}
func (m *mockClient) GetSupportedThinkingLevels() []config.ThinkingLevel { return nil }

func (m *mockClient) Stream(ctx context.Context, conv *conversation.Manager, toolSchemas []map[string]any) (<-chan llm.StreamEvent, <-chan error) {
	ch := make(chan llm.StreamEvent, 64)
	errCh := make(chan error, 1)
	msgs := conv.GetMessages()
	m.mu.Lock()
	idx := m.callIdx
	m.callIdx++
	m.mu.Unlock()
	go func() {
		defer close(ch)
		defer close(errCh)
		if idx >= len(m.handlers) {
			ch <- llm.StreamEnd{StopReason: "end_turn"}
			return
		}
		for _, ev := range m.handlers[idx](msgs) {
			ch <- ev
		}
	}()
	return ch, errCh
}

// --- Integration: full extraction round trip ---

func TestExtractorEndToEnd(t *testing.T) {
	tmp := t.TempDir()
	memDir := memory.GetAutoMemPath(tmp)
	if err := os.MkdirAll(memDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Parent conversation — its trailing messages feed the extraction summary.
	parent := conversation.NewManager()
	parent.AddUserMessage("Remember I'm a Go engineer")
	parent.AddAssistantMessage("Sure, I'll remember.")

	// Subagent script: write user_role.md, end turn.
	writePath := filepath.Join(memDir, "user_role.md")
	var sawMsgs []conversation.Message
	client := &mockClient{handlers: []func([]conversation.Message) []llm.StreamEvent{
		func(msgs []conversation.Message) []llm.StreamEvent {
			sawMsgs = msgs
			return []llm.StreamEvent{
				llm.TextDelta{Text: "Saving."},
				llm.ToolCallStart{ToolName: "WriteFile", ToolID: "w1"},
				llm.ToolCallComplete{
					ToolID:   "w1",
					ToolName: "WriteFile",
					Arguments: map[string]any{
						"file_path": writePath,
						"content":   "---\nname: user-role\ndescription: Go engineer\ntype: user\n---\n\nGo engineer.\n",
					},
				},
				llm.StreamEnd{StopReason: "tool_use"},
			}
		},
		func(_ []conversation.Message) []llm.StreamEvent {
			return []llm.StreamEvent{
				llm.TextDelta{Text: "Done."},
				llm.StreamEnd{StopReason: "end_turn"},
			}
		},
	}}

	var savedMsg string
	var savedMu sync.Mutex
	deps := Deps{
		MemoryDir:    memDir,
		ProjectRoot:  tmp,
		Client:       client,
		ToolRegistry: tools.NewRegistry(),
		Protocol:     "anthropic",
		Conversation: parent,
		AppendSystem: func(s string) {
			savedMu.Lock()
			savedMsg = s
			savedMu.Unlock()
		},
	}

	e := InitExtractMemories(deps)
	if err := e.Execute(context.Background()); err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}

	// The subagent conversation is a fresh blank one carrying only the
	// extraction prompt (TS extractor.ts:206-207) — no copy of the parent.
	if len(sawMsgs) != 1 || sawMsgs[0].Role != "user" {
		t.Fatalf("expected a single user message in the subagent conversation, got %+v", sawMsgs)
	}
	if !strings.Contains(sawMsgs[0].Content, "# Task\nExtract durable memories") {
		t.Errorf("subagent prompt missing extraction task:\n%s", sawMsgs[0].Content)
	}
	if !strings.Contains(sawMsgs[0].Content, "# Input: conversation") {
		t.Errorf("subagent prompt missing conversation input section:\n%s", sawMsgs[0].Content)
	}
	if !strings.Contains(sawMsgs[0].Content, "[user]: Remember I'm a Go engineer") ||
		!strings.Contains(sawMsgs[0].Content, "[assistant]: Sure, I'll remember.") {
		t.Errorf("conversation summary missing from prompt:\n%s", sawMsgs[0].Content)
	}

	// Verify file landed on disk
	if _, err := os.Stat(writePath); err != nil {
		t.Fatalf("expected user_role.md to exist after extraction: %v", err)
	}

	// Index rebuilt after saving (TS extractor.ts:242-246).
	index, err := os.ReadFile(filepath.Join(memDir, memory.AutoMemEntrypointName))
	if err != nil {
		t.Fatalf("expected MEMORY.md to be rebuilt: %v", err)
	}
	if !strings.Contains(string(index), "- [user-role](user_role.md) — Go engineer") {
		t.Errorf("rebuilt index missing entry, got: %q", string(index))
	}

	savedMu.Lock()
	got := savedMsg
	savedMu.Unlock()
	if !strings.Contains(got, "Memory saved: user_role.md") {
		t.Errorf("AppendSystem should announce saved memory, got %q", got)
	}
}

func TestExtractorTextProtocolFallback(t *testing.T) {
	tmp := t.TempDir()
	memDir := memory.GetAutoMemPath(tmp)
	userDir := filepath.Join(tmp, "userhome", ".yukino", "memory") + string(filepath.Separator)

	streamed := strings.Join([]string{
		"MEMORY_NAME: project-deadline",
		"MEMORY_TYPE: project",
		"MEMORY_DESC: release freeze date",
		"MEMORY_BODY: Merge freeze begins 2026-03-05.",
		"---",
		"MEMORY_NAME: user-role",
		"MEMORY_TYPE: user",
		"MEMORY_DESC: the human's role",
		"MEMORY_BODY: Data scientist focused on logging.",
		"---",
		"MEMORY_NAME: bad name!",
		"MEMORY_BODY: rejected",
	}, "\n")

	client := &mockClient{handlers: []func([]conversation.Message) []llm.StreamEvent{
		func(_ []conversation.Message) []llm.StreamEvent {
			return []llm.StreamEvent{
				llm.TextDelta{Text: streamed},
				llm.StreamEnd{StopReason: "end_turn"},
			}
		},
	}}

	deps := Deps{
		MemoryDir:     memDir,
		UserMemoryDir: userDir,
		ProjectRoot:   tmp,
		Client:        client,
		Protocol:      "anthropic",
	}
	e := InitExtractMemories(deps)
	saved, err := e.Extract(context.Background(), "summary text")
	if err != nil {
		t.Fatalf("Extract: %v", err)
	}
	if strings.Join(saved, ",") != "project-deadline,user-role" {
		t.Errorf("saved = %v, want [project-deadline user-role] (invalid name rejected)", saved)
	}

	projectFile := filepath.Join(memDir, "project-deadline.md")
	data, err := os.ReadFile(projectFile)
	if err != nil {
		t.Fatalf("project memory not written: %v", err)
	}
	want := "---\nname: \"project-deadline\"\ndescription: \"release freeze date\"\ntype: \"project\"\n---\n\nMerge freeze begins 2026-03-05.\n"
	if string(data) != want {
		t.Errorf("project memory content mismatch:\ngot:  %q\nwant: %q", string(data), want)
	}

	userFile := filepath.Join(userDir, "user-role.md")
	if _, err := os.ReadFile(userFile); err != nil {
		t.Errorf("user-type memory should route to the user dir: %v", err)
	}

	// Index rebuilt in the project dir after saving.
	if _, err := os.ReadFile(filepath.Join(memDir, memory.AutoMemEntrypointName)); err != nil {
		t.Errorf("expected MEMORY.md rebuild after text-protocol saves: %v", err)
	}
}

func TestExtractorTextProtocolNoneAndEmpty(t *testing.T) {
	tmp := t.TempDir()
	client := &mockClient{handlers: []func([]conversation.Message) []llm.StreamEvent{
		func(_ []conversation.Message) []llm.StreamEvent {
			return []llm.StreamEvent{
				llm.TextDelta{Text: "NONE"},
				llm.StreamEnd{StopReason: "end_turn"},
			}
		},
	}}
	e := InitExtractMemories(Deps{
		MemoryDir:   memory.GetAutoMemPath(tmp),
		ProjectRoot: tmp,
		Client:      client,
		Protocol:    "anthropic",
	})
	saved, err := e.Extract(context.Background(), "nothing worth saving")
	if err != nil {
		t.Fatalf("Extract: %v", err)
	}
	if len(saved) != 0 {
		t.Errorf("NONE should save nothing, got %v", saved)
	}
	if _, err := os.Stat(filepath.Join(memory.GetAutoMemPath(tmp), memory.AutoMemEntrypointName)); !os.IsNotExist(err) {
		t.Errorf("no saves means no index rebuild; stat err = %v", err)
	}
}

func TestExtractorStashesPendingWhileInProgress(t *testing.T) {
	tmp := t.TempDir()
	memDir := memory.GetAutoMemPath(tmp)

	release := make(chan struct{})
	var calls int32
	var callsMu sync.Mutex
	client := &mockClient{handlers: []func([]conversation.Message) []llm.StreamEvent{
		func(_ []conversation.Message) []llm.StreamEvent {
			callsMu.Lock()
			calls++
			callsMu.Unlock()
			<-release // hold the first pass open
			return []llm.StreamEvent{llm.StreamEnd{StopReason: "end_turn"}}
		},
		func(_ []conversation.Message) []llm.StreamEvent {
			callsMu.Lock()
			calls++
			callsMu.Unlock()
			return []llm.StreamEvent{llm.StreamEnd{StopReason: "end_turn"}}
		},
	}}

	e := InitExtractMemories(Deps{
		MemoryDir:   memDir,
		ProjectRoot: tmp,
		Client:      client,
		Protocol:    "anthropic",
	})

	first := make(chan struct{})
	go func() {
		_, _ = e.Extract(context.Background(), "first summary")
		close(first)
	}()

	// Wait until the first pass is in flight, then stash a trailing run.
	deadline := time.Now().Add(2 * time.Second)
	for {
		e.mu.Lock()
		in := e.inProgress
		e.mu.Unlock()
		if in {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("first extraction never entered inProgress")
		}
		time.Sleep(time.Millisecond)
	}
	_, _ = e.Extract(context.Background(), "second summary")
	e.mu.Lock()
	stashed := e.pendingContext != nil
	e.mu.Unlock()
	if !stashed {
		t.Error("concurrent Extract should stash pendingContext")
	}
	close(release)
	<-first

	callsMu.Lock()
	got := calls
	callsMu.Unlock()
	if got != 2 {
		t.Errorf("expected the trailing run to fire after the first finished, calls = %d", got)
	}
	e.mu.Lock()
	pending := e.pendingContext
	e.mu.Unlock()
	if pending != nil {
		t.Error("pendingContext should be cleared after the trailing run")
	}
}

func TestConversationSummaryWindow(t *testing.T) {
	parent := conversation.NewManager()
	for i := range 50 {
		parent.AddUserMessage("message number " + string(rune('A'+i%26)) + " with enough length to pass the filter")
	}
	e := InitExtractMemories(Deps{Conversation: parent})
	summary := e.conversationSummary()
	lines := strings.Split(summary, "\n")
	if len(lines) != summaryMessageWindow {
		t.Errorf("summary should keep the last %d messages, got %d lines", summaryMessageWindow, len(lines))
	}
	if !strings.HasPrefix(lines[0], "[user]: ") {
		t.Errorf("summary lines should be [role]: text, got %q", lines[0])
	}
	// Short messages are filtered out (TS: .filter(s => s.length > 12)).
	short := conversation.NewManager()
	short.AddUserMessage("hi")
	e2 := InitExtractMemories(Deps{Conversation: short})
	if got := e2.conversationSummary(); got != "" {
		t.Errorf("near-empty messages should be filtered, got %q", got)
	}
}

func TestExtractorDrainIdleReturnsImmediately(t *testing.T) {
	e := InitExtractMemories(Deps{})
	start := time.Now()
	_ = e.Drain(5000)
	if elapsed := time.Since(start); elapsed > 50*time.Millisecond {
		t.Errorf("Drain on idle extractor should be instant, took %s", elapsed)
	}
}
