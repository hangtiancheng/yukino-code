package teams

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/plan_file"
	"github.com/yukino-js/yukino/yukino/internal/prompt"
)

const LeadName = "leader"
const IdlePollInterval = 500 * time.Millisecond

func CreateIdleNotification(name, reason string) FileMailMessage {
	return NewFileMailMessage(name, fmt.Sprintf("[idle] %s (reason: %s)", name, reason))
}

// RunInProcessTeammate mirrors the reference spawnTeammate done loop: run the
// task through the injected RunAgent, record progress from its events, then
// idle-poll the mailbox and resume on new messages until stopped or shut down.
func RunInProcessTeammate(ctx context.Context, team *Team, member *Member, runAgent RunTeammateAgent, initialPrompt string) (runErr error) {
	defer func() {
		if member.Progress != nil {
			member.Progress.ClearActiveTools()
			if ctx.Err() != nil {
				member.Progress.SetStatus("stopped")
			} else if runErr != nil {
				member.Progress.SetStatus("failed")
			} else {
				member.Progress.SetStatus("completed")
			}
		}
	}()
	onEvent := func(event TeammateProgressEvent) {
		if member.Progress == nil {
			return
		}
		switch event.Type {
		case "tool_use":
			member.Progress.RecordToolStart(event.ToolID, event.ToolName, event.Args)
		case "tool_result":
			member.Progress.RecordToolResult(event.ToolID)
		case "usage":
			member.Progress.RecordTokens(int64(event.InputTokens), int64(event.OutputTokens))
		case "turn_complete":
			member.Progress.RecordTurnComplete()
		}
	}
	nextPrompt := initialPrompt
	for team.MemberActive(member.Name) {
		member.Progress.SetStatus("running")
		result, err := runAgent(ctx, prompt.BuildTeammatePrompt(team.Name, member.Name, nextPrompt), onEvent)
		if err != nil {
			if ctx.Err() != nil || !team.MemberActive(member.Name) {
				member.Progress.SetLastMessage(TeammateStoppedMessage)
				return nil
			}
			member.Progress.SetLastMessage(err.Error())
			return err
		}
		member.Progress.ClearActiveTools()
		member.Progress.SetLastMessage(result)
		if ctx.Err() != nil || !team.MemberActive(member.Name) {
			return nil
		}
		team.mu.Lock()
		planning := planModeActive(member) && (member.PlanApprovalRequired || member.PendingPlan != nil)
		team.mu.Unlock()
		if planning {
			member.Progress.SetStatus("idle")
			next, err := requestPlanApproval(ctx, team, member, result)
			if err != nil {
				return err
			}
			if next == "" {
				return nil
			}
			nextPrompt = next
			continue
		}
		member.Progress.SetStatus("idle")
		if err := team.MailBox.Send(LeadName, CreateIdleNotification(member.Name, "available")); err != nil {
			return err
		}
		next, shutdown, err := waitForNextPromptOrShutdown(ctx, team, member.Name)
		if err != nil {
			return err
		}
		if shutdown != nil || !team.MemberActive(member.Name) {
			if shutdown != nil {
				_ = team.MailBox.Send(LeadName, NewShutdownResponse(member.Name, shutdown.RequestID, true, ShutdownAckMessage))
			}
			return nil
		}
		nextPrompt = next
	}
	return nil
}
func planModeActive(member *Member) bool {
	return member.Checker != nil && !member.Checker.ReadOnly && member.Checker.Mode() == permissions.ModePlan
}
func requestPlanApproval(ctx context.Context, team *Team, member *Member, fallback string) (string, error) {
	team.mu.Lock()
	pending := member.PendingPlan
	team.mu.Unlock()
	if pending == nil {
		if _, err := team.SubmitPlan(member.Name, readPlanForReview(member, fallback)); err != nil {
			return "", err
		}
	}
	team.mu.Lock()
	requestID := member.PendingPlan.Request.RequestID
	active := member.Active
	hasChecker := member.Checker != nil
	manual := team.RequiresLeaderPlanApproval
	team.mu.Unlock()
	if requestID == "" || !active || ctx.Err() != nil || !hasChecker {
		return "", nil
	}
	if !manual {
		response := NewPlanApprovalResponse(LeadName, requestID, true, PlanAutoApprovedAckMessage)
		if err := team.MailBox.Send(LeadName, response); err != nil {
			return "", err
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
		exitTeammatePlan(team, member)
		return resumeAfterPlanReview(team, member, PlanAutoApprovedMessage)
	}
	for {
		if err := waitForMember(ctx); err != nil {
			return "", err
		}
		messages, err := team.MailBox.ReceiveMatching(member.Name, func(m FileMailMessage) bool { return IsShutdownRequest(m) || m.Type == MsgPlanApprovalResponse })
		if err != nil {
			return "", err
		}
		for _, m := range messages {
			if m.From == LeadName && IsShutdownRequest(m) {
				_ = team.MailBox.Send(LeadName, NewShutdownResponse(member.Name, m.RequestID, true, StoppedAwaitingPlanReviewMessage))
				return "", nil
			}
		}
		for _, m := range messages {
			if m.From != LeadName || m.RequestID != requestID || m.Approve == nil || strings.TrimSpace(m.Text) == "" {
				continue
			}
			team.mu.Lock()
			member.PendingPlan = nil
			team.mu.Unlock()
			if !m.Approved() {
				return resumeAfterPlanReview(team, member, buildPlanRejectedMessage(m.Text))
			}
			exitTeammatePlan(team, member)
			return resumeAfterPlanReview(team, member, buildPlanApprovedMessage(m.Text))
		}
	}
}
func exitTeammatePlan(team *Team, member *Member) {
	team.mu.Lock()
	mode := team.PermissionMode
	member.PendingPlan = nil
	member.PlanApprovalRequired = false
	team.mu.Unlock()
	if mode == permissions.ModePlan {
		mode = permissions.ModeDefault
	}
	member.Checker.ExitPlanMode(mode)
}
func readPlanForReview(member *Member, fallback string) string {
	content, err := plan_file.LoadPlan(member.Checker)
	if err == nil && strings.TrimSpace(content) != "" {
		return content
	}
	if fallback != "" {
		return fallback
	}
	return "(The teammate returned no plan.)"
}
func resumeAfterPlanReview(team *Team, member *Member, review string) (string, error) {
	messages, err := team.MailBox.ReceiveMatching(member.Name, func(m FileMailMessage) bool { return (m.Type == "" || m.Type == MsgText) && !IsShutdownRequest(m) })
	if err != nil {
		return "", err
	}
	if len(messages) == 0 {
		return review, nil
	}
	return review + "\n\nMessages received while awaiting plan review. Apply scope corrections before executing or revising the plan:\n\n" + formatMailboxLines(messages), nil
}
func buildPlanApprovedMessage(feedback string) string {
	return "The leader approved your plan. Review feedback:\n" + feedback + "\n\nBegin execution within the approved scope and current tool permissions; plan approval does not authorize individual tool calls."
}
func buildPlanRejectedMessage(feedback string) string {
	return "The leader rejected your plan. Review feedback:\n" + feedback + "\n\nStay in plan mode. Revise the plan and submit it again with ExitPlanMode when available, otherwise return the revised plan in your final response."
}
func waitForMember(ctx context.Context) error {
	timer := time.NewTimer(IdlePollInterval)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
func waitForNextPromptOrShutdown(ctx context.Context, team *Team, name string) (string, *FileMailMessage, error) {
	for {
		if err := waitForMember(ctx); err != nil {
			// The member was deactivated while waiting: surface a synthetic
			// shutdown request from the leader so the run loop sends a shutdown
			// acknowledgment, mirroring the reference's idle-deactivation path.
			synthetic := NewShutdownRequest(LeadName, MemberDeactivatedShutdownReason)
			return "", &synthetic, nil
		}
		messages, err := team.MailBox.ReceiveMatching(name, func(FileMailMessage) bool { return true })
		if err != nil {
			return "", nil, err
		}
		if len(messages) == 0 {
			continue
		}
		for i, m := range messages {
			if IsShutdownRequest(m) {
				other := append(append([]FileMailMessage{}, messages[:i]...), messages[i+1:]...)
				if err := team.MailBox.Requeue(name, other); err != nil {
					return "", nil, err
				}
				return "", &m, nil
			}
		}
		return formatInboundAsPrompt(messages), nil, nil
	}
}
func formatMailboxLines(messages []FileMailMessage) string {
	lines := []string{}
	for _, m := range messages {
		lines = append(lines, fmt.Sprintf("From %s: %s", m.From, m.Text))
	}
	return strings.Join(lines, "\n\n")
}
func formatInboundAsPrompt(messages []FileMailMessage) string {
	if len(messages) == 0 {
		return ""
	}
	return "You have new messages from your team:\n\n" + formatMailboxLines(messages)
}

// HasLeaderNotifications reports whether any team's leader mailbox has unread
// messages, without consuming them. It mirrors TeamManager.hasLeaderNotifications.
func HasLeaderNotifications(mgr *TeamManager) bool {
	if mgr == nil {
		return false
	}
	for _, name := range mgr.ListTeams() {
		team := mgr.GetTeam(name)
		if team == nil {
			continue
		}
		messages, err := team.MailBox.ReadUnread(LeadName)
		if err == nil && len(messages) > 0 {
			return true
		}
	}
	return false
}

func DrainLeadMailbox(mgr *TeamManager) []string {
	if mgr == nil {
		return nil
	}
	var notes []string
	for _, name := range mgr.ListTeams() {
		team := mgr.GetTeam(name)
		messages, err := team.MailBox.ReceiveMatching(LeadName, func(FileMailMessage) bool { return true })
		if err == nil && len(messages) > 0 {
			notes = append(notes, buildTeamNotification(name, messages))
		}
	}
	return notes
}
func escapeXML(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&apos;").Replace(s)
}
func buildTeamNotification(name string, messages []FileMailMessage) string {
	lines := []string{`<task-notification team="` + escapeXML(name) + `">`}
	for _, m := range messages {
		attributes := `from="` + escapeXML(m.From) + `"`
		if m.Type != "" {
			attributes += ` type="` + escapeXML(m.Type) + `"`
		}
		if m.RequestID != "" {
			attributes += ` requestId="` + escapeXML(m.RequestID) + `"`
		}
		if m.Approve != nil {
			attributes += fmt.Sprintf(` approve="%t"`, *m.Approve)
		}
		lines = append(lines, "<message "+attributes+">"+escapeXML(m.Text)+"</message>")
	}
	return strings.Join(append(lines, "</task-notification>"), "\n")
}
