package ui

import (
	"fmt"
	"math"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/file_history"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/tool_result"
	"os"
)

// Port of src/ui/rewind-dialog.tsx and the rewind flow in src/ui/app.tsx.

// formatRewindAgo mirrors formatAgo in src/ui/rewind-dialog.tsx.
// parseSnapshotTime parses the ISO timestamp persisted with a snapshot.
func parseSnapshotTime(value string) time.Time {
	if parsed, err := time.Parse("2006-01-02T15:04:05.000Z", value); err == nil {
		return parsed
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed
	}
	return time.Time{}
}

func formatRewindAgo(t time.Time) string {
	if t.IsZero() {
		return "0s ago"
	}
	// The reference does not clamp: a future timestamp renders as a negative
	// number of seconds.
	seconds := int64(math.Floor(time.Since(t).Seconds()))
	if seconds < 60 {
		return fmt.Sprintf("%ds ago", seconds)
	}
	minutes := seconds / 60
	if minutes < 60 {
		return fmt.Sprintf("%dm ago", minutes)
	}
	return fmt.Sprintf("%dh ago", minutes/60)
}

func (m Model) renderRewindDialog() string {
	if m.rewindPhase == 1 {
		return m.renderRewindOptionsDialog()
	}
	return m.renderRewindSnapshotList()
}

func (m Model) renderRewindSnapshotList() string {
	rows := m.dialogAvailableRows()
	chrome := selectorChrome(rows, false)
	visibleCount := max(0, rows-chrome.height)
	windowStart := getListWindowStart(len(m.rewindSnapshots), m.rewindCursor, visibleCount)
	contentWidth := max(1, m.width-2)
	rowWidth := contentWidth
	if contentWidth > 4 {
		rowWidth = contentWidth - 2
	}
	selectedBg := lipgloss.Color(Theme.SelectedBg)

	var content strings.Builder
	for i := windowStart; i < windowStart+visibleCount && i < len(m.rewindSnapshots); i++ {
		snap := m.rewindSnapshots[i]
		selected := i == m.rewindCursor
		label := snap.UserText
		if label == "" {
			label = "(empty)"
		}
		pointer := "  "
		color := normalText
		if selected {
			pointer = "› "
			color = accentColor
		}
		meta := fmt.Sprintf(" · %s · %d files", formatRewindAgo(parseSnapshotTime(snap.Timestamp)), len(snap.Backups))
		labelWidth := rowWidth - visibleWidth(meta)
		var line string
		if labelWidth >= 4 {
			line = lipgloss.NewStyle().Foreground(color).Render(truncateToWidth(pointer+label, labelWidth, "…")) +
				lipgloss.NewStyle().Foreground(mutedText).Render(meta)
		} else {
			line = lipgloss.NewStyle().Foreground(color).Render(truncateToWidth(pointer+label+meta, rowWidth, "…"))
		}
		if selected {
			line = lipgloss.NewStyle().Background(selectedBg).Width(rowWidth).Render(line)
		}
		content.WriteString(" " + line + "\n")
	}

	return m.renderSelectorFrame(selectorFrameParams{
		title:   "Rewind to checkpoint",
		hint:    "↑↓ navigate · Enter select · Escape cancel",
		content: strings.TrimSuffix(content.String(), "\n"),
		width:   m.width,
		rows:    rows,
	})
}

func (m Model) renderRewindOptionsDialog() string {
	rows := m.dialogAvailableRows()
	snap := m.rewindSnapshots[m.rewindCursor]
	subtitle := snap.UserText
	if subtitle == "" {
		subtitle = "(empty)"
	}
	contentWidth := max(1, m.width-2)
	rowWidth := contentWidth
	if contentWidth > 4 {
		rowWidth = contentWidth - 2
	}
	selectedBg := lipgloss.Color(Theme.SelectedBg)

	var content strings.Builder
	for i, opt := range RestoreOptions {
		selected := i == m.rewindOptionCursor
		pointer := "  "
		color := mutedText
		if selected {
			pointer = Icons.Arrow + " "
			color = accentColor
		}
		line := lipgloss.NewStyle().Foreground(color).Render(truncateToWidth(pointer+opt, rowWidth, "…"))
		if selected {
			line = lipgloss.NewStyle().Background(selectedBg).Width(rowWidth).Render(line)
		}
		content.WriteString(" " + line + "\n")
	}

	return m.renderSelectorFrame(selectorFrameParams{
		title:    "Choose rewind scope",
		subtitle: subtitle,
		hint:     "↑↓ navigate · Enter select · Escape back",
		content:  strings.TrimSuffix(content.String(), "\n"),
		width:    m.width,
		rows:     rows,
	})
}

