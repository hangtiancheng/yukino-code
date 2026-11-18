package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/hangtiancheng/yukino-code/apps/yukino/conversation"
)

func TestOpenAIInputReference(t *testing.T) {
	data, err := os.ReadFile("testdata/openai-expected.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Cases []struct {
			Messages []conversation.Message
			Expected any
		}
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for i, c := range fixtures.Cases {
		encoded, err := json.Marshal(buildOpenAIInput(c.Messages))
		if err != nil {
			t.Fatal(err)
		}
		var got any
		json.Unmarshal(encoded, &got)
		if !reflect.DeepEqual(got, c.Expected) {
			t.Errorf("case %d got %s, want %v", i, encoded, c.Expected)
		}
	}
}

func TestOpenAINativeComputerStream(t *testing.T) {
	for _, started := range []bool{true, false} {
		t.Run(fmt.Sprint(started), func(t *testing.T) {
			item := map[string]any{"type": "computer_call", "id": "cu_1", "call_id": "call-1", "status": "completed", "pending_safety_checks": []any{map[string]any{"id": "check", "code": "review", "message": "review this"}}, "actions": []any{map[string]any{"type": "scroll", "x": 10, "y": 20, "scroll_x": 100, "scroll_y": -200, "keys": []any{"CTRL"}}}}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				send := func(event any) { data, _ := json.Marshal(event); fmt.Fprintf(w, "data: %s\n\n", data) }
				if started {
					send(map[string]any{"type": "response.output_item.added", "item": item})
				}
				send(map[string]any{"type": "response.output_item.done", "item": item})
				send(map[string]any{"type": "response.completed", "response": map[string]any{"id": "resp_1", "status": "completed", "usage": map[string]any{"input_tokens": 1, "output_tokens": 1}}})
			}))
			defer server.Close()
			client, err := newOpenAIClient(testProvider("openai", server.URL, nil), "system")
			if err != nil {
				t.Fatal(err)
			}
			stream, failures := client.Stream(context.Background(), conversation.NewManager(), nil)
			var complete *ToolCallComplete
			for event := range stream {
				if call, ok := event.(ToolCallComplete); ok {
					complete = &call
				}
			}
			var failure error
			for err := range failures {
				if err != nil {
					failure = err
				}
			}
			if !started {
				if failure == nil || !strings.Contains(failure.Error(), "without a valid start") {
					t.Fatalf("invalid lifecycle %v", failure)
				}
				return
			}
			if failure != nil {
				t.Fatal(failure)
			}
			if complete == nil || complete.ToolName != "ComputerUse" || complete.ToolID != "call-1" || complete.ProviderItemID != "cu_1" {
				t.Fatalf("call %+v", complete)
			}
			actions := complete.Arguments["actions"].([]any)
			action := actions[0].(map[string]any)
			if action["scrollX"] != float64(100) || action["scrollY"] != float64(-200) || action["scroll_x"] != nil {
				t.Fatalf("action %+v", action)
			}
		})
	}
}
