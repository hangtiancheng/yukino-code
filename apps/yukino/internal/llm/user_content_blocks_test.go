package llm

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
)

func imageBlocks() []map[string]any {
	return []map[string]any{
		{"type": "text", "text": "look at this"},
		{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png", "data": "aGVsbG8="}},
	}
}

func TestBuildAnthropicMessagesUserBlocks(t *testing.T) {
	messages := []conversation.Message{
		{Role: "user", ContentBlocks: imageBlocks()},
	}
	result, err := buildAnthropicMessages(messages)
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 1 {
		t.Fatalf("messages = %d", len(result))
	}
	data, err := json.Marshal(result[0])
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(data)
	if !strings.Contains(encoded, `"type":"text"`) || !strings.Contains(encoded, "look at this") {
		t.Fatalf("missing text block: %s", encoded)
	}
	if !strings.Contains(encoded, `"type":"image"`) || !strings.Contains(encoded, `"media_type":"image/png"`) || !strings.Contains(encoded, `"data":"aGVsbG8="`) {
		t.Fatalf("missing base64 image block: %s", encoded)
	}
}

func TestBuildAnthropicMessagesPlainUserUnchanged(t *testing.T) {
	result, err := buildAnthropicMessages([]conversation.Message{{Role: "user", Content: "hello"}})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(result)
	if !strings.Contains(string(data), `"text":"hello"`) {
		t.Fatalf("plain user message changed: %s", data)
	}
}

func TestBuildAnthropicMessagesMergesBlocksIntoPreviousUser(t *testing.T) {
	messages := []conversation.Message{
		{Role: "user", Content: "first"},
		{Role: "user", ContentBlocks: imageBlocks()},
	}
	result, err := buildAnthropicMessages(messages)
	if err != nil {
		t.Fatal(err)
	}
	if len(result) != 1 {
		t.Fatalf("consecutive user turns must merge, got %d messages", len(result))
	}
	data, _ := json.Marshal(result[0])
	encoded := string(data)
	if !strings.Contains(encoded, "first") || !strings.Contains(encoded, `"type":"image"`) {
		t.Fatalf("merged content wrong: %s", encoded)
	}
}

func TestBuildAnthropicMessagesToolResultTrailingBlocks(t *testing.T) {
	messages := []conversation.Message{
		{Role: "user", Content: "run it"},
		{
			Role:     "assistant",
			Content:  "calling",
			ToolUses: []conversation.ToolUseBlock{{ToolUseID: "t1", ToolName: "Bash", Arguments: map[string]any{}}},
		},
		{
			Role:          "user",
			ToolResults:   []conversation.ToolResultBlock{{ToolUseID: "t1", Content: "done"}},
			ContentBlocks: imageBlocks(),
		},
	}
	result, err := buildAnthropicMessages(messages)
	if err != nil {
		t.Fatal(err)
	}
	last := result[len(result)-1]
	data, _ := json.Marshal(last)
	encoded := string(data)
	if !strings.Contains(encoded, `"type":"tool_result"`) || !strings.Contains(encoded, `"type":"image"`) {
		t.Fatalf("tool result message must carry trailing image blocks: %s", encoded)
	}
}

func TestBuildOpenAIInputUserBlocks(t *testing.T) {
	input := buildOpenAIInput([]conversation.Message{{Role: "user", ContentBlocks: imageBlocks()}})
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(data)
	if !strings.Contains(encoded, `"type":"input_text"`) || !strings.Contains(encoded, "look at this") {
		t.Fatalf("missing input_text part: %s", encoded)
	}
	if !strings.Contains(encoded, `"type":"input_image"`) || !strings.Contains(encoded, "data:image/png;base64,aGVsbG8=") || !strings.Contains(encoded, `"detail":"auto"`) {
		t.Fatalf("missing input_image part: %s", encoded)
	}
}

func TestBuildOpenAIInputPlainUserUnchanged(t *testing.T) {
	input := buildOpenAIInput([]conversation.Message{{Role: "user", Content: "hello"}})
	data, _ := json.Marshal(input)
	if !strings.Contains(string(data), `"content":"hello"`) {
		t.Fatalf("plain user content changed: %s", data)
	}
}

func TestBuildChatCompletionMessagesUserBlocks(t *testing.T) {
	result := buildChatCompletionMessages("", []conversation.Message{{Role: "user", ContentBlocks: imageBlocks()}})
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(data)
	if !strings.Contains(encoded, `"type":"text"`) || !strings.Contains(encoded, "look at this") {
		t.Fatalf("missing text part: %s", encoded)
	}
	if !strings.Contains(encoded, `"type":"image_url"`) || !strings.Contains(encoded, "data:image/png;base64,aGVsbG8=") {
		t.Fatalf("missing image_url part: %s", encoded)
	}
}

func TestBuildChatCompletionMessagesPlainUserUnchanged(t *testing.T) {
	result := buildChatCompletionMessages("", []conversation.Message{{Role: "user", Content: "hello"}})
	data, _ := json.Marshal(result)
	if !strings.Contains(string(data), `"content":"hello"`) {
		t.Fatalf("plain user content changed: %s", data)
	}
}

func TestImageDataURL(t *testing.T) {
	if got := imageDataURL(map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/jpeg", "data": "abc"}}); got != "data:image/jpeg;base64,abc" {
		t.Fatalf("base64 url = %q", got)
	}
	if got := imageDataURL(map[string]any{"type": "image", "source": map[string]any{"type": "url", "url": "https://x/y.png"}}); got != "https://x/y.png" {
		t.Fatalf("url passthrough = %q", got)
	}
	if got := imageDataURL(map[string]any{"type": "text", "text": "x"}); got != "" {
		t.Fatalf("non-image = %q", got)
	}
	if got := imageDataURL(map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "", "data": "abc"}}); got != "" {
		t.Fatalf("missing media type = %q", got)
	}
}
