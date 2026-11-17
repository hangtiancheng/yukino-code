package subagent

import (
	"context"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func TestForkConversationPairsOnlyOutstandingToolsAndDeepCopies(t *testing.T) {
	parent := conversation.NewManager()
	parent.AddAssistantFull("first", []conversation.ThinkingBlock{{Thinking: "private", Signature: "sig"}}, []conversation.ToolUseBlock{{ToolUseID: "done", ToolName: "Bash", Arguments: map[string]any{"command": "ls"}}})
	parent.AddToolResultMessage("done", "real result", false)
	parent.AddAssistantFull("pending", nil, []conversation.ToolUseBlock{{ToolUseID: "pending", ToolName: "EnterPlanMode"}})
	forked, err := forkConversation(parent)
	if err != nil {
		t.Fatal(err)
	}
	messages := forked.GetMessages()
	if len(messages) != 4 || len(messages[3].ToolResults) != 1 || messages[3].ToolResults[0].ToolUseID != "pending" || messages[3].ToolResults[0].Content != InheritedToolResult {
		t.Fatal(messages)
	}
	messages[0].ToolUses[0].Arguments["command"] = "changed"
	if parent.GetMessages()[0].ToolUses[0].Arguments["command"] != "ls" || messages[0].ThinkingBlocks[0].Signature != "sig" {
		t.Fatal("fork leaked mutation or lost thinking")
	}
}
func TestDeriveSubAgentCheckerOverrideMode(t *testing.T) {
	parent := permissions.NewChecker(permissions.NewPathSandbox(t.TempDir(), true), &permissions.RuleEngine{}, permissions.ModeDefault)
	derived := deriveSubAgentChecker(parent, "plan")
	if derived == parent || !derived.IsSubagent() || derived.Mode() != permissions.ModePlan || derived.Sandbox == parent.Sandbox || derived.RuleEngine != parent.RuleEngine {
		t.Fatal("child checker did not preserve isolation")
	}
}
func TestAgentArgumentsAndDefaults(t *testing.T) {
	tool := &AgentTool{Registry: tools.NewRegistry(), TaskMgr: NewTaskManager()}
	for _, args := range []map[string]any{{"kind": "invalid"}, {"worktree": "true"}, {"fork": nil}, {"run_in_background": 1}} {
		args["description"] = "task"
		args["prompt"] = "do it"
		if result := tool.Execute(context.Background(), args); !result.IsError || !strings.Contains(result.Output, "Error:") {
			t.Fatal(args, result)
		}
	}
	result := tool.Execute(context.Background(), map[string]any{"description": "task", "prompt": "do it"})
	if !result.IsError || !strings.Contains(result.Output, "teammate execution") {
		t.Fatal("default must be teammate", result)
	}
	result = tool.Execute(context.Background(), map[string]any{"kind": "subagent", "description": "task", "prompt": "do it"})
	if !result.IsError || result.Output != ForkContextRequiredError {
		t.Fatal("fork must be explicit and independent from role", result)
	}
	props := tool.Schema()["input_schema"].(map[string]any)["properties"].(map[string]any)
	for _, key := range []string{"isolation", "name", "mode", "plan_mode_required"} {
		if props[key] != nil {
			t.Fatal("legacy schema field", key)
		}
	}
	if got := props["fork"].(map[string]any)["default"]; got != true {
		t.Fatalf("fork default = %v, want true (no config switch remains)", got)
	}
}
