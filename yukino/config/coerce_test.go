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
	"errors"
	"math"
	"strings"
	"testing"
)

// TestCoerceNumberQuotedStrings pins the TS z.coerce.number() behaviour for
// context_window / max_output_tokens: quoted numeric strings coerce through
// JS Number() instead of failing the provider entry.
func TestCoerceNumberQuotedStrings(t *testing.T) {
	path := writeConfig(t, t.TempDir(), `providers:
  - name: first
    protocol: anthropic
    base_url: https://api.example.com
    model: some-model
    context_window: "200000"
    max_output_tokens: "4096"
`)
	cfg, err := LoadConfig(path, LoadOptions{})
	if err != nil {
		t.Fatalf("quoted numeric strings must coerce like TS z.coerce.number(): %v", err)
	}
	p := cfg.Providers[0]
	if got := p.GetContextWindow(); got != 200000 {
		t.Errorf("context_window = %d, want 200000", got)
	}
	if got := p.GetMaxOutputTokens(); got != 4096 {
		t.Errorf("max_output_tokens = %d, want 4096", got)
	}
}

// TestCoerceNumberRejectsNonNumeric pins the zod failure side: a string that
// JS Number() turns into NaN fails the provider entry, surfacing the salvage
// ConfigError instead of silently dropping the value.
func TestCoerceNumberRejectsNonNumeric(t *testing.T) {
	path := writeConfig(t, t.TempDir(), `providers:
  - name: first
    protocol: anthropic
    base_url: https://api.example.com
    model: some-model
    context_window: "abc"
`)
	_, err := LoadConfig(path, LoadOptions{})
	var cfgErr *ConfigError
	if !errors.As(err, &cfgErr) {
		t.Fatalf("non-numeric context_window must fail the provider entry, got %v", err)
	}
	if !strings.Contains(cfgErr.Message, "Invalid provider configuration in") {
		t.Errorf("error wording = %q, want the salvage ConfigError prefix", cfgErr.Message)
	}
}

// TestOptionalFieldsRejectExplicitNull pins zod's optional-but-not-nullable
// semantics: `api_key:` (explicit null) fails the provider entry, while an
// absent key is fine. The z.coerce.number() fields are the exception — null
// coerces to 0 through JS Number().
func TestOptionalFieldsRejectExplicitNull(t *testing.T) {
	path := writeConfig(t, t.TempDir(), `providers:
  - name: first
    protocol: anthropic
    base_url: https://api.example.com
    model: some-model
    api_key:
`)
	_, err := LoadConfig(path, LoadOptions{})
	var cfgErr *ConfigError
	if !errors.As(err, &cfgErr) {
		t.Fatalf("explicit null api_key must fail the provider entry, got %v", err)
	}
	if !strings.Contains(cfgErr.Message, "Invalid provider configuration in") {
		t.Errorf("error wording = %q, want the salvage ConfigError prefix", cfgErr.Message)
	}

	// A null context_window coerces to 0 (Number(null)) and falls back to the
	// default instead of failing.
	path = writeConfig(t, t.TempDir(), `providers:
  - name: first
    protocol: anthropic
    base_url: https://api.example.com
    model: some-model
    context_window:
`)
	cfg, err := LoadConfig(path, LoadOptions{})
	if err != nil {
		t.Fatalf("null context_window must coerce to 0, got %v", err)
	}
	if got := cfg.Providers[0].GetContextWindow(); got != DefaultContextWindow {
		t.Errorf("context_window = %d, want the %d default", got, DefaultContextWindow)
	}
}

// TestJSStringToNumber pins the ECMA-262 StringToNumber grammar against
// Node-verified results: non-decimal integer literals (unsigned only), the
// exact "Infinity" spelling, JS whitespace trimming (FEFF in, NEL out) and
// the decimal grammar without Go literal extras.
func TestJSStringToNumber(t *testing.T) {
	cases := []struct {
		in   string
		want float64
		ok   bool
	}{
		{"0x10", 16, true},
		{"0XFF", 255, true},
		{"0b101", 5, true},
		{"0o17", 15, true},
		{"0B101", 5, true},
		{"0O17", 15, true},
		{"-0x10", 0, false}, // signs only apply to decimal literals and Infinity
		{"+0x10", 0, false},
		{"0x", 0, false},
		{"0x1.8", 0, false},
		{"0o8", 0, false},
		{"Infinity", math.Inf(1), true},
		{"-Infinity", math.Inf(-1), true},
		{"+Infinity", math.Inf(1), true},
		{"inf", 0, false},
		{"INF", 0, false},
		{"NaN", 0, false},
		{"  12  ", 12, true},
		{"\uFEFF1", 1, true},
		{"\u00851", 0, false},
		{"1_0", 0, false},
		{"5.", 5, true},
		{".5", 0.5, true},
		{"1e3", 1000, true},
		{"017", 17, true},
		{"", 0, true},
		{"   ", 0, true},
		{"1e999", math.Inf(1), true},
		{"-1e999", math.Inf(-1), true},
		{"12abc", 0, false},
		{"0x10p4", 0, false},
	}
	for _, c := range cases {
		got, ok := jsStringToNumber(c.in)
		if ok != c.ok || got != c.want {
			t.Errorf("jsStringToNumber(%q) = (%v, %v), want (%v, %v)", c.in, got, ok, c.want, c.ok)
		}
	}
}

