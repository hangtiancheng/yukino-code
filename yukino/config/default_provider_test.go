package config

import "testing"

const twoProvidersYAML = `default_provider: 1
providers:
  - name: first
    protocol: anthropic
    base_url: https://first.example.com
    model: first-model
  - name: second
    protocol: openai
    base_url: https://second.example.com
    model: second-model
`

func TestLoadConfigParsesDefaultProvider(t *testing.T) {
	path := writeConfig(t, t.TempDir(), twoProvidersYAML)
	cfg, err := LoadConfig(path, LoadOptions{})
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if cfg.DefaultProvider != 1 {
		t.Fatalf("DefaultProvider = %d, want 1", cfg.DefaultProvider)
	}
	if got := cfg.DefaultProviderEntry(); got.Name != "second" {
		t.Fatalf("DefaultProviderEntry() = %s, want second", got.Name)
	}
}

func TestDefaultProviderDefaultsToZeroWhenAbsent(t *testing.T) {
	path := writeConfig(t, t.TempDir(), validProviderYAML)
	cfg, err := LoadConfig(path, LoadOptions{})
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if cfg.DefaultProvider != 0 {
		t.Fatalf("DefaultProvider = %d, want 0", cfg.DefaultProvider)
	}
	if got := cfg.DefaultProviderEntry(); got.Name != "first" {
		t.Fatalf("DefaultProviderEntry() = %s, want first", got.Name)
	}
}

func TestDefaultProviderEntryFallsBackWhenOutOfRange(t *testing.T) {
	cfg := &AppConfig{
		DefaultProvider: 5,
		Providers:       []ProviderConfig{{Name: "first"}, {Name: "second"}},
	}
	if got := cfg.DefaultProviderEntry(); got.Name != "first" {
		t.Fatalf("DefaultProviderEntry() = %s, want first", got.Name)
	}
	cfg.DefaultProvider = -2
	if got := cfg.DefaultProviderEntry(); got.Name != "first" {
		t.Fatalf("DefaultProviderEntry() = %s, want first", got.Name)
	}
}

func TestLoadConfigSalvagesDefaultProvider(t *testing.T) {
	// enable_fork must be a real boolean for the whole-schema decode; the
	// invalid value forces the field-by-field salvage, which must keep both
	// default_provider and the providers list.
	path := writeConfig(t, t.TempDir(), `default_provider: 1
enable_fork: "yes"
providers:
  - name: first
    protocol: anthropic
    base_url: https://first.example.com
    model: first-model
  - name: second
    protocol: openai
    base_url: https://second.example.com
    model: second-model
`)
	cfg, err := LoadConfig(path, LoadOptions{})
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if cfg.DefaultProvider != 1 {
		t.Fatalf("DefaultProvider = %d, want 1 (salvaged)", cfg.DefaultProvider)
	}
	if len(cfg.Providers) != 2 {
		t.Fatalf("providers not salvaged: %+v", cfg.Providers)
	}
	if got := cfg.DefaultProviderEntry(); got.Name != "second" {
		t.Fatalf("DefaultProviderEntry() = %s, want second", got.Name)
	}
}