func (m Model) handleRewind() (tea.Model, tea.Cmd) {
	if m.fileHistory == nil || !m.fileHistory.HasSnapshots() {
		m.chatMessages = append(m.chatMessages, chatMessage{
			role: "system", content: "No checkpoints to rewind to.",
		})
		return m, nil
	}
	m.rewindSnapshots = m.fileHistory.GetSnapshots()
	m.rewindCursor = len(m.rewindSnapshots) - 1
	m.rewindPhase = 0
	m.rewindOptionCursor = 0
	m.rewindDialog = true
	return m, nil
}

func (m Model) handleRewindKeys(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.rewindPhase == 0 {
		return m.handleRewindPhase0(msg)
	}
	return m.handleRewindPhase1(msg)
}

func (m Model) handleRewindPhase0(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	count := len(m.rewindSnapshots)
	switch msg.String() {
	case "esc":
		m.rewindDialog = false
		return m, nil
	case "up":
		if count > 0 {
			if m.rewindCursor > 0 {
				m.rewindCursor--
			} else {
				m.rewindCursor = count - 1
			}
		}
		return m, nil
	case "down":
		if count > 0 {
			if m.rewindCursor < count-1 {
				m.rewindCursor++
			} else {
				m.rewindCursor = 0
			}
		}
		return m, nil
	case "enter":
		if count > 0 {
			m.rewindPhase = 1
			m.rewindOptionCursor = 0
		}
		return m, nil
	}
	return m, nil
}

func (m Model) handleRewindPhase1(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.rewindPhase = 0
		return m, nil
	case "up":
		if m.rewindOptionCursor > 0 {
			m.rewindOptionCursor--
		} else {
			m.rewindOptionCursor = len(RestoreOptions) - 1
		}
		return m, nil
	case "down":
		if m.rewindOptionCursor < len(RestoreOptions)-1 {
			m.rewindOptionCursor++
		} else {
			m.rewindOptionCursor = 0
		}
		return m, nil
	case "enter":
		return m.executeRewindOption()
	}
	return m, nil
}

// rewindConversation rewinds the live conversation to a snapshot, persisting
// the rewind. The snapshot's sessionLineCount is the authoritative coordinate:
// the session log is truncated to it and the in-memory conversation is rebuilt
// from the truncated log. Line coordinates survive resume and compaction,
// unlike in-memory message indexes. Snapshots with no recorded
// sessionLineCount — or whose session file is gone — fall back to truncating
// by messageIndex. It returns the visible transcript for the rewound state.
func (m *Model) rewindConversation(snap file_history.Snapshot) ([]chatMessage, error) {
	wd, _ := os.Getwd()
	sessionFilePath := session.SessionFilePath(wd, m.sessionID)
	if snap.SessionLineCount != nil {
		if _, err := os.Stat(sessionFilePath); err == nil {
			if err := session.TruncateSessionLines(sessionFilePath, *snap.SessionLineCount); err != nil {
				return nil, err
			}
			saved, lerr := session.LoadSession(wd, m.sessionID)
			if lerr == nil {
				m.conversation.Reset()
				m.conversation.AppendMessages(session.RebuildFromSession(saved, false))
				return transcriptFromRestored(session.RebuildFromSession(saved, true)), nil
			}
			return nil, lerr
		}
	}
	m.conversation.TruncateTo(snap.MessageIndex)
	var visible []conversation.Message
	for _, message := range m.conversation.GetMessages() {
		if message.Role != "system" && !strings.HasPrefix(message.Content, conversation.SystemReminderOpen) {
			visible = append(visible, message)
		}
	}
	return transcriptFromRestored(visible), nil
}

