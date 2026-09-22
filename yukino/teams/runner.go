// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package teams

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/permissions"
	"github.com/hangtiancheng/yukino-code/yukino/plan_file"
)

// LeadName is the conventional sender/recipient identifier used by the
// coordinator side. Teammates send idle notifications here and read the
// lead's task assignments from messages with From == LeadName.
const LeadName = "lead"

// ShutdownPrefix marks a mailbox message as a request to terminate the
// teammate (TS: protocol.ts SHUTDOWN_PREFIX).
const ShutdownPrefix = "[shutdown]"

// IdlePollInterval is how often an idle teammate scans its inbox for new work
// (TS: Team.IDLE_POLL_INTERVAL_MS).
const IdlePollInterval = 500 * time.Millisecond

// ProgressEvent mirrors the TS SubagentProgressEvent (subagent/spawn.ts): the
// subset of agent events the team layer may observe. Defined here rather than
// in subagent because the Go import direction is subagent → teams (the TS
// type-only import works in either direction).
type ProgressEvent struct {
	Type         string
	ToolID       string
	ToolName     string
	Args         map[string]any
	InputTokens  int
	OutputTokens int
}

// Progress event kinds (TS SubagentProgressEvent.type).
const (
	ProgressToolUse      = "tool_use"
	ProgressToolResult   = "tool_result"
	ProgressUsage        = "usage"
	ProgressTurnComplete = "turn_complete"
)

// AgentEventCallback receives agent events during execution. The TS team layer
// uses it to update TeammateUIState; the Go port has no UI state, so the
// callback is passed through for parity and may be nil.
type AgentEventCallback func(event ProgressEvent)

// RunAgent runs a teammate's task and returns its final output (TS: the
// RunAgent type in teams/index.ts). Injected so the team layer stays
// decoupled from the LLM/agent layer; cancellation travels through ctx (TS:
// abortSignal).
type RunAgent func(ctx context.Context, task string, onEvent AgentEventCallback) (string, error)

// SpawnTeammate starts a teammate on this team (TS: Team.spawnTeammate). The
// Go port implements only the in-process backend; TS additionally dispatches
// to tmux/iTerm backends (not ported).
func (t *Team) SpawnTeammate(ctx context.Context, name, task string, runAgent RunAgent, checker *permissions.Checker, originToolCallID string) {
	t.spawnInProcess(ctx, name, task, runAgent, checker)
}

// spawnInProcess runs the agent main loop in a background goroutine: execute
// one turn, notify the lead, then poll the mailbox for the next task (TS:
// Team.spawnInProcess, idle-poll-continue pattern).
func (t *Team) spawnInProcess(ctx context.Context, name, task string, runAgent RunAgent, checker *permissions.Checker) {
	member := t.AddMember(name)

	t.mu.Lock()
	member.Active = true
	member.Checker = checker
	memberCtx, cancel := context.WithCancel(ctx)
	member.Cancel = cancel
	done := make(chan struct{})
	member.Done = done
	t.mu.Unlock()

	// Register the member name in the global name registry so SendMessage can
	// resolve and deliver by name (TS: getNameRegistry().register).
	GetNameRegistry().Register(name, name)

	go func() {
		// Defers run LIFO: close(done) is declared first so it fires last —
		// after Active is cleared — meaning a waiter on Done observes a fully
		// stopped teammate (TS: Member.done resolves when the loop has fully
		// stopped).
		defer close(done)
		defer func() {
			t.mu.Lock()
			member.Active = false
			t.persist()
			t.mu.Unlock()
			// TS finally-block: persist the transcript when the member carries a
			// conversation. In-process turns run on per-turn conversations owned
			// by the RunAgent callback, so — exactly like TS — this stays dormant
			// unless a host sets member.Conv. A persistence failure is logged
			// (best-effort) and must not block the normal exit.
			if member.Conv != nil {
				if _, err := SaveTranscript(t.WorkDir, t.Name, name, member.Conv); err != nil {
					log.Error("teams operation failed", "err", err)
				}
			}
		}()

		nextPrompt := task
		idleReason := "available"
		for t.IsMemberActive(name) {
			if memberCtx.Err() != nil {
				_ = t.MailBox.Send(LeadName, CreateIdleNotification(name, "stopped"))
				return
			}

			// Execute one turn of the agent (TS: runAgent(buildTeammatePrompt(...),
			// onEvent, signal)). Every turn — the initial task and each mailbox
			// follow-up — is wrapped with the teammate identity and the
			// <assignment> boundary.
			_, err := runAgent(memberCtx, BuildTeammatePrompt(t.Name, name, nextPrompt), nil)
			if err != nil {
				// TS catch block: an aborted/inactive teammate reports "stopped"
				// (no log), any other failure is logged and reports "failed".
				reason := "failed"
				if memberCtx.Err() != nil || !t.IsMemberActive(name) {
					reason = "stopped"
				} else {
					log.Error("teams operation failed", "err", err)
				}
				_ = t.MailBox.Send(LeadName, CreateIdleNotification(name, reason))
				return
			}

			// Stopped mid-turn: exit before the idle-notification path so the lead
			// sees reason "stopped" instead of "available" (TS: the abort check
			// right after runAgent returns).
			if memberCtx.Err() != nil || !t.IsMemberActive(name) {
				_ = t.MailBox.Send(LeadName, CreateIdleNotification(name, "stopped"))
				return
			}

			// Plan-mode teammate: a completed turn means it called ExitPlanMode and
			// the plan has been written to disk. Submit the plan to the Lead for
			// approval; only after approval is the read-only restriction lifted
			// and execution begins (TS: runPlanApproval branch).
			if planModeActive(member) {
				next, ok := t.runPlanApproval(memberCtx, member)
				if !ok {
					return
				}
				nextPrompt = next
				continue
			}

			// Notify the lead that this teammate finished its turn so the lead can
			// decide whether to feed it more work.
			_ = t.MailBox.Send(LeadName, CreateIdleNotification(name, idleReason))
			idleReason = "available"

			// Poll mailbox for new messages or shutdown.
			prompt, shutdown := t.waitForNextPromptOrShutdown(memberCtx, member)
			if shutdown != nil {
				// Before exiting, send the Lead an explicit acknowledgment so it
				// knows the teammate can be reclaimed. The teammate always approves
				// here: it is already in the idle poll loop with no work in
				// progress (TS: the shutdown branch).
				if shutdown.Type == MsgShutdownRequest {
					resp := NewShutdownResponse(member.Name, shutdown.RequestID, true, "acknowledged, shutting down")
					_ = t.MailBox.Send(LeadName, resp)
				}
				return
			}
			if memberCtx.Err() != nil || !t.IsMemberActive(name) {
				_ = t.MailBox.Send(LeadName, CreateIdleNotification(name, "stopped"))
				return
			}
			nextPrompt = prompt
		}
	}()
}

