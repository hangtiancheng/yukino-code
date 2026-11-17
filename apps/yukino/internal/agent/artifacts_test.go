package agent

import (
	"os"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func TestAnonymousArtifactsFollowConversationAndCleanUp(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	conv := conversation.NewManager()
	client := &mockClient{responses: [][]llm.StreamEvent{{llm.ToolCallComplete{ToolID: "large", ToolName: "Large"}, llm.StreamEnd{StopReason: "tool_use"}}, {llm.StreamEnd{StopReason: "end_turn"}}}}
	registry := tools.NewRegistry()
	registry.Register(&mockTool{name: "Large", result: strings.Repeat("x", 60000)})
	ag := New(client, registry, "anthropic")
	id := ag.toolResultSessionID(conv)
	if id == "" || New(nil, nil, "").toolResultSessionID(conv) != id || ag.toolResultSessionID(conversation.NewManager()) == id {
		t.Fatal("anonymous sessions must follow conversation identity")
	}
	runConversationRound(ag, conv, "read")
	if result := findToolResultsMsg(t, conv).ToolResults[0].Content; !strings.HasPrefix(result, "<persisted-output>") {
		t.Fatal("anonymous result was not spilled")
	}
	path, _ := storage.SessionPath(id)
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	tools.RunExitCleanups()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("anonymous artifacts survived cleanup")
	}
}
