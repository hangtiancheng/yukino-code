package ui

import (
	"fmt"
	"os"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yukino-js/yukino/yukino/internal/sandbox"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

// runSandboxCommand mirrors the reference `/sandbox` local_ui command
// (src/ui/app.tsx): `off` disables and disposes immediately; `auto`/`manual`
// record the mode — applied lazily at the next run start or user Bash via
// configureBashSandbox — and report runtime availability; a bare or unknown
// argument prints the current status and usage.
func (m Model) runSandboxCommand(arg string) (tea.Model, tea.Cmd) {
	arg = strings.TrimSpace(arg)
	if arg == "off" {
		m.sandboxEnabled = false
		m.sandboxAutoAllow = false
		m.disposeSandbox()
		m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: "Sandbox: OFF"})
		return m, nil
	}
	sb := m.sandboxRuntime.Get()
	available := sb != nil && sb.Available()
	// The reference reads sandbox.availabilityError, which no platform
	// implementation sets, so the fallback reason is always used.
	const unavailableReason = "sandbox unavailable"
	autoAllow, manual := arg == "auto", arg == "manual"
	if autoAllow || manual {
		m.sandboxEnabled = true
		m.sandboxAutoAllow = autoAllow
		mode := "manual permissions"
		if autoAllow {
			mode = "auto-allow"
		}
		content := "Sandbox: ON + " + mode
		if !available {
			content += fmt.Sprintf(" (blocked: %s)", unavailableReason)
		}
		m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: content})
		return m, nil
	}
	status := "OFF"
	if m.sandboxEnabled {
		status = "ON + manual"
		if m.sandboxAutoAllow {
			status = "ON + auto-allow"
		}
	}
	runtime := fmt.Sprintf("blocked (%s)", unavailableReason)
	if available {
		runtime = "ready"
	}
	lines := []string{
		"Sandbox status: " + status,
		"Runtime: " + runtime,
		"",
		"Usage: /sandbox <mode>",
		"  auto   — Enable sandbox + auto-allow (recommended)",
		"  manual — Enable sandbox + manual permission confirmation",
		"  off    — Disable sandbox",
	}
	m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: strings.Join(lines, "\n")})
	return m, nil
}

// disposeSandbox mirrors the reference disposeSandbox: drop the Bash tool's
// sandbox so commands run unsandboxed. The reference also disposes the cached
// sandbox instance, but no Go sandbox implementation holds resources, so
// clearing the reference is the whole operation.
func (m *Model) disposeSandbox() {
	if bashTool, ok := m.registry.Get("Bash").(*tools.BashTool); ok {
		bashTool.Sandbox = nil
		bashTool.SandboxRequired = false
	}
	if m.sandboxRuntime != nil {
		m.sandboxRuntime.Reset()
	}
}

// configureBashSandbox mirrors the reference configureBashSandbox: apply the
// current sandbox state to the Bash tool and report whether the runtime is
// actually available. Called at every agent run start (beginInteractionRun)
// and before every user Bash execution, exactly like the reference calls it
// from runAgentLoop and userBash.execute.
func (m Model) configureBashSandbox(bashTool *tools.BashTool) bool {
	if !m.sandboxEnabled {
		bashTool.Sandbox = nil
		bashTool.SandboxRequired = false
		return false
	}
	sb := m.sandboxRuntime.Get()
	bashTool.Sandbox = sb
	bashTool.SandboxRequired = true
	bashTool.SandboxConfig = sandbox.Config{
		AllowWrite:     []string{m.getWorkDir(), "/tmp", os.TempDir()},
		DenyWrite:      nil,
		NetworkEnabled: m.sandboxCfg.SandboxNetworkEnabled(),
	}
	return sb != nil && sb.Available()
}
