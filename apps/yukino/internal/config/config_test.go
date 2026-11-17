package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func writeTempConfig(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestGetContextWindow(t *testing.T) {
	t.Run("returns configured value if set", func(t *testing.T) {
		p := &ProviderConfig{ContextWindow: 100000, Name: "p", Protocol: "anthropic", BaseURL: "#"}
		if got := GetContextWindow(p); got != 100000 {
			t.Fatalf("got %d, want 100000", got)
		}
	})
	t.Run("uses the 1M default independently of model names", func(t *testing.T) {
		p := &ProviderConfig{Model: "deepseek-flash", Name: "p", Protocol: "anthropic", BaseURL: "#"}
		if got := GetContextWindow(p); got != 1000000 {
			t.Fatalf("got %d, want 1000000", got)
		}
	})
	t.Run("uses the same default for OpenAI models", func(t *testing.T) {
		p := &ProviderConfig{Model: "deepseek-flash", Name: "p", Protocol: "openai", BaseURL: "#"}
		if got := GetContextWindow(p); got != 1000000 {
			t.Fatalf("got %d, want 1000000", got)
		}
	})
}

func TestGetMaxOutputTokens(t *testing.T) {
	base := func() *ProviderConfig {
		return &ProviderConfig{Name: "p", BaseURL: "#", Protocol: "anthropic", Model: "m"}
	}
	t.Run("returns the configured cap when set", func(t *testing.T) {
		p := base()
		p.MaxOutputTokens = 4096
		if got := GetMaxOutputTokens(p); got != 4096 {
			t.Fatalf("got %d, want 4096", got)
		}
	})
	t.Run("falls back to the 128k default", func(t *testing.T) {
		if got := GetMaxOutputTokens(base()); got != DefaultMaxOutputTokens {
			t.Fatalf("got %d, want %d", got, DefaultMaxOutputTokens)
		}
	})
	t.Run("ignores non-positive or non-integer values", func(t *testing.T) {
		p := base()
		p.MaxOutputTokens = 0
		if got := GetMaxOutputTokens(p); got != DefaultMaxOutputTokens {
			t.Fatalf("got %d, want %d", got, DefaultMaxOutputTokens)
		}
		p.MaxOutputTokens = 1.5
		if got := GetMaxOutputTokens(p); got != DefaultMaxOutputTokens {
			t.Fatalf("got %d, want %d", got, DefaultMaxOutputTokens)
		}
	})
	t.Run("never exceeds the context window", func(t *testing.T) {
		p := base()
		p.ContextWindow = 16_000
		p.MaxOutputTokens = 32_000
		if got := GetMaxOutputTokens(p); got != 16_000 {
			t.Fatalf("got %d, want 16000", got)
		}
		p2 := base()
		p2.ContextWindow = 16_000
		if got := GetMaxOutputTokens(p2); got != 16_000 {
			t.Fatalf("got %d, want 16000", got)
		}
	})
}

func TestGetThinkingLevel(t *testing.T) {
	base := func() *ProviderConfig {
		return &ProviderConfig{Name: "p", BaseURL: "#", Protocol: "anthropic", Model: "m"}
	}
	t.Run("defaults to high for every protocol when unset", func(t *testing.T) {
		if got := GetThinkingLevel(base()); got != "high" {
			t.Fatalf("got %s, want high", got)
		}
		p := base()
		p.Protocol = "openai"
		if got := GetThinkingLevel(p); got != "high" {
			t.Fatalf("got %s, want high", got)
		}
		p.Protocol = "openai-compat"
		if got := GetThinkingLevel(p); got != "high" {
			t.Fatalf("got %s, want high", got)
		}
	})
	t.Run("passes an explicit level through", func(t *testing.T) {
		p := base()
		p.Thinking = "max"
		if got := GetThinkingLevel(p); got != "max" {
			t.Fatalf("got %s, want max", got)
		}
		p.Thinking = "off"
		if got := GetThinkingLevel(p); got != "off" {
			t.Fatalf("got %s, want off", got)
		}
		p.Protocol = "openai"
		p.Thinking = "low"
		if got := GetThinkingLevel(p); got != "low" {
			t.Fatalf("got %s, want low", got)
		}
	})
}

func TestWithProviderDefaults(t *testing.T) {
	provider := WithProviderDefaults(ProviderConfig{Name: "p", Protocol: "openai", BaseURL: "#", Model: "m"})
	if provider.Thinking != "high" {
		t.Fatalf("thinking = %s, want high", provider.Thinking)
	}
	if provider.ContextWindow != 1000000 {
		t.Fatalf("context_window = %v, want 1000000", provider.ContextWindow)
	}
	if provider.MaxOutputTokens != float64(DefaultMaxOutputTokens) {
		t.Fatalf("max_output_tokens = %v, want %d", provider.MaxOutputTokens, DefaultMaxOutputTokens)
	}
}

func TestThinkingLevelHelpers(t *testing.T) {
	if !IsValidThinkingLevel("high") {
		t.Fatal("high must be valid")
	}
	if IsValidThinkingLevel("bogus") {
		t.Fatal("bogus must be invalid")
	}
	if got := ThinkingBudgetForLevel("minimal"); got != 1024 {
		t.Fatalf("minimal budget = %d, want 1024", got)
	}
	if got := ThinkingBudgetForLevel("high"); got != 16384 {
		t.Fatalf("high budget = %d, want 16384", got)
	}
	if got := ThinkingBudgetForLevel("max"); got != 65536 {
		t.Fatalf("max budget = %d, want 65536", got)
	}
	if got := ThinkingBudgetForLevel("off"); got != 0 {
		t.Fatalf("off budget = %d, want 0", got)
	}
	if got := ToReasoningEffort("off", nil); got != "none" {
		t.Fatalf("off effort = %q, want none", got)
	}
	if got := ToReasoningEffort("low", nil); got != "low" {
		t.Fatalf("low effort = %q, want low", got)
	}
	if got := ToReasoningEffort("max", nil); got != "max" {
		t.Fatalf("max effort = %q, want max", got)
	}
}

func TestExplicitThinkingCapabilities(t *testing.T) {
	base := func() *ProviderConfig {
		return &ProviderConfig{Name: "p", BaseURL: "#", Protocol: "openai", Model: "m"}
	}
	t.Run("does not infer capabilities from model names", func(t *testing.T) {
		for _, model := range []string{"deepseek-flash", "qwen3.8-flash", "arbitrary-model"} {
			p := base()
			p.Model = model
			if got := GetSupportedThinkingLevels(p); !reflect.DeepEqual(got, ThinkingLevels) {
				t.Fatalf("model %s: supported = %v, want %v", model, got, ThinkingLevels)
			}
			if got := GetThinkingLevel(p); got != "high" {
				t.Fatalf("model %s: level = %s, want high", model, got)
			}
		}
	})
	t.Run("only exposes off when configured as non-reasoning", func(t *testing.T) {
		p := base()
		reasoning := false
		p.Reasoning = &reasoning
		if got := GetSupportedThinkingLevels(p); !reflect.DeepEqual(got, []string{"off"}) {
			t.Fatalf("supported = %v, want [off]", got)
		}
		if got := GetThinkingLevel(p); got != "off" {
			t.Fatalf("level = %s, want off", got)
		}
		if got := ToReasoningEffort("off", p); got != "" {
			t.Fatalf("effort = %q, want null", got)
		}
		if got := WithProviderDefaults(*p).Thinking; got != "off" {
			t.Fatalf("defaults thinking = %s, want off", got)
		}
	})
	t.Run("uses partial overrides and clamps down rather than raising", func(t *testing.T) {
		p := base()
		p.ThinkingLevelMap = map[string]LevelOverride{
			"minimal": {Null: true},
			"low":     {Null: true},
			"high":    {Null: true},
			"max":     {Effort: "max"},
		}
		if got := GetSupportedThinkingLevels(p); !reflect.DeepEqual(got, []string{"off", "medium", "xhigh", "max"}) {
			t.Fatalf("supported = %v", got)
		}
		if got := ClampThinkingLevel(p, "low"); got != "off" {
			t.Fatalf("clamp(low) = %s, want off", got)
		}
		if got := ClampThinkingLevel(p, "high"); got != "medium" {
			t.Fatalf("clamp(high) = %s, want medium", got)
		}
		if got := ClampThinkingLevel(p, "max"); got != "max" {
			t.Fatalf("clamp(max) = %s, want max", got)
		}
		if got := GetThinkingLevel(p); got != "medium" {
			t.Fatalf("level = %s, want medium", got)
		}
		if got := ToReasoningEffort("max", p); got != "max" {
			t.Fatalf("effort(max) = %q, want max", got)
		}
	})
	t.Run("accounts for the context-clamped Anthropic budget ceiling", func(t *testing.T) {
		p := base()
		p.Protocol = "anthropic"
		p.ContextWindow = 1024
		p.MaxOutputTokens = 128000
		if got := GetSupportedThinkingLevels(p); !reflect.DeepEqual(got, []string{"off"}) {
			t.Fatalf("supported = %v, want [off]", got)
		}
		if got := GetThinkingLevel(p); got != "off" {
			t.Fatalf("level = %s, want off", got)
		}
		p.ThinkingMode = "adaptive"
		if got := GetSupportedThinkingLevels(p); !reflect.DeepEqual(got, ThinkingLevels) {
			t.Fatalf("adaptive supported = %v, want all levels", got)
		}
	})
}

func TestResolveAPIKey(t *testing.T) {
	t.Run("returns config api_key first", func(t *testing.T) {
		p := &ProviderConfig{APIKey: "sk-test", Name: "p", BaseURL: "#", Protocol: "anthropic", Model: "m"}
		if got := ResolveAPIKey(p); got != "sk-test" {
			t.Fatalf("got %s, want sk-test", got)
		}
	})
	t.Run("falls back to env var", func(t *testing.T) {
		t.Setenv("ANTHROPIC_API_KEY", "sk-from-env")
		p := &ProviderConfig{Name: "p", BaseURL: "#", Protocol: "anthropic", Model: "m"}
		if got := ResolveAPIKey(p); got != "sk-from-env" {
			t.Fatalf("got %s, want sk-from-env", got)
		}
	})
}

func TestMemoryEnabled(t *testing.T) {
	bare := func() *AppConfig {
		return &AppConfig{MCPLoading: "auto", Theme: "auto"}
	}
	if !bare().MemoryEnabled() {
		t.Fatal("defaults to enabled when unset")
	}
	off := false
	on := true
	cfg := bare()
	cfg.EnableMemory = &off
	if cfg.MemoryEnabled() {
		t.Fatal("disables for real when set to false")
	}
	cfg.EnableMemory = &on
	if !cfg.MemoryEnabled() {
		t.Fatal("stays enabled when set to true")
	}

	path := writeTempConfig(t, strings.Join([]string{
		"providers:",
		"  - name: provider",
		"    protocol: anthropic",
		"    base_url: https://provider.example.com",
		"    model: model",
		"enable_memory: false",
		"",
	}, "\n"))
	cfg2, err := LoadConfig(path, LoadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if cfg2.EnableMemory == nil || *cfg2.EnableMemory {
		t.Fatal("enable_memory: false must parse as false")
	}
	if cfg2.MemoryEnabled() {
		t.Fatal("memoryEnabled must be false")
	}
}

func TestRuntimePreferences(t *testing.T) {
	loadPreferences := func(t *testing.T, settings string) *AppConfig {
		t.Helper()
		path := writeTempConfig(t, "providers: []\n"+settings+"\n")
		cfg, err := LoadConfig(path, LoadOptions{AllowEmptyProviders: true})
		if err != nil {
			t.Fatalf("loadConfig: %s", err)
		}
		return cfg
	}
	t.Run("defaults to auto with a minimal config", func(t *testing.T) {
		cfg := loadPreferences(t, "")
		if cfg.MCPLoading != "auto" || cfg.Theme != "auto" {
			t.Fatalf("got mcp_loading=%s theme=%s, want auto/auto", cfg.MCPLoading, cfg.Theme)
		}
	})
	for _, loading := range []string{"auto", "eager", "native", "dispatch"} {
		t.Run("parses mcp_loading "+loading, func(t *testing.T) {
			if got := loadPreferences(t, "mcp_loading: "+loading).MCPLoading; got != loading {
				t.Fatalf("got %s, want %s", got, loading)
			}
		})
	}
	for _, theme := range []string{"auto", "dark", "light"} {
		t.Run("parses theme "+theme, func(t *testing.T) {
			if got := loadPreferences(t, "theme: "+theme).Theme; got != theme {
				t.Fatalf("got %s, want %s", got, theme)
			}
		})
	}
	for _, settings := range []string{"mcp_loading: invalid", "mcp_loading: 1", "theme: invalid", "theme: true"} {
		t.Run("rejects invalid preferences: "+settings, func(t *testing.T) {
			path := writeTempConfig(t, "providers: []\n"+settings+"\n")
			_, err := LoadConfig(path, LoadOptions{AllowEmptyProviders: true})
			if err == nil || !strings.Contains(err.Error(), "Invalid configuration") {
				t.Fatalf("err = %v, want Invalid configuration", err)
			}
		})
	}
}

func TestEnvBlock(t *testing.T) {
	const envA = "YUKINO_ENV_BLOCK_TEST_A"
	const envB = "YUKINO_ENV_BLOCK_TEST_B"
	writeConfig := func(t *testing.T, envLines ...string) string {
		lines := []string{
			"providers:",
			"  - name: provider",
			"    protocol: anthropic",
			"    base_url: https://provider.example.com",
			"    model: model",
		}
		lines = append(lines, envLines...)
		return writeTempConfig(t, strings.Join(lines, "\n")+"\n")
	}

	t.Run("hydrates unset variables from a mapping block", func(t *testing.T) {
		t.Setenv(envA, "")
		os.Unsetenv(envA)
		t.Setenv(envB, "")
		os.Unsetenv(envB)
		cfg, err := LoadConfig(writeConfig(t, "env:", "  "+envA+": \"1\"", "  "+envB+": eager"), LoadOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(cfg.Env, map[string]string{envA: "1", envB: "eager"}) {
			t.Fatalf("env = %v", cfg.Env)
		}
		if os.Getenv(envA) != "1" || os.Getenv(envB) != "eager" {
			t.Fatalf("process env not hydrated: %s %s", os.Getenv(envA), os.Getenv(envB))
		}
	})
	t.Run("never overrides a variable set in the real environment", func(t *testing.T) {
		t.Setenv(envA, "from-real-env")
		if _, err := LoadConfig(writeConfig(t, "env:", "  "+envA+": \"from-config\""), LoadOptions{}); err != nil {
			t.Fatal(err)
		}
		if os.Getenv(envA) != "from-real-env" {
			t.Fatalf("env %s = %s, want from-real-env", envA, os.Getenv(envA))
		}
	})
	t.Run("accepts the list-of-single-key-mappings form", func(t *testing.T) {
		os.Unsetenv(envA)
		os.Unsetenv(envB)
		cfg, err := LoadConfig(writeConfig(t, "env:", "  - "+envA+": 1", "  - "+envB+": eager"), LoadOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(cfg.Env, map[string]string{envA: "1", envB: "eager"}) {
			t.Fatalf("env = %v", cfg.Env)
		}
	})
	t.Run("stringifies scalars and maps an empty value to the empty string", func(t *testing.T) {
		os.Unsetenv(envA)
		os.Unsetenv(envB)
		cfg, err := LoadConfig(writeConfig(t, "env:", "  "+envA+": 1", "  "+envB+":"), LoadOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(cfg.Env, map[string]string{envA: "1", envB: ""}) {
			t.Fatalf("env = %v", cfg.Env)
		}
		if os.Getenv(envA) != "1" || os.Getenv(envB) != "" {
			t.Fatalf("process env wrong: %q %q", os.Getenv(envA), os.Getenv(envB))
		}
	})
	t.Run("treats a bare env key (null block) as empty", func(t *testing.T) {
		cfg, err := LoadConfig(writeConfig(t, "env:"), LoadOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if len(cfg.Env) != 0 {
			t.Fatalf("env = %v, want empty", cfg.Env)
		}
	})
	t.Run("hydrates before provider validation reports an error", func(t *testing.T) {
		os.Unsetenv(envA)
		dir := t.TempDir()
		path := filepath.Join(dir, "config.yaml")
		content := strings.Join([]string{
			"providers:",
			"  - name: a",
			"    protocol: anthropic",
			"    base_url: https://dup.example.com",
			"    model: m",
			"  - name: b",
			"    protocol: anthropic",
			"    base_url: https://dup.example.com",
			"    model: m",
			"env:",
			"  " + envA + ": hydrated",
			"",
		}, "\n")
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadConfig(path, LoadOptions{}); err == nil || !strings.Contains(err.Error(), "duplicate base_url") {
			t.Fatalf("err = %v, want duplicate base_url", err)
		}
		if os.Getenv(envA) != "hydrated" {
			t.Fatalf("env %s = %q, want hydrated", envA, os.Getenv(envA))
		}
	})
	t.Run("hydrateConfigEnv reads the global config", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		os.Unsetenv(envA)
		configDir := filepath.Join(home, ".yukino")
		if err := os.MkdirAll(configDir, 0o700); err != nil {
			t.Fatal(err)
		}
		content := strings.Join([]string{"providers: []", "env:", "  " + envA + ": \"1\""}, "\n")
		if err := os.WriteFile(filepath.Join(configDir, "config.yaml"), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		HydrateConfigEnv()
		if os.Getenv(envA) != "1" {
			t.Fatalf("env %s = %q, want 1", envA, os.Getenv(envA))
		}
	})
	t.Run("hydrateConfigEnv tolerates a missing or broken config", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		os.Unsetenv(envA)
		HydrateConfigEnv()
		configDir := filepath.Join(home, ".yukino")
		if err := os.MkdirAll(configDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(configDir, "config.yaml"), []byte("providers: ["), 0o600); err != nil {
			t.Fatal(err)
		}
		HydrateConfigEnv()
		if os.Getenv(envA) != "" {
			t.Fatalf("env %s unexpectedly set", envA)
		}
	})
}

func TestProjectMcpJSON(t *testing.T) {
	writeMcpJSON := func(t *testing.T, dir, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, ".mcp.json"), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Run("returns nil when the file is absent", func(t *testing.T) {
		if got := LoadProjectMcpServers(t.TempDir()); got != nil {
			t.Fatalf("got %v, want nil", got)
		}
	})
	t.Run("maps stdio, http and sse entries onto MCPServerConfig", func(t *testing.T) {
		dir := t.TempDir()
		writeMcpJSON(t, dir, `{
			"mcpServers": {
				"db": {"command": "npx", "args": ["-y", "db-mcp"], "env": {"API_KEY": "${DB_KEY}"}},
				"web": {"url": "https://example.com/mcp"},
				"legacy": {"type": "sse", "url": "https://example.com/sse", "headers": {"A": "b"}}
			}
		}`)
		got := LoadProjectMcpServers(dir)
		want := []MCPServerConfig{
			{Name: "db", Command: "npx", Args: []string{"-y", "db-mcp"}, Env: map[string]string{"API_KEY": "${DB_KEY}"}},
			{Name: "web", URL: "https://example.com/mcp", Transport: "http"},
			{Name: "legacy", URL: "https://example.com/sse", Transport: "sse", Headers: map[string]string{"A": "b"}},
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	})
	t.Run("skips entries missing the field their transport needs", func(t *testing.T) {
		dir := t.TempDir()
		writeMcpJSON(t, dir, `{
			"mcpServers": {
				"empty": {},
				"noUrl": {"type": "http"},
				"noCommand": {"type": "stdio", "args": ["x"]},
				"ambiguous": {"command": "stdio", "url": "https://example.com/mcp"},
				"ok": {"command": "true"}
			}
		}`)
		got := LoadProjectMcpServers(dir)
		want := []MCPServerConfig{{Name: "ok", Command: "true"}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	})
	t.Run("degrades to nil on malformed JSON or schema violations", func(t *testing.T) {
		dir := t.TempDir()
		writeMcpJSON(t, dir, "{not json")
		if got := LoadProjectMcpServers(dir); got != nil {
			t.Fatalf("got %v, want nil", got)
		}
		writeMcpJSON(t, dir, `{"mcpServers": {"bad": {"command": 42}}}`)
		if got := LoadProjectMcpServers(dir); got != nil {
			t.Fatalf("got %v, want nil", got)
		}
	})
	t.Run("keeps valid servers when a sibling entry is invalid", func(t *testing.T) {
		dir := t.TempDir()
		writeMcpJSON(t, dir, `{"mcpServers": {"bad": {"command": 42}, "good": {"command": "good-server"}}}`)
		got := LoadProjectMcpServers(dir)
		want := []MCPServerConfig{{Name: "good", Command: "good-server"}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	})
	t.Run("appends project servers and lets user config win on collisions", func(t *testing.T) {
		dir := t.TempDir()
		writeMcpJSON(t, dir, `{"mcpServers": {"shared": {"command": "project-binary"}, "extra": {"command": "extra-binary"}}}`)
		base := &AppConfig{MCPLoading: "auto", Theme: "auto", MCPServers: []MCPServerConfig{{Name: "shared", Command: "user-binary"}}}
		merged := WithProjectMcpServers(base, dir)
		want := []MCPServerConfig{
			{Name: "shared", Command: "user-binary"},
			{Name: "extra", Command: "extra-binary"},
		}
		if !reflect.DeepEqual(merged.MCPServers, want) {
			t.Fatalf("got %+v, want %+v", merged.MCPServers, want)
		}
		if len(base.MCPServers) != 1 || base.MCPServers[0].Command != "user-binary" {
			t.Fatal("input config must stay untouched")
		}
	})
	t.Run("returns the config unchanged when there is no .mcp.json", func(t *testing.T) {
		base := &AppConfig{MCPLoading: "auto", Theme: "auto"}
		if got := WithProjectMcpServers(base, t.TempDir()); got != base {
			t.Fatal("expected the same config pointer")
		}
	})
	t.Run("rejects duplicate provider base URLs because base_url is the identity", func(t *testing.T) {
		path := writeTempConfig(t, strings.Join([]string{
			"providers:",
			"  - name: first",
			"    protocol: anthropic",
			"    base_url: https://same.example.com",
			"    model: first-model",
			"  - name: second",
			"    protocol: openai",
			"    base_url: https://same.example.com",
			"    model: second-model",
			"",
		}, "\n"))
		if _, err := LoadConfig(path, LoadOptions{}); err == nil || !strings.Contains(err.Error(), "duplicate base_url") {
			t.Fatalf("err = %v, want duplicate base_url", err)
		}
	})
	t.Run("rejects ambiguous or unusable user-level MCP server entries", func(t *testing.T) {
		path := writeTempConfig(t, strings.Join([]string{
			"providers:",
			"  - name: provider",
			"    protocol: anthropic",
			"    base_url: https://provider.example.com",
			"    model: model",
			"mcp_servers:",
			"  - name: broken",
			"    command: command",
			"    url: https://example.com/mcp",
			"",
		}, "\n"))
		if _, err := LoadConfig(path, LoadOptions{}); err == nil || !strings.Contains(err.Error(), "exactly one of command or url") {
			t.Fatalf("err = %v, want exactly one of command or url", err)
		}
		path2 := writeTempConfig(t, strings.Join([]string{
			"providers:",
			"  - name: provider",
			"    protocol: anthropic",
			"    base_url: https://provider.example.com",
			"    model: model",
			"mcp_servers:",
			"  - name: broken",
			"    command: 42",
			"",
		}, "\n"))
		if _, err := LoadConfig(path2, LoadOptions{}); err == nil || !strings.Contains(err.Error(), "Invalid configuration") {
			t.Fatalf("err = %v, want Invalid configuration", err)
		}
	})
}
