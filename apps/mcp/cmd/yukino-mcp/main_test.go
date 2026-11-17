package main

import (
	"testing"

	"github.com/yukino-js/yukino/mcp/internal/config"
)

func TestConfigurationFlags(t *testing.T) {
	t.Setenv("MCP_TRANSPORT", "http")
	opts, err := parseOptions(nil)
	if err != nil || opts.configPath != config.DefaultPath || opts.http {
		t.Fatalf("defaults: %+v %v", opts, err)
	}
	opts, err = parseOptions([]string{"--config", "custom.json", "--http"})
	if err != nil || opts.configPath != "custom.json" || !opts.http {
		t.Fatalf("flags: %+v %v", opts, err)
	}
	for _, args := range [][]string{{"--config"}, {"--unknown"}, {"unexpected"}} {
		if _, err := parseOptions(args); err == nil {
			t.Fatalf("accepted invalid flags: %v", args)
		}
	}
}
