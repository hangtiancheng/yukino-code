package session

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
)

type ToolUseRecord struct {
	ToolUseID      string         `json:"tool_use_id"`
	ToolName       string         `json:"tool_name"`
	Arguments      map[string]any `json:"arguments,omitempty"`
	ProviderItemID string         `json:"provider_item_id,omitempty"`
}

type ToolResultRecord struct {
	ToolUseID     string `json:"tool_use_id"`
	Content       string `json:"content"`
	ContentBlocks []any  `json:"content_blocks,omitempty"`
	IsError       bool   `json:"is_error,omitempty"`
}

type Message struct {
	Role           string                       `json:"role"`
	Type           string                       `json:"type,omitempty"`
	Content        string                       `json:"content"`
	ContentBlocks  []map[string]any             `json:"-"`
	Timestamp      int64                        `json:"timestamp"`
	ToolUses       []ToolUseRecord              `json:"tool_uses,omitempty"`
	ToolResults    []ToolResultRecord           `json:"tool_results,omitempty"`
	ThinkingBlocks []conversation.ThinkingBlock `json:"thinking_blocks,omitempty"`
	UserBash       *conversation.UserBashResult `json:"user_bash,omitempty"`
	UserInput      *conversation.UserInput      `json:"user_input,omitempty"`
}

type messageFields Message

func (m Message) MarshalJSON() ([]byte, error) {
	data, err := json.Marshal(messageFields(m))
	if err != nil || m.ContentBlocks == nil {
		return data, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil, err
	}
	fields["content"], err = json.Marshal(m.ContentBlocks)
	if err != nil {
		return nil, err
	}
	return json.Marshal(fields)
}

func decodeMessage(data []byte, kept bool) (Message, error) {
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return Message{}, err
	}
	if !validMessage(raw, kept) {
		return Message{}, errors.New("Invalid session record")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return Message{}, err
	}
	var blocks []map[string]any
	if content, ok := raw["content"].([]any); ok {
		blocks = make([]map[string]any, len(content))
		for i, block := range content {
			blocks[i] = block.(map[string]any)
		}
		fields["content"] = json.RawMessage(`""`)
	}
	encoded, err := json.Marshal(fields)
	if err != nil {
		return Message{}, err
	}
	var m messageFields
	if err := json.Unmarshal(encoded, &m); err != nil {
		return Message{}, err
	}
	m.ContentBlocks = blocks
	return Message(m), nil
}

func (m *Message) UnmarshalJSON(data []byte) error {
	result, err := decodeMessage(data, false)
	if err == nil {
		*m = result
	}
	return err
}

func validMessage(m map[string]any, kept bool) bool {
	if m == nil || !hasString(m, "role") {
		return false
	}
	if !kept {
		if _, ok := m["timestamp"].(float64); !ok {
			return false
		}
	}
	if content, exists := m["content"]; exists {
		switch c := content.(type) {
		case string:
		case []any:
			for _, block := range c {
				if _, ok := block.(map[string]any); !ok {
					return false
				}
			}
		default:
			return false
		}
	} else if kept {
		return false
	}
	if value, exists := m["type"]; exists {
		if _, ok := value.(string); !ok {
			return false
		}
	}
	validators := map[string]func(map[string]any) bool{
		"tool_uses": func(v map[string]any) bool {
			if !hasString(v, "tool_use_id") || !hasString(v, "tool_name") {
				return false
			}
			if value, exists := v["arguments"]; exists {
				if _, ok := value.(map[string]any); !ok {
					return false
				}
			}
			return optionalType[string](v, "provider_item_id")
		},
		"tool_results": func(v map[string]any) bool {
			if !hasString(v, "tool_use_id") || !hasString(v, "content") || !optionalType[bool](v, "is_error") {
				return false
			}
			return optionalType[[]any](v, "content_blocks")
		},
		"thinking_blocks": func(v map[string]any) bool {
			if v["type"] == "thinking" {
				return hasString(v, "thinking") && hasString(v, "signature")
			}
			return v["type"] == "redacted_thinking" && hasString(v, "data")
		},
	}
	for name, validate := range validators {
		if value, exists := m[name]; exists {
			array, ok := value.([]any)
			if !ok {
				return false
			}
			for _, item := range array {
				block, ok := item.(map[string]any)
				if !ok || !validate(block) {
					return false
				}
			}
		}
	}
	if value, exists := m["user_input"]; exists {
		v, ok := value.(map[string]any)
		if !ok || !hasString(v, "id") {
			return false
		}
		id := v["id"].(string)
		if parsed, err := uuid.Parse(id); err != nil || len(id) != 36 || parsed.String() != strings.ToLower(id) {
			return false
		}
		timestamp, ok := v["timestamp"].(float64)
		if !ok || timestamp < 0 || timestamp != float64(int64(timestamp)) {
			return false
		}
	}
	if value, exists := m["user_bash"]; exists {
		v, ok := value.(map[string]any)
		if !ok || !hasString(v, "command") || !hasString(v, "output") {
			return false
		}
		if _, ok := v["isError"].(bool); !ok {
			return false
		}
		if _, ok := v["elapsed"].(float64); !ok {
			return false
		}
		if _, ok := v["excludeFromContext"].(bool); !ok {
			return false
		}
		if v["status"] != "completed" && v["status"] != "failed" && v["status"] != "stopped" {
			return false
		}
	}
	return true
}