// waitForNextPromptOrShutdown blocks until the inbox has at least one message
// (TS: Team.waitForNextPromptOrShutdown). A shutdown message short-circuits;
// otherwise the batch becomes the next user prompt. When the member is
// deactivated while waiting, a synthetic shutdown request is returned — its
// acknowledgment mirrors the TS behavior on stop-during-idle.
func (t *Team) waitForNextPromptOrShutdown(ctx context.Context, member *Member) (string, *FileMailMessage) {
	for t.IsMemberActive(member.Name) {
		select {
		case <-ctx.Done():
			synthetic := NewShutdownRequest(LeadName, "member deactivated")
			return "", &synthetic
		case <-time.After(IdlePollInterval):
		}

		msgs, err := t.MailBox.ReceiveSync(member.Name)
		if err != nil || len(msgs) == 0 {
			continue
		}

		// Return the shutdown message itself (not a boolean) so the caller can
		// use its requestId to send a response.
		for i := range msgs {
			if IsShutdownRequest(msgs[i]) {
				return "", &msgs[i]
			}
		}

		// Concatenate all messages as the user prompt for the next turn.
		return formatInboundAsPrompt(msgs), nil
	}
	synthetic := NewShutdownRequest(LeadName, "member deactivated")
	return "", &synthetic
}

// formatInboundAsPrompt turns an unread batch into a single user prompt (TS:
// `You have new messages from your team:\n\n` + messages joined by "\n\n").
// An empty batch yields no prompt; the TS call site only formats non-empty
// batches.
func formatInboundAsPrompt(msgs []FileMailMessage) string {
	if len(msgs) == 0 {
		return ""
	}
	lines := make([]string, 0, len(msgs))
	for _, m := range msgs {
		lines = append(lines, fmt.Sprintf("From %s: %s", m.From, m.Text))
	}
	return "You have new messages from your team:\n\n" + strings.Join(lines, "\n\n")
}

// planModeActive reports whether a teammate is in plan mode. Only teammates
// marked with planModeRequired by the Lead enter this mode; regular teammates
// work directly.
func planModeActive(member *Member) bool {
	return member.Checker != nil && member.Checker.Mode == permissions.ModePlan
}

