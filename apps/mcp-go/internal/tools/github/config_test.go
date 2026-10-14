package github

import (
	"github.com/hangtiancheng/yukino-code/apps/mcp-go/internal/config"
	"strings"
	"testing"
)

func TestConfiguredTokenOverridesNativeEnvironment(t *testing.T) {
	previous := config.Load()
	t.Cleanup(func() { config.Set(previous) })
	t.Setenv("GH_TOKEN", "old-token")
	cfg := config.Defaults()
	cfg.GitHub = config.GitHubConfig{Token: "configured", Hostname: "github.com"}
	config.Set(cfg)
	env := map[string]string{}
	for _, pair := range ghEnvironment() {
		key, value, _ := strings.Cut(pair, "=")
		env[key] = value
	}
	if env["GH_TOKEN"] != "configured" || env["GH_HOST"] != "github.com" {
		t.Fatalf("JSON credentials were ignored: token=%q host=%q", env["GH_TOKEN"], env["GH_HOST"])
	}
}
