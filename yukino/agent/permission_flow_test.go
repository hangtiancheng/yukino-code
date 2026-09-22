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

package agent

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/hangtiancheng/yukino-code/yukino/conversation"
	"github.com/hangtiancheng/yukino-code/yukino/llm"
	"github.com/hangtiancheng/yukino-code/yukino/permissions"
	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

// noHandlerMessage is the TS agent/index.ts output for an ask decision when
// the loop has no approval handler.
const noHandlerMessage = "Permission required, but this agent has no approval handler. The tool was not executed."

func newFlowChecker(dir string) *permissions.Checker {
	return permissions.NewChecker(
		permissions.NewPathSandbox(dir),
		permissions.NewRuleEngine(dir),
		permissions.ModeDefault,
	)
}

// unknownToolScript drives one tool call to a name that is not registered,
// then an empty final turn.
func unknownToolScript(name string) [][]llm.StreamEvent {
	return [][]llm.StreamEvent{
		{
			llm.ToolCallStart{ToolName: name, ToolID: "t1"},
			llm.ToolCallComplete{ToolID: "t1", ToolName: name, Arguments: map[string]any{"x": "y"}},
			llm.StreamEnd{StopReason: "tool_use"},
		},
		{llm.StreamEnd{StopReason: "end_turn"}},
	}
}

// TS agent/index.ts: an unknown tool name still passes the permission
// gauntlet with the fallback category "command" (tool?.category ??
// "command"); in default mode that asks, and a headless loop settles with the
// no-handler message before the executor ever sees the call.
func TestUnknownToolAsksWithCommandCategory(t *testing.T) {
	dir := t.TempDir()
	ag := New(&mockClient{responses: unknownToolScript("Mystery")}, tools.NewRegistry(), "anthropic")
	ag.WorkDir = dir
	ag.Checker = newFlowChecker(dir)
	ag.PermissionsHeadless = true

	_, events := runConversationRound(ag, conversation.NewManager(), "go")
	trs := getToolResults(events)
	if len(trs) != 1 {
		t.Fatalf("want 1 tool result, got %d", len(trs))
	}
	if trs[0].Output != noHandlerMessage || !trs[0].IsError {
		t.Errorf("output = %q (isError=%v), want the TS no-handler message", trs[0].Output, trs[0].IsError)
	}
}

// Without a checker the permission stage is skipped and the unknown tool
// settles in the executor stage with the TS wording (streaming-executor.ts).
func TestUnknownToolWithoutCheckerSettlesInExecutor(t *testing.T) {
	ag := New(&mockClient{responses: unknownToolScript("Mystery")}, tools.NewRegistry(), "anthropic")
	ag.WorkDir = t.TempDir()

	_, events := runConversationRound(ag, conversation.NewManager(), "go")
	trs := getToolResults(events)
	if len(trs) != 1 {
		t.Fatalf("want 1 tool result, got %d", len(trs))
	}
	if want := "Error: unknown tool 'Mystery'"; trs[0].Output != want || !trs[0].IsError {
		t.Errorf("output = %q (isError=%v), want %q", trs[0].Output, trs[0].IsError, want)
	}
}

// A headless loop with a real write tool: default mode asks, the ask settles
// with the no-handler message and the file is never written.
func TestHeadlessAskBlocksExecution(t *testing.T) {
	dir := t.TempDir()
	reg := tools.NewRegistry()
	reg.Register(&tools.WriteFileTool{})
	ag := New(&mockClient{responses: [][]llm.StreamEvent{
		{
			llm.ToolCallStart{ToolName: "WriteFile", ToolID: "t1"},
			llm.ToolCallComplete{ToolID: "t1", ToolName: "WriteFile", Arguments: map[string]any{
				"file_path": filepath.Join(dir, "out.txt"), "content": "x",
			}},
			llm.StreamEnd{StopReason: "tool_use"},
		},
		{llm.StreamEnd{StopReason: "end_turn"}},
	}}, reg, "anthropic")
	ag.WorkDir = dir
	ag.Checker = newFlowChecker(dir)
	ag.PermissionsHeadless = true

	_, events := runConversationRound(ag, conversation.NewManager(), "go")
	trs := getToolResults(events)
	if len(trs) != 1 || trs[0].Output != noHandlerMessage {
		t.Fatalf("unexpected tool results: %+v", trs)
	}
	if _, err := os.Stat(filepath.Join(dir, "out.txt")); err == nil {
		t.Error("the blocked write must not create the file")
	}
}