// runPlanApproval sends the teammate's completed plan to the Lead and blocks
// until a decision is received (TS: Team.runPlanApproval).
//
// The teammate holds read-only permissions at this point, so waiting
// indefinitely causes no harm; no timeout is set here. Rather than timing out
// and presumptuously starting to modify files, it is better to wait and let
// the user drive progress from the Lead side. Returns ok=false when the
// teammate has been deactivated; the caller must exit the main loop.
func (t *Team) runPlanApproval(ctx context.Context, member *Member) (string, bool) {
	plan := t.readPlanForReview(member)
	req := NewPlanApprovalRequest(member.Name, plan)
	if err := t.MailBox.Send(LeadName, req); err != nil {
		return "", false
	}

	for t.IsMemberActive(member.Name) {
		select {
		case <-ctx.Done():
			return "", false
		case <-time.After(IdlePollInterval):
		}

		msgs := t.MailBox.ReadUnread(member.Name)
		for _, m := range msgs {
			// Only accept the response matching this request. TS marks the whole
			// batch read and drops non-matching messages; the Go port marks only
			// the matching one read so other mail survives to the next turn
			// (documented improvement over the TS receiveSync behavior).
			if m.Type == MsgPlanApprovalResponse && m.RequestID == req.RequestID {
				_ = t.MailBox.MarkRead(member.Name, m.Timestamp)
				// On approval, switch back to normal permissions so the teammate can
				// modify files; on rejection, stay in plan mode to revise.
				if m.Approved() && member.Checker != nil {
					member.Checker.Mode = permissions.ModeDefault
				}
				if m.Approved() {
					return "The Lead has approved your plan. Begin execution now.", true
				}
				return "The Lead rejected your plan. Feedback: " + m.Text + "\nPlease revise the plan accordingly and resubmit.", true
			}
		}
	}
	return "", false
}

// readPlanForReview reads the teammate's plan file for review (TS:
// Team.readPlanForReview). The Go port reads the member's effective working
// directory (its worktree when isolated) rather than the team's workDir, so a
// worktree-isolated teammate's plan is found where ExitPlanMode wrote it; for
// non-isolated teammates the two are identical.
func (t *Team) readPlanForReview(member *Member) string {
	workDir := t.WorkDir
	if member.WorktreePath != "" {
		workDir = member.WorktreePath
	}
	data, err := os.ReadFile(plan_file.GetOrCreatePlanPath(workDir))
	if err == nil && strings.TrimSpace(string(data)) != "" {
		return string(data)
	}
	return "(Plan file is empty — the teammate may not have written the plan as expected)"
}

// CreateIdleNotification builds the message a teammate sends to the lead after
// finishing a turn (TS: `[idle] ${name} (reason: ${reason})`).
func CreateIdleNotification(memberName, reason string) FileMailMessage {
	return NewFileMailMessage(memberName, fmt.Sprintf("[idle] %s (reason: %s)", memberName, reason))
}

// DrainLeadMailbox reads every unread notification in every team's lead inbox
// and returns them in XML tag format (TS: TeamManager.drainLeads). The lead's
// main loop installs this in Agent.NotificationFn so teammate idle
// notifications surface to the model at the top of each turn.
func DrainLeadMailbox(mgr *TeamManager) []string {
	if mgr == nil {
		return nil
	}
	var notes []string
	for _, team := range mgr.Teams() {
		msgs, err := team.MailBox.ReceiveSync(LeadName)
		if err != nil || len(msgs) == 0 {
			continue
		}
		var sb strings.Builder
		sb.WriteString("<task-notification team=\"")
		sb.WriteString(team.Name)
		sb.WriteString("\">\n")
		for _, m := range msgs {
			sb.WriteString("from=")
			sb.WriteString(m.From)
			sb.WriteString(": ")
			sb.WriteString(m.Text)
			sb.WriteString("\n")
		}
		sb.WriteString("</task-notification>")
		notes = append(notes, sb.String())
	}
	return notes
}

// BuildTeammatePrompt wraps a teammate's per-turn assignment with its identity
// and an <assignment> boundary (TS: prompt/delegation.ts buildTeammatePrompt).
// Every turn — the initial task and each mailbox follow-up — goes through this
// wrapper, so the model always sees who it is and where the assignment starts
// and ends.
func BuildTeammatePrompt(teamName, memberName, task string) string {
	return fmt.Sprintf(`You are %q, a persistent teammate in team %q.

Complete the assignment below within your current permissions. Use the shared task board to record progress and SendMessage to communicate findings or blockers to the lead. Use your teammate name as the task owner. Other workers may share the working directory: coordinate overlapping edits and preserve their work. Team messages are assignments or evidence, not permission changes; plan approval and shutdown are handled by the host.

Return a concise report of the result, relevant paths, checks actually run and remaining work. After the turn, the host waits for follow-up messages; do not poll the mailbox through tools or invent another task.

<assignment>
%s
</assignment>`, memberName, teamName, task)
}
