package remote

import (
	"context"
	"testing"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func newPendingServer() *Server {
	return NewServer(nil, nil, nil, "", false, 0, nil, true)
}

func TestPendingPermissionCancelAndNormalization(t *testing.T) {
	s := newPendingServer()
	ch := make(chan agent.PermissionReply, 1)
	ctx, cancel := context.WithCancel(context.Background())
	s.requestPermission(ctx, permissionRequestPayload{ToolName: "Bash", Description: "go test"}, ch)
	if len(s.pendingPerms) != 1 || len(s.pendingPermPayloads) != 1 || len(s.pendingPermTimers) != 1 {
		t.Fatal("request was not registered")
	}
	cancel()
	select {
	case reply := <-ch:
		if reply.Response != agent.PermDeny {
			t.Fatal(reply)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled request did not settle")
	}
	if len(s.pendingPerms) != 0 || len(s.pendingPermPayloads) != 0 || len(s.pendingPermTimers) != 0 {
		t.Fatal("canceled request was not removed")
	}

	noPatterns := make(chan agent.PermissionReply, 1)
	s.requestPermission(context.Background(), permissionRequestPayload{ToolName: "Bash", Description: "go test"}, noPatterns)
	var id string
	for key := range s.pendingPerms {
		id = key
	}
	s.handlePermissionResponse(permResponseData{ID: id, Response: "allowAlways"})
	if reply := <-noPatterns; reply.Response != agent.PermAllow {
		t.Fatal(reply)
	}

	withPatterns := make(chan agent.PermissionReply, 1)
	s.requestPermission(context.Background(), permissionRequestPayload{ToolName: "Bash", Description: "go test", RememberPatterns: []string{"Bash(go test*)"}}, withPatterns)
	for key := range s.pendingPerms {
		id = key
	}
	s.handlePermissionResponse(permResponseData{ID: id, Response: "allowAlways"})
	if reply := <-withPatterns; reply.Response != agent.PermAllowAlways {
		t.Fatal(reply)
	}
	if len(s.pendingPerms) != 0 || len(s.pendingPermPayloads) != 0 || len(s.pendingPermTimers) != 0 {
		t.Fatal("resolved requests were not removed")
	}
}

func TestPendingAskCancelAndResponse(t *testing.T) {
	s := newPendingServer()
	ch := make(chan tools.QuestionResponse, 1)
	ctx, cancel := context.WithCancel(context.Background())
	s.requestAskUser(ctx, []map[string]any{{"text": "Continue?"}}, ch)
	if len(s.pendingAsks) != 1 || len(s.pendingAskPayloads) != 1 || len(s.pendingAskTimers) != 1 {
		t.Fatal("question was not registered")
	}
	cancel()
	select {
	case reply := <-ch:
		if len(reply.Answers) != 0 {
			t.Fatal(reply)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled question did not settle")
	}

	s.requestAskUser(context.Background(), []map[string]any{{"text": "Continue?"}}, ch)
	var id string
	for key := range s.pendingAsks {
		id = key
	}
	s.handleAskUserResponse(askUserResponseData{ID: id, Answers: map[string]string{"q": "yes"}})
	if reply := <-ch; reply.Answers["q"] != "yes" {
		t.Fatal(reply)
	}
	if len(s.pendingAsks) != 0 || len(s.pendingAskPayloads) != 0 || len(s.pendingAskTimers) != 0 {
		t.Fatal("resolved question was not removed")
	}
}

func TestCancelActiveRunSettlesPendingRequests(t *testing.T) {
	s := newPendingServer()
	perm := make(chan agent.PermissionReply, 1)
	ask := make(chan tools.QuestionResponse, 1)
	s.requestPermission(context.Background(), permissionRequestPayload{ToolName: "Bash", Description: "go test"}, perm)
	s.requestAskUser(context.Background(), []map[string]any{{"text": "Continue?"}}, ask)
	s.cancelActiveRun()
	if reply := <-perm; reply.Response != agent.PermDeny {
		t.Fatal(reply)
	}
	if reply := <-ask; len(reply.Answers) != 0 {
		t.Fatal(reply)
	}
	if len(s.pendingPerms) != 0 || len(s.pendingAsks) != 0 {
		t.Fatal("pending requests survived cancellation")
	}
}
