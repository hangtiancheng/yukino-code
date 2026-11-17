package agent

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/history"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func steeringInput(text string) *history.InputEntry {
	return &history.InputEntry{ID: uuid.NewString(), Timestamp: 123456789, Text: text}
}

func TestSteeringKeepsTextOnlyRunAliveAndPersistsIdentity(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	client := &dynamicMock{handlers: []func([]conversation.Message) []llm.StreamEvent{
		func([]conversation.Message) []llm.StreamEvent {
			return []llm.StreamEvent{llm.TextDelta{Text: "first"}, llm.StreamEnd{StopReason: "end_turn"}}
		},
		func(messages []conversation.Message) []llm.StreamEvent {
			last := messages[len(messages)-1]
			if last.Content != "correction" || last.UserInput == nil {
				t.Errorf("next request lost steering: %+v", last)
			}
			return []llm.StreamEvent{llm.TextDelta{Text: "second"}, llm.StreamEnd{StopReason: "end_turn"}}
		},
	}}
	ag := New(client, tools.NewRegistry(), "anthropic")
	ag.WorkDir, ag.SessionID = t.TempDir(), "steering-test"
	input := steeringInput("correction")
	if _, err := ag.Steer(" correction ", input); err != nil {
		t.Fatal(err)
	}
	conv := conversation.NewManager()
	conv.AddUserMessage("hi")
	events := collectEvents(ag.Run(context.Background(), conv))
	turn, delivered := -1, -1
	for i, event := range events {
		switch e := event.(type) {
		case TurnComplete:
			if turn < 0 {
				turn = i
			}
		case SteeringDelivered:
			delivered = i
			if e.InputID != input.ID || e.Text != "correction" {
				t.Fatalf("wrong delivery: %+v", e)
			}
		}
	}
	if turn < 0 || delivered <= turn || client.callIdx != 2 {
		t.Fatalf("wrong ordering: %+v", events)
	}
	saved, _ := session.LoadSessionForResume(ag.WorkDir, ag.SessionID)
	found := false
	for _, message := range saved {
		if message.Content == "correction" {
			found = message.UserInput != nil && message.UserInput.ID == input.ID && message.UserInput.Timestamp == input.Timestamp
		}
	}
	if !found {
		t.Fatal("steering identity missing from transcript")
	}
}

func TestSteeringAfterToolResultsBeforeNextRequest(t *testing.T) {
	client := &dynamicMock{handlers: []func([]conversation.Message) []llm.StreamEvent{}}
	ag := New(client, tools.NewRegistry(), "anthropic")
	client.handlers = []func([]conversation.Message) []llm.StreamEvent{
		func([]conversation.Message) []llm.StreamEvent {
			ag.Steer("mid-run", steeringInput("mid-run"))
			return []llm.StreamEvent{llm.ToolCallComplete{ToolID: "echo", ToolName: "Echo"}, llm.StreamEnd{StopReason: "tool_use"}}
		},
		func(messages []conversation.Message) []llm.StreamEvent {
			if messages[len(messages)-1].Content != "mid-run" || len(messages[len(messages)-2].ToolResults) != 1 {
				t.Error("steering did not follow tool results")
			}
			return []llm.StreamEvent{llm.StreamEnd{StopReason: "end_turn"}}
		},
	}
	ag.Registry.Register(&mockTool{name: "Echo", result: "echoed"})
	conv := conversation.NewManager()
	conv.AddUserMessage("hi")
	events := collectEvents(ag.Run(context.Background(), conv))
	resultIndex, turnIndex, steeringIndex := -1, -1, -1
	for i, event := range events {
		switch event.(type) {
		case ToolResultEvent:
			resultIndex = i
		case TurnComplete:
			if turnIndex < 0 {
				turnIndex = i
			}
		case SteeringDelivered:
			steeringIndex = i
		}
	}
	if resultIndex < 0 || turnIndex <= resultIndex || steeringIndex <= turnIndex {
		t.Fatalf("wrong event ordering: %+v", events)
	}
}

func TestSteeringRemoveDrainAndCancellation(t *testing.T) {
	ag := New(&mockClient{}, tools.NewRegistry(), "anthropic")
	first, second := steeringInput("first"), steeringInput("second")
	ag.Steer("first", first)
	ag.Steer("second", second)
	if !ag.RemoveSteering(first.ID) || ag.RemoveSteering(first.ID) {
		t.Fatal("recall must remove exactly once")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	events := collectEvents(ag.Run(ctx, conversation.NewManager()))
	for _, event := range events {
		if _, ok := event.(SteeringDelivered); ok {
			t.Fatal("delivered after cancellation")
		}
	}
	left := ag.DrainSteering()
	if len(left) != 1 || left[0].Input.ID != second.ID || len(ag.DrainSteering()) != 0 {
		t.Fatalf("undelivered messages lost: %+v", left)
	}
	if input, err := ag.Steer(" \n ", nil); err != nil || input != nil {
		t.Fatal("empty steering must be ignored")
	}
}

func TestSteeringPersistenceFailureSurfaces(t *testing.T) {
	ag := New(&mockClient{responses: [][]llm.StreamEvent{{llm.StreamEnd{StopReason: "end_turn"}}}}, tools.NewRegistry(), "anthropic")
	ag.TranscriptPath = t.TempDir()
	ag.Steer("note", steeringInput("note"))
	events := collectEvents(ag.Run(context.Background(), conversation.NewManager()))
	found := false
	for _, event := range events {
		if err, ok := event.(ErrorEvent); ok && err.Message != "" {
			found = true
		}
	}
	if !found {
		t.Fatalf("persistence failure hidden: %+v", events)
	}
}