func hasString(m map[string]any, key string) bool { _, ok := m[key].(string); return ok }
func optionalType[T any](m map[string]any, key string) bool {
	value, exists := m[key]
	if !exists {
		return true
	}
	_, ok := value.(T)
	return ok
}

func (m Message) Empty() bool {
	return m.Content == "" && len(m.ContentBlocks) == 0 && len(m.ToolUses) == 0 && len(m.ToolResults) == 0 && len(m.ThinkingBlocks) == 0
}

func FromConversation(msg conversation.Message) Message {
	rec := Message{Role: msg.Role, Content: msg.Content, ContentBlocks: msg.ContentBlocks, Timestamp: time.Now().Unix(), UserBash: msg.UserBash}
	if msg.Role == "user" {
		rec.UserInput = msg.UserInput
	}
	if msg.Role == "assistant" {
		rec.ThinkingBlocks = msg.ThinkingBlocks
	}
	for _, tu := range msg.ToolUses {
		rec.ToolUses = append(rec.ToolUses, ToolUseRecord{ToolUseID: tu.ToolUseID, ToolName: tu.ToolName, Arguments: tu.Arguments, ProviderItemID: tu.ProviderItemID})
	}
	for _, tr := range msg.ToolResults {
		record := ToolResultRecord{ToolUseID: tr.ToolUseID, Content: tr.Content, IsError: tr.IsError}
		for _, block := range tr.ContentBlocks {
			record.ContentBlocks = append(record.ContentBlocks, block)
		}
		rec.ToolResults = append(rec.ToolResults, record)
	}
	return rec
}

func (m Message) ToConversation() conversation.Message {
	msg := conversation.Message{Role: m.Role, Content: m.Content, ContentBlocks: m.ContentBlocks, UserBash: m.UserBash}
	if m.Role == "user" {
		msg.UserInput = m.UserInput
	}
	if m.Role == "assistant" {
		msg.ThinkingBlocks = m.ThinkingBlocks
	}
	for _, tu := range m.ToolUses {
		args := tu.Arguments
		if args == nil {
			args = map[string]any{}
		}
		msg.ToolUses = append(msg.ToolUses, conversation.ToolUseBlock{ToolUseID: tu.ToolUseID, ToolName: tu.ToolName, Arguments: args, ProviderItemID: tu.ProviderItemID})
	}
	for _, tr := range m.ToolResults {
		result := conversation.ToolResultBlock{ToolUseID: tr.ToolUseID, Content: tr.Content, IsError: tr.IsError}
		for _, raw := range tr.ContentBlocks {
			if block := conversation.NormalizeToolResultContentBlock(raw); block != nil {
				result.ContentBlocks = append(result.ContentBlocks, block)
			}
		}
		msg.ToolResults = append(msg.ToolResults, result)
	}
	return msg
}

type KeepMessage Message

func (m KeepMessage) MarshalJSON() ([]byte, error) {
	data, err := json.Marshal(Message(m))
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil, err
	}
	delete(fields, "timestamp")
	delete(fields, "type")
	return json.Marshal(fields)
}
func (m *KeepMessage) UnmarshalJSON(data []byte) error {
	message, err := decodeMessage(data, true)
	if err == nil {
		*m = KeepMessage(message)
	}
	return err
}
func FromConversationKeep(msg conversation.Message) KeepMessage {
	return KeepMessage(FromConversation(msg))
}
