package config

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func loginInput() map[string]any {
	return map[string]any{
		"name":     "custom",
		"protocol": "anthropic",
		"base_url": "https://example.com",
		"api_key":  "test-key",
		"model":    "test-model",
	}
}

func TestProviderLoginValidation(t *testing.T) {
	t.Run("validates required fields and fills optional defaults", func(t *testing.T) {
		input := loginInput()
		input["context_window"] = ""
		input["max_output_tokens"] = " "
		p, err := ParseProviderLogin(input)
		if err != nil {
			t.Fatal(err)
		}
		if p.Thinking != "high" || p.ContextWindow != 1000000 || p.MaxOutputTokens != float64(DefaultMaxOutputTokens) {
			t.Fatalf("got thinking=%s context_window=%v max_output_tokens=%v", p.Thinking, p.ContextWindow, p.MaxOutputTokens)
		}
		for _, field := range []string{"name", "protocol", "base_url", "api_key", "model"} {
			bad := loginInput()
			bad[field] = " "
			if _, err := ParseProviderLogin(bad); err == nil {
				t.Fatalf("field %s: blank value must be rejected", field)
			}
		}
	})
	t.Run("defaults thinking to high for every protocol", func(t *testing.T) {
		for _, protocol := range []string{"openai", "openai-compat", "anthropic"} {
			input := loginInput()
			input["protocol"] = protocol
			p, err := ParseProviderLogin(input)
			if err != nil {
				t.Fatal(err)
			}
			if p.Thinking != "high" {
				t.Fatalf("protocol %s: thinking = %s, want high", protocol, p.Thinking)
			}
		}
	})
	t.Run("rejects the legacy boolean thinking values", func(t *testing.T) {
		for _, value := range []any{true, false} {
			input := loginInput()
			input["thinking"] = value
			if _, err := ParseProviderLogin(input); err == nil {
				t.Fatalf("thinking=%v must be rejected", value)
			}
		}
	})
	t.Run("rejects invalid numeric context", func(t *testing.T) {
		for _, value := range []string{"-1", "0", "1.5", "NaN", "Infinity", "999999999", "oops"} {
			input := loginInput()
			input["context_window"] = value
			if _, err := ParseProviderLogin(input); err == nil {
				t.Fatalf("context_window=%s must be rejected", value)
			}
		}
	})
	t.Run("checks output bounds and its relationship to the context window", func(t *testing.T) {
		for _, value := range []string{"0", "-1", "1.5", "Infinity", "1000001"} {
			input := loginInput()
			input["max_output_tokens"] = value
			if _, err := ParseProviderLogin(input); err == nil {
				t.Fatalf("max_output_tokens=%s must be rejected", value)
			}
		}
		input := loginInput()
		input["context_window"] = "10000"
		input["max_output_tokens"] = "20000"
		if _, err := ParseProviderLogin(input); err == nil {
			t.Fatal("max_output_tokens above context_window must be rejected")
		}
		input = loginInput()
		input["thinking"] = "off"
		input["context_window"] = "10000"
		input["max_output_tokens"] = "2048"
		p, err := ParseProviderLogin(input)
		if err != nil {
			t.Fatal(err)
		}
		if p.Thinking != "off" || p.ContextWindow != 10000 || p.MaxOutputTokens != 2048 {
			t.Fatalf("got %+v", p)
		}
	})
	t.Run("validates the thinking level", func(t *testing.T) {
		input := loginInput()
		input["thinking"] = "bogus"
		if _, err := ParseProviderLogin(input); err == nil {
			t.Fatal("bogus level must be rejected")
		}
		for _, level := range []string{"max", "off"} {
			input := loginInput()
			input["thinking"] = level
			p, err := ParseProviderLogin(input)
			if err != nil {
				t.Fatal(err)
			}
			if p.Thinking != level {
				t.Fatalf("thinking = %s, want %s", p.Thinking, level)
			}
		}
	})
}

