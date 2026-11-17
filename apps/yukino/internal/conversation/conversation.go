package conversation

import (
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/utils"
)

type ToolUseBlock struct {
	ToolUseID      string
	ToolName       string
	Arguments      map[string]any
	ParseError     string
	ProviderItemID string
}

type ToolResultBlock struct {
	ToolUseID     string
	Content       string
	IsError       bool
	ContentBlocks []map[string]any
}

type ThinkingBlock struct {
	Type      string `json:"type"`
	Thinking  string `json:"thinking,omitempty"`
	Signature string `json:"signature,omitempty"`
	Data      string `json:"data,omitempty"`
}

func (b ThinkingBlock) MarshalJSON() ([]byte, error) {
	if b.Type == "redacted_thinking" {
		return json.Marshal(struct {
			Type string `json:"type"`
			Data string `json:"data"`
		}{b.Type, b.Data})
	}
	return json.Marshal(struct {
		Type      string `json:"type"`
		Thinking  string `json:"thinking"`
		Signature string `json:"signature"`
	}{b.Type, b.Thinking, b.Signature})
}

type UserInput struct {
	ID        string `json:"id"`
	Timestamp int64  `json:"timestamp"`
}

type UserBashResult struct {
	Command            string  `json:"command"`
	Output             string  `json:"output"`
	IsError            bool    `json:"isError"`
	Elapsed            float64 `json:"elapsed"`
	Status             string  `json:"status"`
	ExcludeFromContext bool    `json:"excludeFromContext"`
}

type Message struct {
	Role           string
	Content        string
	ContentBlocks  []map[string]any
	ThinkingBlocks []ThinkingBlock
	ToolUses       []ToolUseBlock
	ToolResults    []ToolResultBlock
	UserBash       *UserBashResult
	UserInput      *UserInput
}

func (m Message) HasContent() bool { return m.Content != "" || len(m.ContentBlocks) > 0 }

func (m Message) ContentText() string {
	if len(m.ContentBlocks) == 0 {
		return m.Content
	}
	var parts []string
	for _, block := range m.ContentBlocks {
		if block["type"] == "text" {
			if value, ok := block["text"].(string); ok {
				parts = append(parts, value)
			}
		}
	}
	return strings.Join(parts, "\n")
}

type Manager struct {
	mu             sync.RWMutex
	history        []Message
	ltmInjected    bool
	baselineTokens int
	anchorCount    int
	hasUsage       bool
}

func NewManager() *Manager {
	return &Manager{}
}

func (m *Manager) AddUserMessage(content string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.history = append(m.history, Message{Role: "user", Content: content})
}

// AddUserMessageBlocks appends a user message whose content is a block array
// (text plus image blocks), mirroring the reference addUserMessage accepting
// string | Record<string, unknown>[].
func (m *Manager) AddUserMessageBlocks(blocks []map[string]any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.history = append(m.history, Message{Role: "user", ContentBlocks: blocks})
}

func (m *Manager) AddAssistantMessage(content string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.history = append(m.history, Message{Role: "assistant", Content: content})
}

func (m *Manager) AddToolUseMessage(text, toolUseID, toolName string, arguments map[string]any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.history = append(m.history, Message{
		Role:    "assistant",
		Content: text,
		ToolUses: []ToolUseBlock{{
			ToolUseID: toolUseID,
			ToolName:  toolName,
			Arguments: arguments,
		}},
	})
}

func (m *Manager) AddAssistantMessageWithTools(text string, toolUses []ToolUseBlock) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.history = append(m.history, Message{
		Role:     "assistant",
		Content:  text,
		ToolUses: toolUses,
	})
}

func (m *Manager) AddAssistantFull(text string, thinking []ThinkingBlock, toolUses []ToolUseBlock) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.history = append(m.history, Message{
		Role:           "assistant",
		Content:        text,
		ThinkingBlocks: thinking,
		ToolUses:       toolUses,
	})
}

func (m *Manager) AddToolResultMessage(toolUseID, content string, isError bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.history = append(m.history, Message{
		Role: "user",
		ToolResults: []ToolResultBlock{{
			ToolUseID: toolUseID,
			Content:   content,
			IsError:   isError,
		}},
	})
}

