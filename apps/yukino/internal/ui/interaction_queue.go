package ui

import (
	"github.com/charmbracelet/bubbletea"
	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type hostPermissionMsg struct{ request agent.PermissionRequestEvent }

func (m Model) listenForHostPermission() tea.Cmd {
	ch, ctx := m.hostPermissionCh, m.lifeCtx
	return func() tea.Msg {
		select {
		case request := <-ch:
			return hostPermissionMsg{request}
		case <-ctx.Done():
			return nil
		}
	}
}
func (m *Model) enqueuePermission(request agent.PermissionRequestEvent) {
	m.permissionQueue = append(m.permissionQueue, request)
	if !m.permDialog {
		m.presentNextPermission()
	}
}
func (m *Model) presentNextPermission() {
	for len(m.permissionQueue) > 0 {
		request := m.permissionQueue[0]
		m.permissionQueue = m.permissionQueue[1:]
		if request.Context != nil && request.Context.Err() != nil {
			replyDenied(request.ResponseCh)
			continue
		}
		m.permissionCurrent = &request
		m.permDialog = true
		m.permCursor = 0
		// The reference remounts the dialog per request, resetting the
		// ContentViewport scroll along with the cursor.
		if m.selectorScrolls != nil {
			m.selectorScrolls["perm"] = 0
		}
		m.permToolName = request.ToolName
		m.permDesc = request.Desc
		m.permRespCh = request.ResponseCh
		return
	}
}
func replyDenied(ch chan<- agent.PermissionReply) {
	if ch != nil {
		select {
		case ch <- agent.PermissionReply{Response: agent.PermDeny}:
		default:
		}
	}
}
func (m *Model) enqueueAsk(request tools.AskUserRequest) {
	m.askQueue = append(m.askQueue, request)
	if !m.askUserDialog {
		m.presentNextAsk()
	}
}
func (m *Model) presentNextAsk() {
	for len(m.askQueue) > 0 {
		req := m.askQueue[0]
		if req.Context != nil && req.Context.Err() != nil {
			m.askQueue = m.askQueue[1:]
			replyAskCanceled(req.ResponseCh)
			continue
		}
		m.askUserDialog = true
		if m.selectorScrolls != nil {
			m.selectorScrolls["ask"] = 0
		}
		m.askUserQuestions = req.Questions
		m.askUserRespCh = req.ResponseCh
		m.askUserQIdx = 0
		m.askUserCursors = make([]int, len(req.Questions))
		m.askUserSelected = make([]map[int]bool, len(req.Questions))
		m.askUserOther = make([]string, len(req.Questions))
		m.askUserOtherMode = make([]bool, len(req.Questions))
		m.askUserSelectionOrder = make([][]int, len(req.Questions))
		m.askUserTextEditor = newInputEditor()
		m.askUserAnswered = map[int]string{}
		m.askUserOnSubmit = false
		m.askUserSubmitIdx = 0
		for i := range req.Questions {
			m.askUserSelected[i] = map[int]bool{}
		}
		return
	}
}
func (m *Model) answerAsk(response tools.QuestionResponse) {
	if m.askUserRespCh != nil {
		select {
		case m.askUserRespCh <- response:
		default:
		}
	}
	m.askUserDialog = false
	m.askUserRespCh = nil
	if len(m.askQueue) > 0 {
		m.askQueue = m.askQueue[1:]
	}
	m.presentNextAsk()
}
func replyAskDeclined(ch chan tools.QuestionResponse) {
	if ch != nil {
		select {
		case ch <- tools.QuestionResponse{Answers: map[string]string{"_declined": "true"}}:
		default:
		}
	}
}
func replyAskCanceled(ch chan tools.QuestionResponse) {
	if ch != nil {
		select {
		case ch <- tools.QuestionResponse{Answers: map[string]string{}}:
		default:
		}
	}
}
func (m *Model) denyAllInteractions() {
	replyDenied(m.permRespCh)
	m.closePermDialog()
	for _, request := range m.permissionQueue {
		replyDenied(request.ResponseCh)
	}
	m.permissionQueue = nil
	replyAskCanceled(m.askUserRespCh)
	for _, request := range m.askQueue {
		if request.ResponseCh != m.askUserRespCh {
			replyAskCanceled(request.ResponseCh)
		}
	}
	m.askQueue = nil
	m.askUserDialog = false
	m.askUserRespCh = nil
}
func (m *Model) pruneInteractions() {
	if m.permissionCurrent != nil && m.permissionCurrent.Context != nil && m.permissionCurrent.Context.Err() != nil {
		replyDenied(m.permRespCh)
		m.closePermDialog()
		m.presentNextPermission()
	}
	if len(m.askQueue) > 0 && m.askQueue[0].Context != nil && m.askQueue[0].Context.Err() != nil {
		m.answerAsk(tools.QuestionResponse{Answers: map[string]string{}})
	}
	for i := len(m.askQueue) - 1; i > 0; i-- {
		if request := m.askQueue[i]; request.Context != nil && request.Context.Err() != nil {
			replyAskCanceled(request.ResponseCh)
			m.askQueue = append(m.askQueue[:i], m.askQueue[i+1:]...)
		}
	}
}