// transcriptFromConversation maps the truncated conversation back onto visible
// chat messages after a rewind, dropping system reminders like the reference
// transcript filter.
// transcriptFromRestored mirrors the reference transcriptFromRestored, shared by
// /resume and /rewind so both leave the transcript in sync with the rebuilt
// conversation. User-Bash records render as cards, tool uses/results fold into
// turn_summary cards (matching how live turns are committed), and other messages
// render their text; anything with no visible text is skipped.
func transcriptFromRestored(messages []conversation.Message) []chatMessage {
	type pendingUse struct {
		toolName string
		args     map[string]any
	}
	pendingUses := map[string]pendingUse{}
	var out []chatMessage
	for _, msg := range messages {
		if msg.UserBash != nil {
			out = append(out, userBashCard(*msg.UserBash))
			continue
		}
		for _, tu := range msg.ToolUses {
			pendingUses[tu.ToolUseID] = pendingUse{toolName: tu.ToolName, args: tu.Arguments}
		}
		if len(msg.ToolResults) > 0 {
			var toolGroup []toolBlockInfo
			for _, tr := range msg.ToolResults {
				use := pendingUses[tr.ToolUseID]
				delete(pendingUses, tr.ToolUseID)
				toolName := use.toolName
				if toolName == "" {
					toolName = "tool"
				}
				tb := toolBlockInfo{
					toolName: toolName,
					args:     use.args,
					output:   tool_result.ToDisplayPreview(tr.Content),
					isError:  tr.IsError,
				}
				// Restored Agent cards get the same status semantics as live ones:
				// the interruption marker means the run was stopped, so it must not
				// render as a green success card.
				if toolName == "Agent" && !tr.IsError {
					if strings.Contains(tr.Content, subagent.SubagentInterruptedMarker) {
						tb.status = "stopped"
					} else {
						tb.status = "completed"
					}
				}
				toolGroup = append(toolGroup, tb)
			}
			out = append(out, chatMessage{role: "turn_summary", toolGroup: toolGroup})
			continue
		}
		if text := msg.ContentText(); strings.TrimSpace(text) != "" {
			out = append(out, chatMessage{role: msg.Role, content: text})
		}
	}
	return out
}

func (m Model) executeRewindOption() (tea.Model, tea.Cmd) {
	if m.rewindCursor < 0 || m.rewindCursor >= len(m.rewindSnapshots) {
		return m.finishRewindError(fmt.Errorf("That checkpoint is no longer available. Reopen /rewind."))
	}
	snap := m.rewindSnapshots[m.rewindCursor]
	var summary string
	var transcript []chatMessage
	rebuilt := false

	switch m.rewindOptionCursor {
	case 0:
		changed, err := m.fileHistory.Rewind(m.rewindCursor)
		if err != nil {
			return m.finishRewindError(err)
		}
		transcript, err = m.rewindConversation(snap)
		if err != nil {
			return m.finishRewindError(err)
		}
		m.stopMemoryTasks()
		summary = fmt.Sprintf("⟲ Rewound to checkpoint. Restored %d file(s) and conversation.", len(changed))
		for _, f := range changed {
			summary += "\n  " + f
		}
		rebuilt = true

	case 1:
		var err error
		transcript, err = m.rewindConversation(snap)
		if err != nil {
			return m.finishRewindError(err)
		}
		m.stopMemoryTasks()
		summary = "⟲ Rewound conversation. Files unchanged."
		rebuilt = true

	case 2:
		changed, err := m.fileHistory.Rewind(m.rewindCursor)
		if err != nil {
			return m.finishRewindError(err)
		}
		summary = fmt.Sprintf("⟲ Restored %d file(s). Conversation unchanged.", len(changed))
		for _, f := range changed {
			summary += "\n  " + f
		}

	case 3:
		m.rewindDialog = false
		m.rewindPhase = 0
		return m, nil
	}
	if rebuilt {
		m.pendingMessages = nil
		m.steeringPending = nil
		m.queuePaused = false
		m.chatMessages = transcript
		m.committedUpTo = 0
		// The reference drops the goal manager on a conversation rewind so goal
		// state reloads from the rewound session; rebind the stable agent.
		m.invalidateGoal()
	}
	if m.ag != nil {
		m.ag.FileStateCache.Clear()
		m.ag.GoalManager = m.currentGoal()
	}
	m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: summary})
	m.rewindDialog = false
	m.rewindPhase = 0

	if rebuilt {
		// The reference remounts the Static transcript after a conversation
		// rewind: the screen clears and the restored transcript replays under
		// a fresh header.
		commitText := m.renderTranscriptHeader() + "\n" + m.renderMessagesRange(0, len(m.chatMessages))
		m.committedUpTo = len(m.chatMessages)
		return m, tea.Batch(
			func() tea.Msg { return tea.ClearScreen() },
			tea.Println(commitText),
		)
	}
	commitText := m.renderMessagesRange(m.committedUpTo, len(m.chatMessages))
	m.committedUpTo = len(m.chatMessages)
	if commitText != "" {
		return m, tea.Println(commitText)
	}
	return m, nil
}

func (m Model) finishRewindError(err error) (tea.Model, tea.Cmd) {
	m.chatMessages = append(m.chatMessages, chatMessage{
		role:    "error",
		content: fmt.Sprintf("Rewind failed: %s", err),
	})
	m.rewindDialog = false
	m.rewindPhase = 0
	return m, nil
}