// TestCoerceNumberNonDecimalLiterals pins hex coercion through the config
// path: JS Number("0x10") = 16, while "Infinity" coerces to +Inf and the
// Number.isSafeInteger getters fall back to the defaults.
func TestCoerceNumberNonDecimalLiterals(t *testing.T) {
	path := writeConfig(t, t.TempDir(), `providers:
  - name: first
    protocol: anthropic
    base_url: https://api.example.com
    model: some-model
    context_window: "0x10"
  - name: second
    protocol: anthropic
    base_url: https://api2.example.com
    model: some-model
    context_window: "Infinity"
`)
	cfg, err := LoadConfig(path, LoadOptions{})
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if got := cfg.Providers[0].GetContextWindow(); got != 16 {
		t.Errorf("context_window = %d, want 16 (Number(\"0x10\"))", got)
	}
	if got := cfg.Providers[1].GetContextWindow(); got != DefaultContextWindow {
		t.Errorf("context_window = %d, want the %d default for Infinity", got, DefaultContextWindow)
	}
}

// TestSectionsRejectExplicitNull pins zod parity for the non-provider
// sections: an explicit null on any schema field fails the entry. sandbox and
// mcp_servers surface a ConfigError; hooks are silently dropped (TS salvage).
func TestSectionsRejectExplicitNull(t *testing.T) {
	sandboxPath := writeConfig(t, t.TempDir(), `providers:
  - name: first
    protocol: anthropic
    base_url: https://api.example.com
    model: some-model
sandbox:
  enabled:
`)
	_, err := LoadConfig(sandboxPath, LoadOptions{})
	var cfgErr *ConfigError
	if !errors.As(err, &cfgErr) || !strings.Contains(cfgErr.Message, "Invalid sandbox configuration in") {
		t.Fatalf("explicit null sandbox.enabled must fail the sandbox section, got %v", err)
	}

	mcpPath := writeConfig(t, t.TempDir(), `providers:
  - name: first
    protocol: anthropic
    base_url: https://api.example.com
    model: some-model
mcp_servers:
  - name: srv
    command: node
    args: [index.js, null]
`)
	_, err = LoadConfig(mcpPath, LoadOptions{})
	if !errors.As(err, &cfgErr) || !strings.Contains(cfgErr.Message, "Invalid MCP server configuration in") {
		t.Fatalf("null args element must fail the mcp_servers section, got %v", err)
	}

	// hooks: TS drops the whole array silently when it fails the schema.
	hooksPath := writeConfig(t, t.TempDir(), `providers:
  - name: first
    protocol: anthropic
    base_url: https://api.example.com
    model: some-model
hooks:
  - event: pre_tool_use
    action:
      type: command
      command:
`)
	cfg, err := LoadConfig(hooksPath, LoadOptions{})
	if err != nil {
		t.Fatalf("null hook action.command must salvage, got %v", err)
	}
	if len(cfg.Hooks) != 0 {
		t.Errorf("hooks = %d entries, want 0 (TS drops a schema-failing hooks array)", len(cfg.Hooks))
	}
}

// TestCoerceNumberEdgeValues pins the remaining JS Number() edges: booleans
// coerce to 1/0, and non-integer floats fall back to the defaults because
// getContextWindow/getMaxOutputTokens require Number.isSafeInteger.
func TestCoerceNumberEdgeValues(t *testing.T) {
	path := writeConfig(t, t.TempDir(), `providers:
  - name: first
    protocol: anthropic
    base_url: https://api.example.com
    model: some-model
    context_window: true
  - name: second
    protocol: anthropic
    base_url: https://api2.example.com
    model: some-model
    max_output_tokens: 200000.5
`)
	cfg, err := LoadConfig(path, LoadOptions{})
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	// Number(true) = 1 — a safe positive integer, so it wins over the default.
	if got := cfg.Providers[0].GetContextWindow(); got != 1 {
		t.Errorf("context_window = %d, want 1 (Number(true))", got)
	}
	// 200000.5 is not a safe integer, so the 128k fallback applies.
	if got := cfg.Providers[1].GetMaxOutputTokens(); got != DefaultMaxOutputTokens {
		t.Errorf("max_output_tokens = %d, want the %d fallback", got, DefaultMaxOutputTokens)
	}
}