// writeScript drives one WriteFile call into dir plus an empty final turn.
func writeScript(dir, content string) [][]llm.StreamEvent {
	return [][]llm.StreamEvent{
		{
			llm.ToolCallStart{ToolName: "WriteFile", ToolID: "t1"},
			llm.ToolCallComplete{ToolID: "t1", ToolName: "WriteFile", Arguments: map[string]any{
				"file_path": filepath.Join(dir, "out.txt"), "content": content,
			}},
			llm.StreamEnd{StopReason: "tool_use"},
		},
		{llm.StreamEnd{StopReason: "end_turn"}},
	}
}

// The OnPermissionRequest callback (TS AgentConfig.onPermissionRequest, the
// path subagent loops inherit) answers asks synchronously; an allow lets the
// tool run. The callback receives the TS argument list: toolName, args, the
// ask decision and the tool_use id.
func TestOnPermissionRequestCallbackAllows(t *testing.T) {
	dir := t.TempDir()
	reg := tools.NewRegistry()
	reg.Register(&tools.WriteFileTool{})
	ag := New(&mockClient{responses: writeScript(dir, "hello")}, reg, "anthropic")
	ag.WorkDir = dir
	ag.Checker = newFlowChecker(dir)
	var seenTool, seenCallID string
	var seenEffect permissions.DecisionEffect
	ag.OnPermissionRequest = func(toolName string, args map[string]any, decision permissions.Decision, toolCallID string) (tools.PermissionAnswer, error) {
		seenTool, seenEffect, seenCallID = toolName, decision.Effect, toolCallID
		return tools.PermissionAllow, nil
	}

	_, events := runConversationRound(ag, conversation.NewManager(), "go")
	trs := getToolResults(events)
	if len(trs) != 1 || trs[0].IsError {
		t.Fatalf("allowed write should succeed, got %+v", trs)
	}
	if seenTool != "WriteFile" {
		t.Errorf("callback saw tool %q, want WriteFile", seenTool)
	}
	if seenEffect != permissions.Ask {
		t.Errorf("callback saw decision effect %q, want ask", seenEffect)
	}
	if seenCallID != "t1" {
		t.Errorf("callback saw toolCallID %q, want t1", seenCallID)
	}
	if data, err := os.ReadFile(filepath.Join(dir, "out.txt")); err != nil || string(data) != "hello" {
		t.Errorf("file not written: %v %q", err, data)
	}
}

// TS agent/index.ts: a failing onPermissionRequest settles the call with
// `Permission request failed: <msg>. The tool was not executed.` — both for a
// returned error and for a panicking handler (the Go panic guard).
func TestOnPermissionRequestFailureBlocksExecution(t *testing.T) {
	for _, tc := range []struct {
		name    string
		handler permissions.RequestHandler
	}{
		{"error", func(string, map[string]any, permissions.Decision, string) (tools.PermissionAnswer, error) {
			return "", errors.New("prompt transport died")
		}},
		{"panic", func(string, map[string]any, permissions.Decision, string) (tools.PermissionAnswer, error) {
			panic("prompt transport died")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			reg := tools.NewRegistry()
			reg.Register(&tools.WriteFileTool{})
			ag := New(&mockClient{responses: writeScript(dir, "hello")}, reg, "anthropic")
			ag.WorkDir = dir
			ag.Checker = newFlowChecker(dir)
			ag.OnPermissionRequest = tc.handler

			_, events := runConversationRound(ag, conversation.NewManager(), "go")
			trs := getToolResults(events)
			if len(trs) != 1 {
				t.Fatalf("want 1 tool result, got %d", len(trs))
			}
			want := "Permission request failed: prompt transport died. The tool was not executed."
			if trs[0].Output != want || !trs[0].IsError {
				t.Errorf("output = %q (isError=%v), want %q", trs[0].Output, trs[0].IsError, want)
			}
			if _, err := os.Stat(filepath.Join(dir, "out.txt")); err == nil {
				t.Error("the failed permission request must not execute the tool")
			}
		})
	}
}