func TestSaveProvider(t *testing.T) {
	setup := func(t *testing.T) string {
		t.Helper()
		home := t.TempDir()
		t.Setenv("HOME", home)
		return home
	}
	t.Run("saves to the global config, preserving settings and overwriting the same base_url", func(t *testing.T) {
		home := setup(t)
		if err := os.MkdirAll(filepath.Join(home, ".yukino"), 0o700); err != nil {
			t.Fatal(err)
		}
		path := GlobalConfigPath()
		if err := os.WriteFile(path, []byte("permission_mode: plan\nsandbox:\n  enabled: true\ncustom_setting: keep\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		first, err := SaveProvider(loginInput(), nil)
		if err != nil {
			t.Fatal(err)
		}
		if first.Replaced {
			t.Fatal("first save must not replace")
		}
		renamed := loginInput()
		renamed["name"] = "renamed"
		renamed["model"] = "new-model"
		second, err := SaveProvider(renamed, first.Providers)
		if err != nil {
			t.Fatal(err)
		}
		if !second.Replaced || second.Provider.Name != "renamed" {
			t.Fatalf("second save: replaced=%v name=%s", second.Replaced, second.Provider.Name)
		}
		if len(second.Providers) != 1 || second.Providers[0].Name != "renamed" || second.Providers[0].Model != "new-model" || second.Providers[0].BaseURL != "https://example.com" {
			t.Fatalf("providers = %+v", second.Providers)
		}
		third, err := SaveProvider(loginInput(), second.Providers)
		if err != nil {
			t.Fatal(err)
		}
		if len(third.Providers) != 1 || third.Providers[0].Name != "custom" {
			t.Fatalf("third providers = %+v", third.Providers)
		}
		reloaded, err := LoadConfig(path, LoadOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(reloaded.Providers, third.Providers) {
			t.Fatalf("reloaded %+v != saved %+v", reloaded.Providers, third.Providers)
		}
		if reloaded.Sandbox == nil || reloaded.Sandbox.Enabled == nil || !*reloaded.Sandbox.Enabled {
			t.Fatal("sandbox.enabled must stay true")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), "custom_setting: keep") {
			t.Fatal("custom_setting must be preserved")
		}
		if runtime.GOOS != "windows" {
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != 0o600 {
				t.Fatalf("mode = %o, want 600", info.Mode().Perm())
			}
		}
	})
	t.Run("appends providers with distinct base_urls and allows repeated names", func(t *testing.T) {
		setup(t)
		first, err := SaveProvider(loginInput(), nil)
		if err != nil {
			t.Fatal(err)
		}
		staging := loginInput()
		staging["base_url"] = "https://staging.example.com"
		second, err := SaveProvider(staging, first.Providers)
		if err != nil {
			t.Fatal(err)
		}
		if second.Replaced {
			t.Fatal("distinct base_url must append")
		}
		if len(second.Providers) != 2 || second.Providers[0].Name != "custom" || second.Providers[1].Name != "custom" {
			t.Fatalf("providers = %+v", second.Providers)
		}
		if second.Providers[0].BaseURL != "https://example.com" || second.Providers[1].BaseURL != "https://staging.example.com" {
			t.Fatalf("base urls = %s, %s", second.Providers[0].BaseURL, second.Providers[1].BaseURL)
		}
		reloaded, err := LoadConfig(second.Path, LoadOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if len(reloaded.Providers) != 2 {
			t.Fatalf("reloaded %d providers, want 2", len(reloaded.Providers))
		}
	})
	t.Run("replaces the entry in place and collapses legacy duplicates sharing a base_url", func(t *testing.T) {
		home := setup(t)
		if err := os.MkdirAll(filepath.Join(home, ".yukino"), 0o700); err != nil {
			t.Fatal(err)
		}
		path := GlobalConfigPath()
		content := strings.Join([]string{
			"providers:",
			"  - name: legacy",
			"    protocol: anthropic",
			"    base_url: https://example.com",
			"    model: old-model",
			"  - name: other",
			"    protocol: anthropic",
			"    base_url: https://other.example.com",
			"    model: other-model",
			"  - name: legacy2",
			"    protocol: anthropic",
			"    base_url: https://example.com",
			"    model: old-model",
			"",
		}, "\n")
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		saved, err := SaveProvider(loginInput(), nil)
		if err != nil {
			t.Fatal(err)
		}
		if !saved.Replaced {
			t.Fatal("expected replacement")
		}
		if len(saved.Providers) != 2 || saved.Providers[0].Name != "custom" || saved.Providers[1].Name != "other" {
			t.Fatalf("providers = %+v", saved.Providers)
		}
		reloaded, err := LoadConfig(path, LoadOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if len(reloaded.Providers) != 2 || reloaded.Providers[0].Name != "custom" || reloaded.Providers[1].Name != "other" {
			t.Fatalf("reloaded = %+v", reloaded.Providers)
		}
	})
	t.Run("creates the global config when it does not exist", func(t *testing.T) {
		setup(t)
		path := GlobalConfigPath()
		saved, err := SaveProvider(loginInput(), nil)
		if err != nil {
			t.Fatal(err)
		}
		if saved.Path != path {
			t.Fatalf("path = %s, want %s", saved.Path, path)
		}
		reloaded, err := LoadConfig(path, LoadOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if len(reloaded.Providers) != 1 || reloaded.Providers[0].Name != "custom" {
			t.Fatalf("reloaded = %+v", reloaded.Providers)
		}
	})
	t.Run("keeps an existing config untouched when parsing fails", func(t *testing.T) {
		setup(t)
		saved, err := SaveProvider(loginInput(), nil)
		if err != nil {
			t.Fatal(err)
		}
		before, err := os.ReadFile(saved.Path)
		if err != nil {
			t.Fatal(err)
		}
		bad := loginInput()
		bad["thinking_level_map"] = map[string]any{"high": "bogus"}
		if _, err := SaveProvider(bad, saved.Providers); err == nil {
			t.Fatal("invalid capability map must be rejected")
		}
		after, err := os.ReadFile(saved.Path)
		if err != nil {
			t.Fatal(err)
		}
		if string(before) != string(after) {
			t.Fatal("config file changed despite failed save")
		}
	})
	t.Run("persists a thinking level update to the global config", func(t *testing.T) {
		setup(t)
		if _, err := SaveProvider(loginInput(), nil); err != nil {
			t.Fatal(err)
		}
		if err := PersistThinkingLevel("https://example.com", "max"); err != nil {
			t.Fatal(err)
		}
		cfg, err := LoadConfig(GlobalConfigPath(), LoadOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if cfg.Providers[0].Thinking != "max" {
			t.Fatalf("thinking = %s, want max", cfg.Providers[0].Thinking)
		}
	})
	t.Run("persists default_provider and defaults it to 0 when absent", func(t *testing.T) {
		setup(t)
		if _, err := SaveProvider(loginInput(), nil); err != nil {
			t.Fatal(err)
		}
		path := GlobalConfigPath()
		cfg, err := LoadConfig(path, LoadOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if cfg.DefaultProvider != 0 {
			t.Fatalf("default_provider = %d, want 0", cfg.DefaultProvider)
		}
		if err := PersistDefaultProvider(2); err != nil {
			t.Fatal(err)
		}
		cfg, err = LoadConfig(path, LoadOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if cfg.DefaultProvider != 2 {
			t.Fatalf("default_provider = %d, want 2", cfg.DefaultProvider)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), "default_provider: 2") {
			t.Fatal("default_provider: 2 must be written")
		}
		before, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := PersistDefaultProvider(2); err != nil {
			t.Fatal(err)
		}
		after, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if !after.ModTime().Equal(before.ModTime()) {
			t.Fatal("file must not be rewritten when the index is unchanged")
		}
	})
	t.Run("throws when persisting a thinking level for an unknown provider", func(t *testing.T) {
		setup(t)
		if _, err := SaveProvider(loginInput(), nil); err != nil {
			t.Fatal(err)
		}
		if err := PersistThinkingLevel("https://unknown.example.com", "max"); err == nil || !strings.Contains(err.Error(), "base URL") {
			t.Fatalf("err = %v, want base URL not found", err)
		}
	})
	t.Run("applies defaults to old configuration without model-name inference", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.yaml")
		content := "providers:\n  - name: old\n    protocol: anthropic\n    base_url: https://example.com\n    model: claude-old\n"
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		cfg, err := LoadConfig(path, LoadOptions{})
		if err != nil {
			t.Fatal(err)
		}
		p := cfg.Providers[0]
		if p.Thinking != "high" || p.ContextWindow != 1000000 || p.MaxOutputTokens != float64(DefaultMaxOutputTokens) {
			t.Fatalf("got %+v", p)
		}
	})
	t.Run("reports invalid provider fields instead of dropping the provider", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.yaml")
		content := "providers:\n  - name: old\n    protocol: anthropic\n    base_url: https://example.com\n    model: claude-old\n    thinking: true\n"
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadConfig(path, LoadOptions{}); err == nil || !strings.Contains(err.Error(), "Invalid configuration") {
			t.Fatalf("err = %v, want Invalid configuration", err)
		}
	})
	t.Run("reports a missing global config file with a clean error", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		if _, err := LoadConfig("", LoadOptions{}); err == nil || !strings.Contains(err.Error(), "No config file found") {
			t.Fatalf("err = %v, want No config file found", err)
		}
	})
	t.Run("preserves known and future capability metadata through save, reload, and thinking updates", func(t *testing.T) {
		setup(t)
		input := loginInput()
		input["reasoning"] = true
		input["thinking_mode"] = "adaptive"
		input["thinking_level_map"] = map[string]any{"minimal": nil, "low": "medium", "xhigh": nil}
		input["future_capability"] = map[string]any{"supported": true}
		saved, err := SaveProvider(input, nil)
		if err != nil {
			t.Fatal(err)
		}
		if saved.Provider.Reasoning == nil || !*saved.Provider.Reasoning || saved.Provider.ThinkingMode != "adaptive" || saved.Provider.Thinking != "high" {
			t.Fatalf("saved provider = %+v", saved.Provider)
		}
		reload := func() ProviderConfig {
			t.Helper()
			cfg, err := LoadConfig(saved.Path, LoadOptions{})
			if err != nil {
				t.Fatal(err)
			}
			return cfg.Providers[0]
		}
		if p := reload(); p.Reasoning == nil || !*p.Reasoning || p.ThinkingMode != "adaptive" || p.ThinkingLevelMap == nil {
			t.Fatalf("reloaded = %+v", p)
		}
		if err := PersistThinkingLevel(saved.Provider.BaseURL, "low"); err != nil {
			t.Fatal(err)
		}
		if p := reload(); p.Thinking != "low" || p.Reasoning == nil || !*p.Reasoning {
			t.Fatalf("after persist = %+v", p)
		}
		overwriteInput := loginInput()
		overwriteInput["reasoning"] = false
		overwrite, err := SaveProvider(overwriteInput, saved.Providers)
		if err != nil {
			t.Fatal(err)
		}
		if !overwrite.Replaced || overwrite.Provider.Name != "custom" || overwrite.Provider.Thinking != "off" {
			t.Fatalf("overwrite = %+v", overwrite)
		}
		// base_url is the identity, so the stored entry is replaced wholesale.
		if len(overwrite.Providers) != 1 {
			t.Fatalf("providers = %+v", overwrite.Providers)
		}
		if p := reload(); p.Reasoning == nil || *p.Reasoning || p.Thinking != "off" {
			t.Fatalf("final reload = %+v", p)
		}
	})
	t.Run("preserves capability fields from available providers not yet on disk", func(t *testing.T) {
		setup(t)
		availableInput := loginInput()
		availableInput["name"] = "in-memory"
		availableInput["base_url"] = "https://in-memory.example.com"
		availableInput["reasoning"] = false
		availableInput["future_capability"] = map[string]any{"retained": true}
		available, err := ParseProviderLogin(availableInput)
		if err != nil {
			t.Fatal(err)
		}
		saved, err := SaveProvider(loginInput(), []ProviderConfig{available})
		if err != nil {
			t.Fatal(err)
		}
		if len(saved.Providers) != 2 || saved.Providers[0].BaseURL != "https://in-memory.example.com" || saved.Providers[1].BaseURL != "https://example.com" {
			t.Fatalf("providers = %+v", saved.Providers)
		}
		cfg, err := LoadConfig(saved.Path, LoadOptions{})
		if err != nil {
			t.Fatal(err)
		}
		p := cfg.Providers[0]
		if p.Name != "in-memory" || p.Reasoning == nil || *p.Reasoning {
			t.Fatalf("reloaded first provider = %+v", p)
		}
	})
	t.Run("saves effective defaults for capability-limited providers", func(t *testing.T) {
		input := loginInput()
		input["reasoning"] = false
		if p, err := ParseProviderLogin(input); err != nil || p.Thinking != "off" {
			t.Fatalf("reasoning=false: thinking = %s, err = %v", p.Thinking, err)
		}
		input = loginInput()
		input["max_output_tokens"] = 1024
		if p, err := ParseProviderLogin(input); err != nil || p.Thinking != "off" {
			t.Fatalf("small output cap: thinking = %s, err = %v", p.Thinking, err)
		}
		input = loginInput()
		input["thinking_level_map"] = map[string]any{"high": nil}
		if p, err := ParseProviderLogin(input); err != nil || p.Thinking != "medium" {
			t.Fatalf("high:null map: thinking = %s, err = %v", p.Thinking, err)
		}
	})
}
