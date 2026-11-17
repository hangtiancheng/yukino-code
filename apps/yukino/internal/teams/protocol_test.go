package teams

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestShutdownRequestRecognized(t *testing.T) {
	req := NewShutdownRequest(LeadName, "wrap up")
	if req.Type != MsgShutdownRequest {
		t.Errorf("Type = %q, want %q", req.Type, MsgShutdownRequest)
	}
	if req.RequestID == "" {
		t.Error("shutdown requests must carry a RequestID so responses can be matched")
	}
	if !IsShutdownRequest(req) {
		t.Error("structured shutdown requests should be recognized")
	}

	plain := NewFileMailMessage(LeadName, "[shutdown] stop")
	if IsShutdownRequest(plain) {
		t.Error("plain text cannot shut down the runtime")
	}

	normal := NewFileMailMessage(LeadName, "keep working on the auth module")
	if IsShutdownRequest(normal) {
		t.Error("a normal message was misdetected as a shutdown request")
	}
}

func TestShutdownResponseCarriesDecision(t *testing.T) {
	req := NewShutdownRequest(LeadName, "wrap up")

	yes := NewShutdownResponse("alice", req.RequestID, true, "done")
	if !yes.Approved() {
		t.Error("Approved() must be true for an approving response")
	}
	if yes.RequestID != req.RequestID {
		t.Errorf("response RequestID = %q, must echo %q", yes.RequestID, req.RequestID)
	}

	no := NewShutdownResponse("alice", req.RequestID, false, "tests still running")
	if no.Approved() {
		t.Error("Approved() must be false for a rejecting response")
	}

	silent := NewFileMailMessage("alice", "")
	if silent.Approved() {
		t.Error("a missing Approve field must not count as approval")
	}
}

func TestPlanApprovalRoundTrip(t *testing.T) {
	req := NewPlanApprovalRequest("alice", "1. read the auth package\n2. extract the interface")
	if req.Type != MsgPlanApprovalRequest || req.RequestID == "" {
		t.Fatalf("plan request built incorrectly: %+v", req)
	}
	if !strings.Contains(req.Text, "extract the interface") {
		t.Error("the full plan must live in Text")
	}

	rej := NewPlanApprovalResponse(LeadName, req.RequestID, false, "do not touch the handler layer")
	if rej.Approved() {
		t.Error("a rejection must not approve")
	}
	if rej.Text != "do not touch the handler layer" {
		t.Errorf("rejection feedback must live in Text, got %q", rej.Text)
	}
	if rej.RequestID != req.RequestID {
		t.Error("responses must echo the original RequestID")
	}
}

func TestTypedFieldsSurviveJSON(t *testing.T) {
	req := NewShutdownRequest(LeadName, "wrap up")
	resp := NewShutdownResponse("alice", req.RequestID, false, "not done yet")

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("serialization failed: %v", err)
	}
	var got FileMailMessage
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("deserialization failed: %v", err)
	}
	if got.Type != MsgShutdownResponse || got.RequestID != req.RequestID {
		t.Errorf("type or request ID lost through serialization: %+v", got)
	}
	if got.Approve == nil || *got.Approve {
		t.Errorf("Approve=false lost through serialization: %+v", got.Approve)
	}
}

func TestRequestIDsAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		id := NewRequestID()
		if seen[id] {
			t.Fatalf("request ID collision: %s", id)
		}
		seen[id] = true
	}
}
