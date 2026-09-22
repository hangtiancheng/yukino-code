// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const validProviderYAML = `providers:
  - name: first
    protocol: anthropic
    base_url: https://api.example.com
    model: some-model
`

func writeConfig(t *testing.T, dir, content string) string {
	t.Helper()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadConfigExplicitPath(t *testing.T) {
	path := writeConfig(t, t.TempDir(), validProviderYAML)
	cfg, err := LoadConfig(path, LoadOptions{})
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if len(cfg.Providers) != 1 || cfg.Providers[0].Name != "first" {
		t.Fatalf("config wrong: %+v", cfg.Providers)
	}
}

func TestLoadConfigRejectsDuplicateBaseURL(t *testing.T) {
	path := writeConfig(t, t.TempDir(), `providers:
  - name: first
    protocol: anthropic
    base_url: https://same.example.com
    model: first-model
  - name: second
    protocol: openai
    base_url: https://same.example.com
    model: second-model
`)
	_, err := LoadConfig(path, LoadOptions{})
	if err == nil || !strings.Contains(err.Error(), "duplicate base_url") {
		t.Fatalf("want duplicate base_url error, got %v", err)
	}
}

func TestLoadConfigValidatesMcpServers(t *testing.T) {
	cases := []struct {
		name string
		yaml string
		want string
	}{
		{
			name: "empty name",
			yaml: "mcp_servers:\n  - name: \"\"\n    command: x\n",
			want: "name must not be empty",
		},
		{
			name: "duplicate name",
			yaml: "mcp_servers:\n  - name: a\n    command: x\n  - name: a\n    command: y\n",
			want: "duplicate name",
		},
		{
			name: "both command and url",
			yaml: "mcp_servers:\n  - name: a\n    command: x\n    url: https://e.com\n",
			want: "exactly one of command or url",
		},
		{
			name: "neither command nor url",
			yaml: "mcp_servers:\n  - name: a\n",
			want: "exactly one of command or url",
		},
		{
			name: "command with non-stdio transport",
			yaml: "mcp_servers:\n  - name: a\n    command: x\n    transport: http\n",
			want: "command servers must use stdio",
		},
		{
			name: "url with bad transport",
			yaml: "mcp_servers:\n  - name: a\n    url: https://e.com\n    transport: stdio\n",
			want: "URL transport must be http or sse",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := writeConfig(t, t.TempDir(), validProviderYAML+tc.yaml)
			_, err := LoadConfig(path, LoadOptions{})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want error containing %q, got %v", tc.want, err)
			}
		})
	}
}

func TestLoadConfigAllowEmptyProviders(t *testing.T) {
	// A config with mcp servers but no providers loads with the option set.
	path := writeConfig(t, t.TempDir(), "mcp_servers:\n  - name: a\n    command: x\n")
	if _, err := LoadConfig(path, LoadOptions{}); err == nil {
		t.Fatal("without the option, empty providers must fail")
	}
	cfg, err := LoadConfig(path, LoadOptions{AllowEmptyProviders: true})
	if err != nil {
		t.Fatalf("with the option, empty providers must load: %v", err)
	}
	if len(cfg.MCPServers) != 1 {
		t.Fatalf("mcp servers lost: %+v", cfg)
	}
}

func TestGlobalConfigPath(t *testing.T) {
	path, err := GlobalConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	home, _ := os.UserHomeDir()
	if path != filepath.Join(home, ".yukino", "config.yaml") {
		t.Fatalf("global config path wrong: %s", path)
	}
}

// TestLoadConfigAppliesProviderDefaults pins the TS loadSingleFile behaviour:
// every loaded provider is mapped through withProviderDefaults, materializing
// the effective thinking level, context window and output cap.
func TestLoadConfigAppliesProviderDefaults(t *testing.T) {
	path := writeConfig(t, t.TempDir(), validProviderYAML)
	cfg, err := LoadConfig(path, LoadOptions{})
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	p := cfg.Providers[0]
	if p.Thinking != DefaultThinkingLevel {
		t.Errorf("thinking = %q, want %q", p.Thinking, DefaultThinkingLevel)
	}
	if p.ContextWindow != DefaultContextWindow {
		t.Errorf("context_window = %v, want %d", p.ContextWindow, DefaultContextWindow)
	}
	if p.MaxOutputTokens != DefaultMaxOutputTokens {
		t.Errorf("max_output_tokens = %v, want %d", p.MaxOutputTokens, DefaultMaxOutputTokens)
	}
}

// TestLoadConfigSalvagesFieldsWhenHooksInvalid mirrors the TS field-by-field
// fallback: a hooks entry missing its required action fails the whole-schema
// parse, the hooks array is silently dropped, and the valid providers survive.
func TestLoadConfigSalvagesFieldsWhenHooksInvalid(t *testing.T) {
	path := writeConfig(t, t.TempDir(), validProviderYAML+`hooks:
  - event: pre_tool_use
    condition: 'tool == "Bash"'
