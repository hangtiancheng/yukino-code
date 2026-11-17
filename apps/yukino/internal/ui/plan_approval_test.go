package ui

import (
	"fmt"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
)

func planKey(r string) tea.KeyMsg {
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(r)}
}

// TestPlanApprovalFeedbackModeTypesJK pins that the feedback field consumes
// text keys: j/k must type into the draft instead of moving the cursor
// (the reference TextField owns all input while cursor === 2).
func TestPlanApprovalFeedbackModeTypesJK(t *testing.T) {
	m := newChatModel(t)
	m.planApprovalDialog = true
	m.planApprovalCursor = 2
	next, _ := m.handlePlanApproval(planKey("j"))
	m = asModel(t, next)
	next, _ = m.handlePlanApproval(planKey("k"))
	m = asModel(t, next)
	if m.planApprovalCursor != 2 {
		t.Fatalf("cursor moved to %d while typing feedback", m.planApprovalCursor)
	}
	if got := m.planApprovalEditor.Value(); got != "jk" {
		t.Fatalf("input = %q, want %q", got, "jk")
	}
}

// TestPlanApprovalFeedbackRequiredError pins the reference error copy
// ("Feedback is required.") and its onChange clearing on a non-empty draft.
func TestPlanApprovalFeedbackRequiredError(t *testing.T) {
	m := newChatModel(t)
	m.planApprovalDialog = true
	m.planApprovalCursor = 2
	next, _ := m.handlePlanApproval(tea.KeyMsg{Type: tea.KeyEnter})
	m = asModel(t, next)
	if !m.planFeedbackRequired || !m.planApprovalDialog {
		t.Fatal("blank feedback must keep the dialog open with the required error")
	}
	if rendered := m.renderPlanApprovalDialog(); !strings.Contains(rendered, "Feedback is required.") {
		t.Fatalf("dialog must render the reference error copy:\n%s", rendered)
	}
	next, _ = m.handlePlanApproval(planKey("x"))
	m = asModel(t, next)
	if m.planFeedbackRequired {
		t.Fatal("typing a non-empty draft must clear the required error")
	}
}

// TestPlanApprovalNavigationAndBoundaries pins the clamped arrow navigation
// including the feedback field's up-boundary back to the options.
func TestPlanApprovalNavigationAndBoundaries(t *testing.T) {
	m := newChatModel(t)
	m.planApprovalDialog = true
	down := tea.KeyMsg{Type: tea.KeyDown}
	up := tea.KeyMsg{Type: tea.KeyUp}
	for _, want := range []int{1, 2, 2} {
		next, _ := m.handlePlanApproval(down)
		m = asModel(t, next)
		if m.planApprovalCursor != want {
			t.Fatalf("cursor = %d, want %d", m.planApprovalCursor, want)
		}
	}
	next, _ := m.handlePlanApproval(up)
	m = asModel(t, next)
	if m.planApprovalCursor != 1 {
		t.Fatalf("up-boundary from the field = %d, want 1", m.planApprovalCursor)
	}
}

// TestPlanApprovalChoiceMessages pins the reference handlePlanApproval copy
// and mode transitions for the yolo and manual choices.
func TestPlanApprovalChoiceMessages(t *testing.T) {
	cases := []struct {
		cursor  int
		message string
		mode    permissions.PermissionMode
	}{
		{cursor: 0, message: "Plan approved. Entered YOLO mode.", mode: permissions.ModeBypass},
		{cursor: 1, message: "Plan approved. Each edit requires confirmation.", mode: permissions.ModeDefault},
	}
	for _, tc := range cases {
		t.Run(tc.message, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			m := newChatModel(t)
			dir := t.TempDir()
			m.ag = &agent.Agent{Checker: permissions.NewChecker(
				permissions.NewPathSandbox(dir, true),
				permissions.NewRuleEngine(dir),
				permissions.ModePlan,
			)}
			m.planApprovalDialog = true
			m.planApprovalCursor = tc.cursor
			next, _ := m.handlePlanApproval(tea.KeyMsg{Type: tea.KeyEnter})
			m = asModel(t, next)
			if m.planApprovalDialog {
				t.Fatal("the dialog must close on approval")
			}
			if got := m.ag.Checker.Mode(); got != tc.mode {
				t.Fatalf("mode = %s, want %s", got, tc.mode)
			}
			last := m.chatMessages[len(m.chatMessages)-1]
			if last.role != "system" || last.content != tc.message {
				t.Fatalf("message = %#v, want %q", last, tc.message)
			}
		})
	}
}

