package ui

import (
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/tools"
)

// The reference /sandbox parses auto/manual/off args (no dialog): off disables
// and disposes immediately, auto/manual record the mode and report availability,
// and a bare/unknown arg prints status + usage.
func TestSandboxCommandModes(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newChatModel(t)

	next, _ := m.runSandboxCommand("auto")
	m = asModel(t, next)
	if !m.sandboxEnabled || !m.sandboxAutoAllow {
		t.Fatalf("auto: enabled=%v autoAllow=%v", m.sandboxEnabled, m.sandboxAutoAllow)
	}
	if got := m.chatMessages[len(m.chatMessages)-1].content; !strings.HasPrefix(got, "Sandbox: ON + auto-allow") {
		t.Fatalf("auto message: %q", got)
	}

	next, _ = m.runSandboxCommand("manual")
	m = asModel(t, next)
	if !m.sandboxEnabled || m.sandboxAutoAllow {
		t.Fatalf("manual: enabled=%v autoAllow=%v", m.sandboxEnabled, m.sandboxAutoAllow)
	}
	if got := m.chatMessages[len(m.chatMessages)-1].content; !strings.HasPrefix(got, "Sandbox: ON + manual permissions") {
		t.Fatalf("manual message: %q", got)
	}

	next, _ = m.runSandboxCommand("")
	m = asModel(t, next)
	got := m.chatMessages[len(m.chatMessages)-1].content
	if !strings.Contains(got, "Sandbox status: ON + manual") || !strings.Contains(got, "Usage: /sandbox <mode>") {
		t.Fatalf("status message: %q", got)
	}

	next, _ = m.runSandboxCommand("off")
	m = asModel(t, next)
	if m.sandboxEnabled || m.sandboxAutoAllow {
		t.Fatalf("off: enabled=%v autoAllow=%v", m.sandboxEnabled, m.sandboxAutoAllow)
	}
	if got := m.chatMessages[len(m.chatMessages)-1].content; got != "Sandbox: OFF" {
		t.Fatalf("off message: %q", got)
	}
}

// configureBashSandbox applies the state to the Bash tool (mirroring the
// reference): disabled clears it, enabled marks it required with allow-write
// roots. Sandbox may be nil on unsupported platforms, so only SandboxRequired
// is asserted.
func TestConfigureBashSandboxAppliesState(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newChatModel(t)
	bashTool, ok := m.registry.Get("Bash").(*tools.BashTool)
	if !ok {
		t.Fatal("registry missing the Bash tool")
	}

	m.sandboxEnabled = false
	if ready := m.configureBashSandbox(bashTool); ready {
		t.Fatal("disabled sandbox must report not ready")
	}
	if bashTool.Sandbox != nil || bashTool.SandboxRequired {
		t.Fatal("disabled sandbox must clear the Bash tool")
	}

	m.sandboxEnabled = true
	m.configureBashSandbox(bashTool)
	if !bashTool.SandboxRequired {
		t.Fatal("enabled sandbox must mark the Bash tool required")
	}
	if len(bashTool.SandboxConfig.AllowWrite) == 0 {
		t.Fatal("enabled sandbox must set allow-write roots")
	}

	// off disposes: the Bash tool sandbox is dropped.
	m.sandboxEnabled = false
	m.disposeSandbox()
	if bashTool.Sandbox != nil || bashTool.SandboxRequired {
		t.Fatal("dispose must clear the Bash tool sandbox")
	}
}
