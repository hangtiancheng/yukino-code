package bootstrap

import (
	"os"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/sandbox"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

// ConfigureBashSandbox mirrors the reference configureBashSandbox: it binds the
// sandbox onto the registered Bash tool from the YAML config and mirrors the
// enabled/auto-allow flags onto the permission checker when one is provided.
func ConfigureBashSandbox(registry *tools.Registry, cwd string, cfg *config.SandboxYamlConfig, checker *permissions.Checker) {
	bash, ok := registry.Get("Bash").(*tools.BashTool)
	if !ok || bash == nil {
		return
	}
	bash.SandboxRequired = cfg.SandboxEnabled()
	if bash.SandboxRequired {
		bash.Sandbox = sandbox.New()
		bash.SandboxConfig = sandbox.Config{
			AllowWrite:     []string{cwd, os.TempDir()},
			DenyWrite:      nil,
			NetworkEnabled: cfg.SandboxNetworkEnabled(),
		}
	}
	if checker != nil {
		checker.SandboxEnabled = bash.SandboxRequired
		checker.SandboxAutoAllow = cfg.SandboxAutoAllow()
	}
}
