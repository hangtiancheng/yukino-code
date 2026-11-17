package teams

import (
	"fmt"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/permissions"
)

type pendingPlanApproval struct {
	Request   FileMailMessage
	Responded bool
}

func (t *Team) SubmitPlan(name, plan string) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	member := t.Members[name]
	if member == nil || !member.Active || member.Checker == nil || member.Checker.ReadOnly || member.Checker.Mode() != permissions.ModePlan {
		return "", fmt.Errorf("Only an active teammate in plan mode can submit a plan.")
	}
	if strings.TrimSpace(plan) == "" {
		return "", fmt.Errorf("A non-empty plan is required for review.")
	}
	if member.PendingPlan != nil {
		return "", fmt.Errorf("This teammate already has a plan awaiting review.")
	}
	request := NewPlanApprovalRequest(name, plan)
	if err := t.MailBox.Send(LeadName, request); err != nil {
		return "", err
	}
	member.PendingPlan = &pendingPlanApproval{Request: request}
	if t.RequiresLeaderPlanApproval {
		member.PlanApprovalRequired = true
	}
	return request.RequestID, nil
}
func (t *Team) RespondToPlan(name, requestID string, approve bool, feedback string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.RequiresLeaderPlanApproval {
		return fmt.Errorf("Teammate plans are automatically approved outside coordinator mode.")
	}
	member := t.Members[name]
	if member == nil || !member.Active || member.PendingPlan == nil || member.PendingPlan.Request.RequestID != requestID {
		return fmt.Errorf("No matching pending plan approval request for this teammate.")
	}
	if member.PendingPlan.Responded {
		return fmt.Errorf("This plan approval request already has a leader response.")
	}
	if strings.TrimSpace(feedback) == "" {
		return fmt.Errorf("Plan approval responses require the leader's review feedback.")
	}
	if err := t.MailBox.Send(name, NewPlanApprovalResponse(LeadName, requestID, approve, feedback)); err != nil {
		return err
	}
	member.PendingPlan.Responded = true
	return nil
}
