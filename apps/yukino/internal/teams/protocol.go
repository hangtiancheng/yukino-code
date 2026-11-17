package teams

import (
	"crypto/rand"
	"encoding/hex"
)

const (
	MsgText                 = "text"
	MsgShutdownRequest      = "shutdown_request"
	MsgShutdownResponse     = "shutdown_response"
	MsgPlanApprovalRequest  = "plan_approval_request"
	MsgPlanApprovalResponse = "plan_approval_response"
)

func NewRequestID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "req-0"
	}
	return "req-" + hex.EncodeToString(b[:])
}

func NewShutdownRequest(from, reason string) FileMailMessage {
	if reason == "" {
		reason = "team is wrapping up"
	}
	return newTyped(from, MsgShutdownRequest, NewRequestID(), reason)
}

func NewShutdownResponse(from, requestID string, approve bool, reason string) FileMailMessage {
	m := newTyped(from, MsgShutdownResponse, requestID, reason)
	m.Approve = &approve
	return m
}

func NewPlanApprovalRequest(from, plan string) FileMailMessage {
	return newTyped(from, MsgPlanApprovalRequest, NewRequestID(), plan)
}

func NewPlanApprovalResponse(from, requestID string, approve bool, feedback string) FileMailMessage {
	m := newTyped(from, MsgPlanApprovalResponse, requestID, feedback)
	m.Approve = &approve
	return m
}

func newTyped(from, msgType, requestID, text string) FileMailMessage {
	m := NewFileMailMessage(from, text)
	m.Type = msgType
	m.RequestID = requestID
	return m
}

func IsShutdownRequest(m FileMailMessage) bool {
	return m.From == LeadName && m.Type == MsgShutdownRequest && m.RequestID != ""
}

func (m FileMailMessage) Approved() bool {
	return m.Approve != nil && *m.Approve
}