`)
	cfg, err := LoadConfig(path, LoadOptions{})
	if err != nil {
		t.Fatalf("salvage load failed: %v", err)
	}
	if len(cfg.Providers) != 1 {
		t.Fatalf("providers lost during salvage: %+v", cfg.Providers)
	}
	if len(cfg.Hooks) != 0 {
		t.Fatalf("invalid hooks must be dropped, got %+v", cfg.Hooks)
	}
}

// TestLoadConfigInvalidProviderSectionFails pins the TS hard failure for a
// schema-invalid providers array (invalid protocol enum here).
func TestLoadConfigInvalidProviderSectionFails(t *testing.T) {
	path := writeConfig(t, t.TempDir(), `providers:
  - name: first
    protocol: gemini
    base_url: https://api.example.com
    model: some-model
`)
	_, err := LoadConfig(path, LoadOptions{})
	if err == nil || !strings.Contains(err.Error(), "Invalid provider configuration in") {
		t.Fatalf("want Invalid provider configuration error, got %v", err)
	}
}

// TestLoadConfigInvalidMcpSectionFails pins the TS hard failure for a
// schema-invalid mcp_servers array (missing required name key here).
func TestLoadConfigInvalidMcpSectionFails(t *testing.T) {
	path := writeConfig(t, t.TempDir(), validProviderYAML+`mcp_servers:
  - command: x
`)
	_, err := LoadConfig(path, LoadOptions{})
	if err == nil || !strings.Contains(err.Error(), "Invalid MCP server configuration in") {
		t.Fatalf("want Invalid MCP server configuration error, got %v", err)
	}
}

// TestLoadConfigInvalidSandboxBackendFails pins the TS hard failure for an
// unknown sandbox backend spelling.
func TestLoadConfigInvalidSandboxBackendFails(t *testing.T) {
	path := writeConfig(t, t.TempDir(), validProviderYAML+`sandbox:
  enabled: true
  backend: docker
`)
	_, err := LoadConfig(path, LoadOptions{})
	if err == nil || !strings.Contains(err.Error(), "Invalid sandbox configuration in") {
		t.Fatalf("want Invalid sandbox configuration error, got %v", err)
	}
}

// TestLoadConfigNonMappingYaml mirrors the TS behaviour for a valid-YAML
// non-record document: log and yield the empty config, which then fails
// provider validation like an empty file would.
func TestLoadConfigNonMappingYaml(t *testing.T) {
	path := writeConfig(t, t.TempDir(), "- just\n- a\n- list\n")
	_, err := LoadConfig(path, LoadOptions{})
	if err == nil || !strings.Contains(err.Error(), "At least one provider MUST be configured.") {
		t.Fatalf("want provider validation error, got %v", err)
	}
	cfg, err := LoadConfig(path, LoadOptions{AllowEmptyProviders: true})
	if err != nil {
		t.Fatalf("allow-empty load failed: %v", err)
	}
	if len(cfg.Providers) != 0 || len(cfg.MCPServers) != 0 {
		t.Fatalf("non-mapping yaml must yield the empty config, got %+v", cfg)
	}
}

// TestLoadConfigFallbackBooleanCoercion mirrors the TS fallback's JS
// Boolean() coercion: once the whole-schema parse has failed (bad hooks
// here), a non-boolean enable_fork is coerced by truthiness — a non-empty
// string is true even when it spells "false".
func TestLoadConfigFallbackBooleanCoercion(t *testing.T) {
	path := writeConfig(t, t.TempDir(), validProviderYAML+`enable_fork: "false"
enable_coordinator_mode: 1
hooks:
  - event: pre_tool_use
`)
	cfg, err := LoadConfig(path, LoadOptions{})
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if !cfg.ForkEnabled() {
		t.Error(`Boolean("false") is true in JS; enable_fork must stay enabled`)
	}
	if !cfg.EnableCoordinatorMode {
		t.Error("Boolean(1) is true in JS; coordinator mode must be enabled")
	}
	if len(cfg.Hooks) != 0 {
		t.Errorf("invalid hooks must be dropped, got %+v", cfg.Hooks)
	}
}
