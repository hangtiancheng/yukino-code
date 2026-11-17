package a2a

import (
	"strings"
	"time"

	a2alib "github.com/a2aproject/a2a-go/a2a"

	"github.com/yukino-js/yukino/yukino/internal/agent"
)

// PermissionDecision is one of "allow", "deny" or "allowAlways".
type PermissionDecision string

const (
	DecisionAllow       PermissionDecision = "allow"
	DecisionDeny        PermissionDecision = "deny"
	DecisionAllowAlways PermissionDecision = "allowAlways"
)

type PermissionSource struct {
	AgentName string `json:"agentName"`
	Cwd       string `json:"cwd"`
}

type PermissionRequestData struct {
	Yukino       string            `json:"yukino"`
	PermissionID string            `json:"permissionId"`
	ToolCallID   string            `json:"toolCallId"`
	ToolName     string            `json:"toolName"`
	Reason       string            `json:"reason"`
	Args         map[string]any    `json:"args"`
	Source       *PermissionSource `json:"source,omitempty"`
}

type PermissionResponseData struct {
	Yukino       string             `json:"yukino"`
	PermissionID string             `json:"permissionId"`
	Decision     PermissionDecision `json:"decision"`
}

type ThinkingData struct {
	Yukino string `json:"yukino"`
	Text   string `json:"text"`
}

type ToolCallData struct {
	Yukino     string         `json:"yukino"`
	ToolCallID string         `json:"toolCallId"`
	ToolName   string         `json:"toolName"`
	Args       map[string]any `json:"args"`
}

type ToolResultData struct {
	Yukino     string  `json:"yukino"`
	ToolCallID string  `json:"toolCallId"`
	ToolName   string  `json:"toolName"`
	IsError    bool    `json:"isError"`
	Elapsed    float64 `json:"elapsed"`
	Output     string  `json:"output"`
}

// ParsePermissionResponseData validates a structured data value against the
// permission-response schema (zod safeParse equivalent).
func ParsePermissionResponseData(value any) (*PermissionResponseData, bool) {
	obj, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	if obj[YukinoDataKey] != PermissionResponseKind {
		return nil, false
	}
	permissionID, ok := obj["permissionId"].(string)
	if !ok {
		return nil, false
	}
	decision, ok := obj["decision"].(string)
	if !ok {
		return nil, false
	}
	switch PermissionDecision(decision) {
	case DecisionAllow, DecisionDeny, DecisionAllowAlways:
	default:
		return nil, false
	}
	return &PermissionResponseData{Yukino: PermissionResponseKind, PermissionID: permissionID, Decision: PermissionDecision(decision)}, true
}

func TextPart(text string) *a2alib.Part {
	part := a2alib.NewTextPart(text)
	part.MediaType = "text/plain"
	return part
}

func DataPart(data any) *a2alib.Part {
	part := a2alib.NewDataPart(data)
	part.MediaType = "application/json"
	return part
}

func AgentMessage(taskID a2alib.TaskID, contextID string, parts ...*a2alib.Part) *a2alib.Message {
	return &a2alib.Message{
		ID:        a2alib.NewMessageID(),
		ContextID: contextID,
		TaskID:    taskID,
		Role:      a2alib.MessageRoleAgent,
		Parts:     parts,
	}
}

func TaskStatus(state a2alib.TaskState, message *a2alib.Message) a2alib.TaskStatus {
	now := time.Now()
	return a2alib.TaskStatus{State: state, Message: message, Timestamp: &now}
}

func StatusUpdate(taskID a2alib.TaskID, contextID string, state a2alib.TaskState, message *a2alib.Message) *a2alib.TaskStatusUpdateEvent {
	return &a2alib.TaskStatusUpdateEvent{
		TaskID:    taskID,
		ContextID: contextID,
		Status:    TaskStatus(state, message),
	}
}

func TaskSnapshot(taskID a2alib.TaskID, contextID string, state a2alib.TaskState, message *a2alib.Message) *a2alib.Task {
	return &a2alib.Task{
		ID:        taskID,
		ContextID: contextID,
		Status:    TaskStatus(state, message),
	}
}

// MessageText extracts and concatenates the text parts of a message.
func MessageText(message *a2alib.Message) string {
	var chunks []string
	for _, part := range message.Parts {
		if part == nil {
			continue
		}
		if _, ok := part.Content.(a2alib.Text); ok {
			chunks = append(chunks, part.Text())
		}
	}
	return strings.TrimSpace(strings.Join(chunks, "\n\n"))
}

func partData(message *a2alib.Message) []any {
	var values []any
	for _, part := range message.Parts {
		if part == nil {
			continue
		}
		if data, ok := part.Content.(a2alib.Data); ok {
			values = append(values, data.Value)
		}
	}
	return values
}

// FindPermissionResponse finds the first yukino permission-response data
// part, if any.
func FindPermissionResponse(message *a2alib.Message) *PermissionResponseData {
	for _, value := range partData(message) {
		if parsed, ok := ParsePermissionResponseData(value); ok {
			return parsed
		}
	}
	return nil
}

// AgentEventToMessage maps a yukino agent event to an A2A message, if any.
func AgentEventToMessage(event agent.AgentEvent, taskID a2alib.TaskID, contextID string) *a2alib.Message {
	switch e := event.(type) {
	case agent.StreamText:
		return AgentMessage(taskID, contextID, TextPart(e.Text))
	case agent.ThinkingText:
		return AgentMessage(taskID, contextID, DataPart(ThinkingData{Yukino: ThinkingKind, Text: e.Text}))
	case agent.ToolUseEvent:
		return AgentMessage(taskID, contextID, DataPart(ToolCallData{
			Yukino:     ToolCallKind,
			ToolCallID: e.ToolID,
			ToolName:   e.ToolName,
			Args:       e.Args,
		}))
	case agent.ToolResultEvent:
		output := e.Output
		if runes := []rune(output); len(runes) > MaxToolOutputLength {
			output = string(runes[:MaxToolOutputLength]) + TruncationMarker
		}
		return AgentMessage(taskID, contextID, DataPart(ToolResultData{
			Yukino:     ToolResultKind,
			ToolCallID: e.ToolID,
			ToolName:   e.ToolName,
			IsError:    e.IsError,
			Elapsed:    e.Elapsed.Seconds(),
			Output:     output,
		}))
	default:
		return nil
	}
}
