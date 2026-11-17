package ui

func (m *Model) interruptForeground() {
	// Mirrors the reference interruptForeground: abort the in-flight run and
	// dismiss pending prompts. The event stream keeps being consumed — the
	// interrupted tool results and the loop_complete commit flow through the
	// normal handlers, exactly like the reference's for-await loop.
	if m.cancelStream != nil {
		m.cancelStream()
	}
	m.denyAllInteractions()
	m.planApprovalDialog = false
}
