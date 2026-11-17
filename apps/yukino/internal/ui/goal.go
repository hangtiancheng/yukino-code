package ui

import (
	"context"
	"os"
	"sync"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/goal"
	"github.com/yukino-js/yukino/yukino/internal/history"
	"github.com/yukino-js/yukino/yukino/internal/session"
)

// goalBinder holds the active session's goal manager behind a stable pointer.
// bubbletea copies the Model by value, so the GoalTool resolver and the agent
// must reach the manager through this shared binder rather than a captured
// *Model; the UI rebinds it whenever the session changes.
type goalBinder struct {
	mu      sync.Mutex
	manager *goal.GoalManager
}

func (b *goalBinder) get() *goal.GoalManager {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.manager
}

func (b *goalBinder) set(g *goal.GoalManager) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.manager = g
}

// currentGoal mirrors the reference currentGoal(): it lazily (re)creates the
// goal manager keyed on the active session and stores it in the shared binder.
func (m *Model) currentGoal() *goal.GoalManager {
	if g := m.goalBinder.get(); g != nil && g.SessionID() == m.sessionID {
		return g
	}
	wd, _ := os.Getwd()
	g := goal.NewGoalManager(wd, m.sessionID)
	m.goalBinder.set(g)
	return g
}

// invalidateGoal drops the cached manager so the next currentGoal() reloads
// goal state from the (possibly truncated) session transcript. Used by rewind.
func (m *Model) invalidateGoal() {
	m.goalBinder.set(nil)
}

// runGoalCommand mirrors the /goal branch of the reference runSlashCommand:
// record the input, apply the goal command, show the status, and—when the
// command set a goal—run the agent with the goal-set prompt (which is added to
// the conversation but not echoed, matching the reference).
func (m Model) runGoalCommand(args string, input history.InputEntry) (tea.Model, tea.Cmd) {
	wd, _ := os.Getwd()
	result := goal.HandleGoalCommand(m.currentGoal(), args)
	m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: result.Message})
	commitText := m.renderMessagesRange(m.committedUpTo, len(m.chatMessages))
	m.committedUpTo = len(m.chatMessages)

	if result.Prompt == "" || m.client == nil || m.ag == nil {
		if commitText != "" {
			return m, tea.Println(commitText)
		}
		return m, nil
	}

	recorded, err := session.SaveUserMessage(wd, m.sessionID, input, session.Message{Content: result.Prompt})
	if err != nil {
		return m.inputError(err)
	}
	m.conversation.AppendMessages([]conversation.Message{recorded.ToConversation()})

	m.streaming = true
	m.beginInteractionRun()

	m.prepareOutput()

	ctx, cancel := context.WithCancel(context.Background())
	m.cancelStream = cancel

	conv := m.conversation
	ag := m.newRunAgent(ctx)
	m.steeringAgent = ag
	ag.GoalManager = m.currentGoal()
	m.startingAgent = true
	startAgentCmd := func() tea.Msg {
		return agentReadyMsg{ch: ag.Run(ctx, conv)}
	}
	return m, tea.Batch(tea.Println(commitText), startAgentCmd, m.spinner.Tick)
}