// TestPlanApprovalRendersSelectorChrome pins the reference frame copy.
func TestPlanApprovalRendersSelectorChrome(t *testing.T) {
	m := newChatModel(t)
	m.planApprovalDialog = true
	rendered := m.renderPlanApprovalDialog()
	for _, want := range []string{
		"Plan complete",
		"Yukino has written a plan and is ready to execute.",
		"Yes, enter YOLO mode (auto-approve all)",
		"Yes, manually approve edits",
		"Tell Yukino what to change",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("dialog missing %q:\n%s", want, rendered)
		}
	}
}

// TestPlanApprovalFeedbackFieldActions pins the TextField wiring: the
// up-boundary returns to the options, Escape inside the field approves with
// manual confirmation, and Shift+Tab submits a non-empty draft.
func TestPlanApprovalFeedbackFieldActions(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newChatModel(t)
	m.planApprovalDialog = true
	m.planApprovalCursor = 2
	next, _ := m.handlePlanApproval(tea.KeyMsg{Type: tea.KeyUp})
	m = asModel(t, next)
	if m.planApprovalCursor != 1 {
		t.Fatalf("up-boundary cursor = %d, want 1", m.planApprovalCursor)
	}

	m = newChatModel(t)
	m.planApprovalDialog = true
	m.planApprovalCursor = 2
	next, _ = m.handlePlanApproval(tea.KeyMsg{Type: tea.KeyEsc})
	m = asModel(t, next)
	if m.planApprovalDialog {
		t.Fatal("escape inside the field must approve with manual confirmation")
	}

	m = newChatModel(t)
	m.ag = &agent.Agent{}
	m.planApprovalDialog = true
	m.planApprovalCursor = 2
	for _, r := range []string{"r", "e"} {
		next, _ = m.handlePlanApproval(planKey(r))
		m = asModel(t, next)
	}
	next, _ = m.handlePlanApproval(tea.KeyMsg{Type: tea.KeyShiftTab})
	m = asModel(t, next)
	if m.planApprovalDialog {
		t.Fatal("shift+tab must submit the non-empty feedback")
	}
	if got := m.planApprovalEditor.Value(); got != "" {
		t.Fatalf("editor must reset after submit, got %q", got)
	}
}

// TestSelectorFrameScrollHysteresis pins the reference ContentViewport
// scroll: the window moves only when the focused row would leave it
// (down → bottom edge, up → top edge), keeping its position in between.
func TestSelectorFrameScrollHysteresis(t *testing.T) {
	m := newChatModel(t)
	m.selectorScrolls = map[string]int{}
	var lines []string
	for i := 0; i < 20; i++ {
		lines = append(lines, fmt.Sprintf("l%d", i))
	}
	p := selectorFrameParams{
		title:       "t",
		hint:        "h",
		content:     strings.Join(lines, "\n"),
		width:       80,
		rows:        12,
		focusRow:    0,
		focusHeight: 1,
		scrollKey:   "test",
	}
	// rows=12 → borders+title+hint+gap chrome (5) → limit 7.
	rendered := m.renderSelectorFrame(p)
	if !strings.Contains(rendered, " l0") || strings.Contains(rendered, " l8") {
		t.Fatalf("initial window must be l0..l6:\n%s", rendered)
	}
	p.focusRow = 8
	rendered = m.renderSelectorFrame(p)
	if strings.Contains(rendered, " l0") || !strings.Contains(rendered, " l8") {
		t.Fatalf("scrolling down must move the focus to the bottom edge:\n%s", rendered)
	}
	// Moving back up one row keeps the window (hysteresis); the stateless
	// bottom-pinned formula would have re-pinned l7 to the bottom edge.
	p.focusRow = 7
	rendered = m.renderSelectorFrame(p)
	if strings.Contains(rendered, " l0") || !strings.Contains(rendered, " l8") {
		t.Fatalf("moving up inside the window must not scroll:\n%s", rendered)
	}
	p.focusRow = 0
	rendered = m.renderSelectorFrame(p)
	if !strings.Contains(rendered, " l0") || strings.Contains(rendered, " l8") {
		t.Fatalf("reaching above the window must scroll to the top edge:\n%s", rendered)
	}
}
