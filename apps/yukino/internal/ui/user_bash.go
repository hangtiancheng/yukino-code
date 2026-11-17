package ui

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/conversation/userbash"
	"github.com/yukino-js/yukino/yukino/internal/history"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type userBashRun struct {
	ctx                     context.Context
	cancel                  context.CancelFunc
	done                    chan struct{}
	command, cwd, sessionID string
	excluded                bool
	input                   history.InputEntry
	mu                      sync.Mutex
	result                  *conversation.UserBashResult
	handled                 bool
}
type userBashOutputMsg struct {
	run    *userBashRun
	output string
}
type userBashDoneMsg struct{ run *userBashRun }

func userBashRecord(run *userBashRun, result conversation.UserBashResult) session.Message {
	return session.Message{Role: "user", Content: conversation.UserBashContext(result), UserBash: &result, Timestamp: time.Now().Unix(), UserInput: &conversation.UserInput{ID: run.input.ID, Timestamp: run.input.Timestamp}}
}
func userBashCard(result conversation.UserBashResult) chatMessage {
	progress := UserBashProgressIncluded
	if result.ExcludeFromContext {
		progress = UserBashProgressExcluded
	}
	return chatMessage{role: "turn_summary", toolGroup: []toolBlockInfo{{toolName: "Bash", args: map[string]any{"command": plainTerminalLine(result.Command)}, output: result.Output, isError: result.IsError, elapsed: result.Elapsed, status: result.Status, progress: progress}}}
}
func (m Model) submitUserBash(text string) (Model, tea.Cmd, bool) {
	command, excluded, _ := userbash.ParseCommand(text)
	if command == "" || m.userBash != nil {
		message := "Warning: A user Bash command is already running. Press Esc to cancel it first."
		if command == "" {
			prefix := "!"
			if excluded {
				prefix = "!!"
			}
			message = "Warning: Enter a Bash command after " + prefix + "."
		}
		m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: message})
		return m, m.commitStaticOutput(), false
	}
	// The reference records the trimmed submission text (onStart(text.trim())).
	trimmed := strings.TrimSpace(text)
	input, err := history.RecordInput(history.InputOptions{Cwd: m.getWorkDir(), SessionID: &m.sessionID, Source: "cli", Text: trimmed})
	if err != nil {
		next, cmd := m.inputError(err)
		return next.(Model), cmd, false
	}
	m.historyEntries = append(m.historyEntries, trimmed)
	m.historyIndex = 0
	m.historyDraft = nil
	m.updateDismissed = true
	ctx, cancel := context.WithCancel(m.lifeCtx)
	run := &userBashRun{ctx: ctx, cancel: cancel, done: make(chan struct{}), command: command, excluded: excluded, input: input, cwd: m.getWorkDir(), sessionID: m.sessionID}
	m.userBash = run
	progress := UserBashProgressIncluded
	if excluded {
		progress = UserBashProgressExcluded
	}
	m.userBashTool = &toolBlockInfo{toolID: "user-bash", toolName: "Bash", args: map[string]any{"command": plainTerminalLine(command)}, progress: progress, loading: true}
	tool, _ := m.registry.Get("Bash").(*tools.BashTool)
	// The reference applies the current sandbox state to the Bash tool before
	// every user Bash execution (userBash.execute → configureBashSandbox).
	if tool != nil {
		m.configureBashSandbox(tool)
	}
	execution := tools.ExecutionContext{WorkDir: run.cwd, SessionID: run.sessionID, TaskManager: m.taskMgr}
	if m.ag != nil {
		execution.Worktrees = m.ag.Checker
	}
	outputCh, life := m.userBashOutputCh, m.lifeCtx
	execution.OnOutput = func(output string) {
		select {
		case outputCh <- userBashOutputMsg{run, output}:
		case <-ctx.Done():
		case <-life.Done():
		}
	}
	ctx = tools.WithExecutionContext(ctx, execution)
	go func() {
		started := time.Now()
		result := tools.ToolResult{IsError: true, Output: "Error: Bash tool is unavailable"}
		if tool != nil {
			result = userbash.Execute(ctx, tool, command, excluded)
		}
		status := "completed"
		if result.IsError {
			status = "failed"
		}
		if ctx.Err() != nil {
			status = "stopped"
		}
		recorded := conversation.UserBashResult{Command: command, Output: plainTerminalText(result.Output), IsError: result.IsError, Elapsed: time.Since(started).Seconds(), Status: status, ExcludeFromContext: excluded}
		run.mu.Lock()
		run.result = &recorded
		run.mu.Unlock()
		close(run.done)
	}()
	return m, tea.Batch(func() tea.Msg { <-run.done; return userBashDoneMsg{run} }, m.spinner.Tick), true
}
func (m Model) listenUserBashOutput() tea.Cmd {
	ch, ctx := m.userBashOutputCh, m.lifeCtx
	return func() tea.Msg {
		select {
		case output := <-ch:
			return output
		case <-ctx.Done():
			return nil
		}
	}
}
func (m *Model) flushUserBashRecords(include bool) {
	if m.streaming || m.compacting || m.startingAgent || m.settlingCh != nil {
		return
	}
	for _, record := range m.pendingBashRecords {
		if err := session.SaveMessage(m.getWorkDir(), m.sessionID, record); err != nil {
			m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: fmt.Sprintf("Error saving user Bash result: %v", err)})
		}
		if include {
			m.conversation.AppendMessages(session.RebuildFromSession([]session.Message{record}, false))
		}
	}
	m.pendingBashRecords = nil
}
func (m *Model) interruptUserWork() {
	if m.userBash != nil {
		m.userBash.cancel()
		return
	}
	m.interruptForeground()
}
