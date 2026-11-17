package a2a

import (
	"strings"
	"testing"
	"time"

	a2alib "github.com/a2aproject/a2a-go/a2a"

	"github.com/yukino-js/yukino/yukino/internal/agent"
)

func userMessage(parts ...*a2alib.Part) *a2alib.Message {
	return &a2alib.Message{
		ID:     a2alib.NewMessageID(),
		Role:   a2alib.MessageRoleUser,
		Parts:  parts,
		TaskID: "task-1",
	}
}

func TestMessageText(t *testing.T) {
	msg := userMessage(TextPart("hello"), DataPart(map[string]any{"x": 1}), TextPart(" world "))
	if got := MessageText(msg); got != "hello\n\n world" {
		t.Errorf("MessageText = %q", got)
	}
	if got := MessageText(userMessage(DataPart(map[string]any{"x": 1}))); got != "" {
		t.Errorf("data-only message text = %q", got)
	}
}

func TestFindPermissionResponse(t *testing.T) {
	valid := map[string]any{
		"yukino":       "permission-response",
		"permissionId": "perm-1",
		"decision":     "allow",
	}
	msg := userMessage(DataPart(valid))
	found := FindPermissionResponse(msg)
	if found == nil || found.PermissionID != "perm-1" || found.Decision != DecisionAllow {
		t.Fatalf("FindPermissionResponse = %+v", found)
	}

	invalid := []map[string]any{
		{"yukino": "permission-request", "permissionId": "p", "decision": "allow"},
		{"yukino": "permission-response", "permissionId": 42, "decision": "allow"},
		{"yukino": "permission-response", "permissionId": "p", "decision": "maybe"},
		{"yukino": "permission-response", "decision": "allow"},
		{"permissionId": "p", "decision": "allow"},
	}
	for i, value := range invalid {
		if got := FindPermissionResponse(userMessage(DataPart(value))); got != nil {
			t.Errorf("case %d: expected nil, got %+v", i, got)
		}
	}
	for _, decision := range []string{"allow", "deny", "allowAlways"} {
		value := map[string]any{"yukino": "permission-response", "permissionId": "p", "decision": decision}
		if got := FindPermissionResponse(userMessage(DataPart(value))); got == nil {
			t.Errorf("decision %q must parse", decision)
		}
	}
}

func TestAgentEventToMessage(t *testing.T) {
	msg := AgentEventToMessage(agent.StreamText{Text: "hi"}, "task-1", "ctx-1")
	if msg == nil || msg.Role != a2alib.MessageRoleAgent || msg.TaskID != "task-1" || msg.ContextID != "ctx-1" {
		t.Fatalf("stream text message = %+v", msg)
	}
	if msg.Parts[0].Text() != "hi" || msg.Parts[0].MediaType != "text/plain" {
		t.Errorf("part = %+v", msg.Parts[0])
	}

	msg = AgentEventToMessage(agent.ThinkingText{Text: "deep"}, "t", "c")
	data, ok := msg.Parts[0].Content.(a2alib.Data)
	if !ok {
		t.Fatalf("thinking part content = %T", msg.Parts[0].Content)
	}
	thinking := data.Value.(ThinkingData)
	if thinking.Yukino != ThinkingKind || thinking.Text != "deep" {
		t.Errorf("thinking data = %+v", thinking)
	}
	if msg.Parts[0].MediaType != "application/json" {
		t.Errorf("data part media type = %q", msg.Parts[0].MediaType)
	}

	msg = AgentEventToMessage(agent.ToolUseEvent{ToolID: "tc1", ToolName: "Bash", Args: map[string]any{"command": "ls"}}, "t", "c")
	call := msg.Parts[0].Content.(a2alib.Data).Value.(ToolCallData)
	if call.Yukino != ToolCallKind || call.ToolCallID != "tc1" || call.ToolName != "Bash" || call.Args["command"] != "ls" {
		t.Errorf("tool call data = %+v", call)
	}

	msg = AgentEventToMessage(agent.ToolResultEvent{ToolID: "tc1", ToolName: "Bash", Output: "ok", Elapsed: 1500 * time.Millisecond}, "t", "c")
	result := msg.Parts[0].Content.(a2alib.Data).Value.(ToolResultData)
	if result.Yukino != ToolResultKind || result.Output != "ok" || result.Elapsed != 1.5 || result.IsError {
		t.Errorf("tool result data = %+v", result)
	}

	long := strings.Repeat("x", MaxToolOutputLength+100)
	msg = AgentEventToMessage(agent.ToolResultEvent{Output: long}, "t", "c")
	result = msg.Parts[0].Content.(a2alib.Data).Value.(ToolResultData)
	if len(result.Output) != MaxToolOutputLength+len(TruncationMarker) || !strings.HasSuffix(result.Output, TruncationMarker) {
		t.Errorf("truncated output length = %d", len(result.Output))
	}

	if msg := AgentEventToMessage(agent.UsageEvent{InputTokens: 1}, "t", "c"); msg != nil {
		t.Errorf("usage events must not map to a message: %+v", msg)
	}
}

func TestTaskSnapshotAndStatusUpdate(t *testing.T) {
	snapshot := TaskSnapshot("t1", "c1", a2alib.TaskStateSubmitted, nil)
	if snapshot.ID != "t1" || snapshot.ContextID != "c1" || snapshot.Status.State != a2alib.TaskStateSubmitted || snapshot.Status.Timestamp == nil {
		t.Errorf("snapshot = %+v", snapshot)
	}
	update := StatusUpdate("t1", "c1", a2alib.TaskStateWorking, AgentMessage("t1", "c1", TextPart("x")))
	if update.TaskID != "t1" || update.Status.State != a2alib.TaskStateWorking || update.Status.Message == nil {
		t.Errorf("update = %+v", update)
	}
}
