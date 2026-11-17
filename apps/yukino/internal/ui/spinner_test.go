package ui

import (
	"testing"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
)

// TestSpinnerTickChainFollowsStatusLabel pins the reference behavior: the
// spinner animates (the tick chain continues) whenever a status label is
// shown and the state is not an error — streaming, compacting and user Bash —
// and stops otherwise.
func TestSpinnerTickChainFollowsStatusLabel(t *testing.T) {
	tick := spinner.TickMsg{Time: time.Now()}

	cases := []struct {
		name    string
		prepare func(*Model)
		wantCmd bool
	}{
		{"streaming", func(m *Model) { m.streaming = true }, true},
		{"compacting", func(m *Model) { m.compacting = true }, true},
		{"user bash", func(m *Model) { m.userBash = &userBashRun{} }, true},
		{"idle", func(m *Model) {}, false},
		{"error while streaming", func(m *Model) { m.streaming = true; m.activityError = "boom" }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := newChatModel(t)
			tc.prepare(&m)
			next, cmd := m.Update(tick)
			m = asModel(t, next)
			if (cmd != nil) != tc.wantCmd {
				t.Fatalf("tick chain continuation = %v, want %v", cmd != nil, tc.wantCmd)
			}
		})
	}
}