func (m *Manager) AddToolResultsMessage(results []ToolResultBlock) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.history = append(m.history, Message{
		Role:        "user",
		ToolResults: results,
	})
}

func (m *Manager) AddSystemReminder(content string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.addSystemReminder(content)
}

func (m *Manager) addSystemReminder(content string) {
	m.history = append(m.history, Message{
		Role:    "user",
		Content: WrapSystemReminder(content),
	})
}

func (m *Manager) HasReminderContaining(marker string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, msg := range m.history {
		content := any(msg.Content)
		if len(msg.ContentBlocks) > 0 {
			content = msg.ContentBlocks
		}
		if msg.Role == "user" && strings.Contains(utils.ContentToText(content), marker) {
			return true
		}
	}
	return false
}

func (m *Manager) InjectLongTermMemory(instructions, memories, skills string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ltmInjected {
		return
	}
	today := time.Now().UTC().Format("2006-01-02")
	wrapped, ok := BuildLongTermMemoryReminder(instructions, memories, skills, today)
	if !ok {
		return
	}
	m.history = append([]Message{{Role: "user", Content: wrapped}}, m.history...)
	m.ltmInjected = true
}

func (m *Manager) AppendMessages(messages []Message) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.history = append(m.history, messages...)
}

func (m *Manager) Len() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.history)
}

func (m *Manager) TruncateTo(index int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if index < 0 {
		index = 0
	}
	if index > len(m.history) {
		return
	}
	m.history = m.history[:index]
	m.clearUsageAnchor()
	if index == 0 {
		m.ltmInjected = false
	}
}

func (m *Manager) GetMessages() []Message {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]Message, len(m.history))
	copy(result, m.history)
	return result
}

func (m *Manager) ReplaceToolResults(msgIndex int, newResults []ToolResultBlock) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if msgIndex < 0 || msgIndex >= len(m.history) {
		return
	}
	m.history[msgIndex].ToolResults = newResults
}

func (m *Manager) RecordUsageAnchor(input, output, cacheRead, cacheCreation int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	baseline := input + cacheRead + cacheCreation + output
	if baseline <= 0 {
		return
	}
	m.baselineTokens = baseline
	m.anchorCount = len(m.history)
	m.hasUsage = true
}

func (m *Manager) ClearUsageAnchor() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.clearUsageAnchor()
}

func (m *Manager) clearUsageAnchor() {
	m.baselineTokens = 0
	m.anchorCount = 0
	m.hasUsage = false
}

func (m *Manager) UsageAnchorState() (baselineTokens, anchorCount int, hasUsage bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.baselineTokens, m.anchorCount, m.hasUsage
}

func (m *Manager) Fork() *Manager {
	m.mu.RLock()
	defer m.mu.RUnlock()
	data, err := json.Marshal(m.history)
	if err != nil {
		panic(err)
	}
	fork := Manager{ltmInjected: m.ltmInjected, baselineTokens: m.baselineTokens, anchorCount: m.anchorCount, hasUsage: m.hasUsage}
	if err := json.Unmarshal(data, &fork.history); err != nil {
		panic(err)
	}
	return &fork
}
func (m *Manager) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.history = nil
	m.ltmInjected = false
	m.clearUsageAnchor()
}
func (m *Manager) ReplaceWithCompacted(summary string, keep []Message) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.history = append([]Message{{Role: "user", Content: summary}}, keep...)
	m.ltmInjected = false
	m.clearUsageAnchor()
}
func (m *Manager) AddSystemReminderIfChanged(marker, content string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	prefix := SystemReminderOpen + "\n" + marker
	for i := len(m.history) - 1; i >= 0; i-- {
		msg := m.history[i]
		if msg.Role == "user" && strings.HasPrefix(msg.Content, prefix) {
			if msg.Content != WrapSystemReminder(content) {
				m.addSystemReminder(content)
			}
			return
		}
	}
	m.addSystemReminder(content)
}

func (m *Manager) UsageSnapshot() (messages []Message, baselineTokens, anchorCount int, hasUsage bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	messages = append([]Message(nil), m.history...)
	return messages, m.baselineTokens, m.anchorCount, m.hasUsage
}
