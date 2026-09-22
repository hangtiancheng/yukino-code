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
	"fmt"
	"math"
	"math/big"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/hangtiancheng/yukino-code/yukino/hooks"
	"github.com/hangtiancheng/yukino-code/yukino/logger"
)

var envKeyMap = map[string]string{
	"anthropic":     "ANTHROPIC_API_KEY",
	"openai":        "OPENAI_API_KEY",
	"openai-compat": "OPENAI_API_KEY",
}

var validProtocols = map[string]bool{
	"anthropic":     true,
	"openai":        true,
	"openai-compat": true,
}

type ConfigError struct {
	Message string
}

func (e *ConfigError) Error() string { return e.Message }

type ProviderConfig struct {
	Name     string `yaml:"name"`
	Protocol string `yaml:"protocol"`
	BaseURL  string `yaml:"base_url"`
	Model    string `yaml:"model"`
	APIKey   string `yaml:"api_key"`
	// Thinking is the logical reasoning level (off/minimal/low/medium/high/
	// xhigh/max); empty falls back to DefaultThinkingLevel via GetThinkingLevel.
	Thinking ThinkingLevel `yaml:"thinking"`
	// Reasoning is explicit capability metadata, never inferred from model
	// names. false disables reasoning entirely; nil keeps provider defaults.
	Reasoning *bool `yaml:"reasoning"`
	// ThinkingLevelMap holds partial per-level effort overrides: an absent
	// entry retains the default mapping, a null entry disables the level.
	ThinkingLevelMap map[string]*string `yaml:"thinking_level_map"`
	// ThinkingMode is only used by Anthropic: "budget" (default) or "adaptive".
	ThinkingMode string `yaml:"thinking_mode"`
	// ContextWindow and MaxOutputTokens are float64 because the TS schema
	// declares them z.coerce.number(): quoted numeric strings, booleans and
	// null coerce through JS Number() (see UnmarshalYAML), and the getters
	// apply Number.isSafeInteger semantics before using the value.
	ContextWindow   float64 `yaml:"context_window"`
	MaxOutputTokens float64 `yaml:"max_output_tokens"`
}

// providerConfigYAML shadows ProviderConfig for decoding. The optional
// fields are captured as raw nodes for two reasons: the z.coerce.number()
// fields need JS Number() coercion, and zod's optional-but-not-nullable
// semantics reject an explicit null (an absent key is fine). A zero Node
// (Kind == 0) means the key is absent.
type providerConfigYAML struct {
	Name             string    `yaml:"name"`
	Protocol         string    `yaml:"protocol"`
	BaseURL          string    `yaml:"base_url"`
	Model            string    `yaml:"model"`
	APIKey           yaml.Node `yaml:"api_key"`
	Thinking         yaml.Node `yaml:"thinking"`
	Reasoning        yaml.Node `yaml:"reasoning"`
	ThinkingLevelMap yaml.Node `yaml:"thinking_level_map"`
	ThinkingMode     yaml.Node `yaml:"thinking_mode"`
	ContextWindow    yaml.Node `yaml:"context_window"`
	MaxOutputTokens  yaml.Node `yaml:"max_output_tokens"`
}

// rejectNull mirrors zod's optional fields: `key:` (explicit null) fails the
// entry exactly like z.string().optional() rejecting null, while an absent
// key decodes to the zero value.
func rejectNull(node yaml.Node, field string) error {
	if node.Kind != 0 && node.Tag == "!!null" {
		return fmt.Errorf("%s: Expected a value, received null", field)
	}
	return nil
}

// UnmarshalYAML mirrors the TS ProviderConfigSchema: z.coerce.number()
// coercion for context_window / max_output_tokens (quoted numeric strings,
// booleans and null coerce through JS Number(); NaN rejects the entry) and
// zod's null rejection for every optional field.
func (p *ProviderConfig) UnmarshalYAML(node *yaml.Node) error {
	var shadow providerConfigYAML
	if err := node.Decode(&shadow); err != nil {
		return err
	}
	*p = ProviderConfig{
		Name:     shadow.Name,
		Protocol: shadow.Protocol,
		BaseURL:  shadow.BaseURL,
		Model:    shadow.Model,
	}
	for _, field := range []struct {
		name string
		node yaml.Node
	}{
		{"api_key", shadow.APIKey},
		{"thinking", shadow.Thinking},
		{"reasoning", shadow.Reasoning},
		{"thinking_level_map", shadow.ThinkingLevelMap},
		{"thinking_mode", shadow.ThinkingMode},
	} {
		if err := rejectNull(field.node, field.name); err != nil {
			return err
		}
	}
	if shadow.APIKey.Kind != 0 {
		if err := shadow.APIKey.Decode(&p.APIKey); err != nil {
			return fmt.Errorf("api_key: %w", err)
		}
	}
	if shadow.Thinking.Kind != 0 {
		if err := shadow.Thinking.Decode(&p.Thinking); err != nil {
			return fmt.Errorf("thinking: %w", err)
		}
	}
	if shadow.Reasoning.Kind != 0 {
		if err := shadow.Reasoning.Decode(&p.Reasoning); err != nil {
			return fmt.Errorf("reasoning: %w", err)
		}
	}
	if shadow.ThinkingLevelMap.Kind != 0 {
		if err := shadow.ThinkingLevelMap.Decode(&p.ThinkingLevelMap); err != nil {
			return fmt.Errorf("thinking_level_map: %w", err)
		}
	}
	if shadow.ThinkingMode.Kind != 0 {
		if err := shadow.ThinkingMode.Decode(&p.ThinkingMode); err != nil {
			return fmt.Errorf("thinking_mode: %w", err)
		}
	}
	if shadow.ContextWindow.Kind != 0 {
		v, err := jsCoercedNumber(&shadow.ContextWindow)
		if err != nil {
			return fmt.Errorf("context_window: %w", err)
		}
		p.ContextWindow = v
	}
	if shadow.MaxOutputTokens.Kind != 0 {
		v, err := jsCoercedNumber(&shadow.MaxOutputTokens)
		if err != nil {
			return fmt.Errorf("max_output_tokens: %w", err)
		}
		p.MaxOutputTokens = v
	}
	return nil
}

// jsCoercedNumber applies JS Number() semantics to a YAML scalar. NaN (zod:
// "Expected number, received nan") and non-scalar nodes are rejected.
func jsCoercedNumber(node *yaml.Node) (float64, error) {
	if node.Kind != yaml.ScalarNode {
		return 0, fmt.Errorf("Expected number, received %s", yamlKindName(node))
	}
	switch node.Tag {
	case "!!null":
		return 0, nil
	case "!!bool":
		if node.Value == "true" {
			return 1, nil
		}
		return 0, nil
	case "!!str":
		// js-yaml keeps quoted (and non-resolving) scalars as strings, so
		// z.coerce.number() runs Number(string) — the full StringToNumber
		// grammar including hex/binary/octal literals and "Infinity".
		v, ok := jsStringToNumber(node.Value)
		if !ok {
			return 0, fmt.Errorf("Expected number, received nan")
		}
		return v, nil
	default: // !!int, !!float and any other scalar tag
		// YAML-native numbers (.inf, .nan, exponent forms): js-yaml resolves
		// them to JS numbers before coercion, and Number(number) is identity.
		// ±Infinity passes (Number.isSafeInteger filters it in the getters);
		// NaN is rejected like zod does.
		var v float64
		if err := node.Decode(&v); err != nil || math.IsNaN(v) {
			return 0, fmt.Errorf("Expected number, received nan")
		}
		return v, nil
	}
}

// jsDecimalRe matches ECMA-262's StrUnsignedDecimalLiteral exactly: digits
// with an optional fraction, or a fraction without leading digits, with an
// optional exponent. Go literal extras (underscores, hex float "0x1p4") are
// deliberately not accepted — JS Number() rejects them.
var jsDecimalRe = regexp.MustCompile(`^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

// jsStringToNumber implements Number(string) per ECMA-262 StringToNumber.
// ok=false corresponds to a NaN result. JS quirks reproduced here: only the
// exact spelling "Infinity" (optionally signed) parses as infinity, the
// non-decimal integer literals 0x/0X, 0b/0B, 0o/0O carry no sign
// (Number("-0x10") is NaN), surrounding JS whitespace — including U+FEFF,
// excluding U+0085 — is trimmed, and the empty string is 0.
func jsStringToNumber(s string) (float64, bool) {
	s = strings.TrimFunc(s, isJSWhitespace)
	if s == "" {
		return 0, true
	}
	sign := 1.0
	signed := false
	body := s
	if body[0] == '+' || body[0] == '-' {
		signed = true
		if body[0] == '-' {
			sign = -1
		}
		body = body[1:]
	}
	if body == "" {
		return 0, false
	}
	if body == "Infinity" {
		return sign * math.Inf(1), true
	}
	// NonDecimalIntegerLiteral carries no sign in the grammar: Number("+0x10")
	// and Number("-0x10") are both NaN.
	if !signed && len(body) > 2 && body[0] == '0' {
		base := 0
		switch body[1] {
		case 'x', 'X':
			base = 16
		case 'b', 'B':
			base = 2
		case 'o', 'O':
			base = 8
		}
		if base != 0 {
			// A malformed non-decimal literal ("0x", "0x1.8") is NaN; it must
			// not fall through to the decimal grammar.
			if !isRadixDigits(body[2:], base) {
				return 0, false
			}
			i, ok := new(big.Int).SetString(body[2:], base)
			if !ok {
				return 0, false
			}
			v, _ := new(big.Float).SetInt(i).Float64()
			return v, true
		}
	}
	if !jsDecimalRe.MatchString(body) {
		return 0, false
	}
	v, err := strconv.ParseFloat(body, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return 0, false
	}
	// ErrRange keeps v at ±Inf (overflow) or ±0 (underflow), which is exactly
	// what JS Number() produces ("1e999" → Infinity).
	return sign * v, true
}

// isRadixDigits reports whether s is a non-empty run of digits valid in the
// given base (hex digits are case-insensitive, like JS literals).
func isRadixDigits(s string, base int) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		var v int
		switch {
		case c >= '0' && c <= '9':
			v = int(c - '0')
		case c >= 'a' && c <= 'f':
			v = int(c-'a') + 10
		case c >= 'A' && c <= 'F':
			v = int(c-'A') + 10
		default:
			return false
		}
		if v >= base {
			return false
		}
	}
	return true
}

// isJSWhitespace matches the ECMA-262 WhiteSpace + LineTerminator set: like
// unicode.IsSpace but additionally U+FEFF (ZWNBSP) and without U+0085 (NEL).
func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

func yamlKindName(node *yaml.Node) string {
	switch node.Kind {
	case yaml.MappingNode:
		return "object"
	case yaml.SequenceNode:
		return "array"
	case yaml.AliasNode:
		return "alias"
	default:
		return "unknown"
	}
}

// isJSSafeInteger mirrors Number.isSafeInteger.
func isJSSafeInteger(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) &&
		v == math.Trunc(v) && math.Abs(v) <= 9007199254740991
}

// GetContextWindow mirrors the TS getContextWindow: the configured value wins
// when it is a safe integer and positive, otherwise DefaultContextWindow
// applies. TS never infers context windows from model names or provider
// metadata, and neither does Go.
func (p *ProviderConfig) GetContextWindow() int {
	if isJSSafeInteger(p.ContextWindow) && p.ContextWindow > 0 {
		return int(p.ContextWindow)
	}
	return DefaultContextWindow
}

// GetMaxOutputTokens returns the effective output cap for a provider. The
// configured value wins, otherwise the 128k fallback applies; the result
// never exceeds the context window (TS: getMaxOutputTokens / PI's
// clampMaxTokensToContext). This keeps small-output models from being sent an
// over-large max_tokens while still letting users lower the cap.
func (p *ProviderConfig) GetMaxOutputTokens() int {
	maxOutput := float64(DefaultMaxOutputTokens)
	if isJSSafeInteger(p.MaxOutputTokens) && p.MaxOutputTokens > 0 {
		maxOutput = p.MaxOutputTokens
	}
	if window := float64(p.GetContextWindow()); maxOutput > window {
		return int(window)
	}
	return int(maxOutput)
}

func (p *ProviderConfig) ResolveAPIKey() string {
	if p.APIKey != "" {
		return p.APIKey
	}
	envVar := envKeyMap[p.Protocol]
	if envVar == "" {
		return ""
	}
	return os.Getenv(envVar)
}

type MCPServerConfig struct {
	Name      string            `yaml:"name"`
	Command   string            `yaml:"command"`
	Args      []string          `yaml:"args"`
	URL       string            `yaml:"url"`
	Transport string            `yaml:"transport"`
	Headers   map[string]string `yaml:"headers"`
	Env       map[string]string `yaml:"env"`
}

// SandboxYamlConfig mirrors the TS SandboxYamlConfigSchema: the OS sandbox is
// opt-in, auto-allow additionally skips per-command prompts when the sandbox
// is active, and network_enabled controls outbound access from inside it.
type SandboxYamlConfig struct {
	Enabled        bool   `yaml:"enabled"`
	Backend        string `yaml:"backend"`
	AutoAllow      bool   `yaml:"auto_allow"`
	NetworkEnabled bool   `yaml:"network_enabled"`
}

// BackendOrDefault resolves the configured backend. "native" and empty both
// mean the platform implementation (bwrap/seatbelt); "sandbox-runtime" is the
// TS-only Node binding and has no Go counterpart (see README).
func (s SandboxYamlConfig) BackendOrDefault() string {
	if s.Backend == "" {
		return "native"
	}
	return s.Backend
}

type AppConfig struct {
	Providers             []ProviderConfig  `yaml:"providers"`
	PermissionMode        string            `yaml:"permission_mode"`
	MCPServers            []MCPServerConfig `yaml:"mcp_servers"`
	Hooks                 []hooks.Hook      `yaml:"hooks"`
	EnableCoordinatorMode bool              `yaml:"enable_coordinator_mode"`
	Sandbox               SandboxYamlConfig `yaml:"sandbox"`

	// Concurrent enables the multi-user chat-server mode (Go extension, not
	// in the TS schema): team files live under the session workspace instead
	// of ~/.yukino/teams so concurrent users cannot see each other's teams.
	// Default false keeps the TS single-user location.
	Concurrent bool `yaml:"concurrent"`

	// EnableFork controls whether fork is used when subagent_type is omitted.
	// It is a pointer because it defaults to enabled: a plain bool cannot
	// distinguish "not set in config" from "explicitly set to false", and the
	// latter would otherwise be impossible to turn off.
	EnableFork *bool `yaml:"enable_fork"`
}

// ForkEnabled reports whether fork is available. It defaults to enabled when
// the config does not specify a value.
func (c *AppConfig) ForkEnabled() bool {
	return c.EnableFork == nil || *c.EnableFork
}

// log mirrors the TS module-scoped child logger (createChildLogger({module:"config"})).
var log = logger.CreateChildLogger("config")

// presence structs mirror zod's non-optional keys: a required key that is
// absent or null decodes to a nil pointer and fails the section schema, just
// like TS safeParse rejects it (a decoded Go string cannot tell "" from
// missing, but z.string() rejects null/undefined and accepts "").
type providerPresence struct {
	Name     *string `yaml:"name"`
	Protocol *string `yaml:"protocol"`
	BaseURL  *string `yaml:"base_url"`
	Model    *string `yaml:"model"`
}

type mcpServerPresence struct {
	Name *string `yaml:"name"`
}

type hookActionPresence struct {
	Type *string `yaml:"type"`
}

type hookPresence struct {
	Event  *string             `yaml:"event"`
	Action *hookActionPresence `yaml:"action"`
}

// sectionRejected reports a section node that zod would reject before any
// per-entry decoding: an explicit null (z schemas here are optional but never
// nullable) fails just like a wrong container type does.
func sectionRejected(node *yaml.Node) bool {
	return node == nil || node.Tag == "!!null"
}

// isStringScalar mirrors `typeof value === "string"` / z.string(): only a real
// YAML string scalar passes (null, numbers and booleans do not).
func isStringScalar(node *yaml.Node) bool {
	return node != nil && node.Kind == yaml.ScalarNode && node.Tag == "!!str"
}

// parseProvidersSection mirrors z.array(ProviderConfigSchema): every entry
// must carry the required string keys, a known protocol and valid thinking
// metadata; one bad entry fails the whole section.
func parseProvidersSection(node *yaml.Node) ([]ProviderConfig, error) {
	if sectionRejected(node) {
		return nil, fmt.Errorf("providers must be an array of provider objects")
	}
	var presence []providerPresence
	if err := node.Decode(&presence); err != nil {
		return nil, err
	}
	var providers []ProviderConfig
	if err := node.Decode(&providers); err != nil {
		return nil, err
	}
	for i, p := range providers {
		if i >= len(presence) {
			break
		}
		if presence[i].Name == nil || presence[i].Protocol == nil ||
			presence[i].BaseURL == nil || presence[i].Model == nil {
			return nil, fmt.Errorf("provider #%d: name, protocol, base_url and model are required", i+1)
		}
		if !validProtocols[p.Protocol] {
			return nil, fmt.Errorf("provider #%d: invalid protocol '%s'", i+1, p.Protocol)
		}
		if err := validateThinkingMetadata(i, p); err != nil {
			return nil, err
		}
	}
	return providers, nil
}

// nullKnownField returns the first listed field whose value node is an
// explicit null, or "". zod's optional fields are never nullable, so an
// explicit null fails the entry; z.looseObject strips unknown keys before
// validation, so nulls on keys outside the list must NOT fail it.
func nullKnownField(node *yaml.Node, fields ...string) string {
	if node == nil || node.Kind != yaml.MappingNode {
		return ""
	}
	known := make(map[string]bool, len(fields))
	for _, f := range fields {
		known[f] = true
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if known[node.Content[i].Value] && node.Content[i+1].Tag == "!!null" {
			return node.Content[i].Value
		}
	}
	return ""
}

// seqHasNullValue reports whether the sequence contains an explicit null
// element (z.array(z.string()) rejects null elements).
func seqHasNullValue(node *yaml.Node) bool {
	if node == nil || node.Kind != yaml.SequenceNode {
		return false
	}
	for _, item := range node.Content {
		if item.Tag == "!!null" {
			return true
		}
	}
	return false
}

// mapHasNullValue reports whether the mapping has an explicit null value
// (z.record(z.string(), z.string()) rejects null values).
func mapHasNullValue(node *yaml.Node) bool {
	if node == nil || node.Kind != yaml.MappingNode {
		return false
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i+1].Tag == "!!null" {
			return true
		}
	}
	return false
}

// parseMcpServersSection mirrors z.array(MCPServerConfigSchema): name is the
// only required key, and every schema field rejects an explicit null.
func parseMcpServersSection(node *yaml.Node) ([]MCPServerConfig, error) {
	if sectionRejected(node) {
		return nil, fmt.Errorf("mcp_servers must be an array")
	}
	if node.Kind == yaml.SequenceNode {
		for i, entry := range node.Content {
			if entry.Kind != yaml.MappingNode {
				// null elements decode to zero structs (caught by the name
				// presence check below); non-object scalars error out during
				// decoding. Keep the explicit mapping-node gate for clarity.
				continue
			}
			if field := nullKnownField(entry, "name", "command", "url", "transport", "args", "headers", "env"); field != "" {
				return nil, fmt.Errorf("mcp_servers[%d].%s: Expected a value, received null", i, field)
			}
			fields := mappingFields(entry)
			if seqHasNullValue(fields["args"]) {
				return nil, fmt.Errorf("mcp_servers[%d].args: Expected a value, received null", i)
			}
			for _, m := range []string{"headers", "env"} {
				if mapHasNullValue(fields[m]) {
					return nil, fmt.Errorf("mcp_servers[%d].%s: Expected a value, received null", i, m)
				}
			}
		}
	}
	var presence []mcpServerPresence
	if err := node.Decode(&presence); err != nil {
		return nil, err
	}
	var servers []MCPServerConfig
	if err := node.Decode(&servers); err != nil {
		return nil, err
	}
	for i := range servers {
		if i < len(presence) && presence[i].Name == nil {
			return nil, fmt.Errorf("mcp_servers[%d]: name is required", i)
		}
	}
	return servers, nil
}

// parseHooksSection mirrors z.array(HookConfigSchema): event and action.type
// are required, and every schema field rejects an explicit null. Go-only
// action fields (timeout/headers/body) are not in the TS schema — zod strips
// them before validation, so nulls there must not fail the entry.
func parseHooksSection(node *yaml.Node) ([]hooks.Hook, error) {
	if sectionRejected(node) {
		return nil, fmt.Errorf("hooks must be an array")
	}
	if node.Kind == yaml.SequenceNode {
		for i, entry := range node.Content {
			if entry.Kind != yaml.MappingNode {
				continue
			}
			if field := nullKnownField(entry, "id", "event", "condition", "action", "reject", "once", "async", "on_error"); field != "" {
				return nil, fmt.Errorf("hooks[%d].%s: Expected a value, received null", i, field)
			}
			if action := mappingFields(entry)["action"]; action != nil {
				if field := nullKnownField(action, "type", "command", "url", "method", "prompt"); field != "" {
					return nil, fmt.Errorf("hooks[%d].action.%s: Expected a value, received null", i, field)
				}
			}
		}
	}
	var presence []hookPresence
	if err := node.Decode(&presence); err != nil {
		return nil, err
	}
	var cfgs []hooks.Hook
	if err := node.Decode(&cfgs); err != nil {
		return nil, err
	}
	for i := range cfgs {
		if i >= len(presence) {
			break
		}
		if presence[i].Event == nil || presence[i].Action == nil || presence[i].Action.Type == nil {
			return nil, fmt.Errorf("hooks[%d]: event and action.type are required", i)
		}
	}
	return cfgs, nil
}

// parseSandboxSection mirrors SandboxYamlConfigSchema including the backend
// enum: an unknown spelling must not silently fall back to unsandboxed, and
// every field rejects an explicit null like zod does.
func parseSandboxSection(node *yaml.Node) (SandboxYamlConfig, error) {
	if sectionRejected(node) {
		return SandboxYamlConfig{}, fmt.Errorf("sandbox must be an object")
	}
	if field := nullKnownField(node, "enabled", "backend", "auto_allow", "network_enabled"); field != "" {
		return SandboxYamlConfig{}, fmt.Errorf("sandbox.%s: Expected a value, received null", field)
	}
	var sandbox SandboxYamlConfig
	if err := node.Decode(&sandbox); err != nil {
		return SandboxYamlConfig{}, err
	}
	switch sandbox.Backend {
	case "", "native", "sandbox-runtime":
	default:
		return SandboxYamlConfig{}, fmt.Errorf(
			"backend must be one of native, sandbox-runtime, got '%s'", sandbox.Backend)
	}
	return sandbox, nil
}

// jsTruthy mirrors JS Boolean() coercion, used by the TS fallback path for
// enable_coordinator_mode / enable_fork: bools pass through, numbers are
// truthy when non-zero, strings when non-empty (so "false" is TRUE), null is
// false, and objects/arrays are always true.
func jsTruthy(node *yaml.Node) bool {
	if node == nil || node.Tag == "!!null" {
		return false
	}
	if node.Kind != yaml.ScalarNode {
		return true
	}
	var b bool
	if err := node.Decode(&b); err == nil {
		return b
	}
	var f float64
	if err := node.Decode(&f); err == nil {
		return f != 0
	}
	var s string
	if err := node.Decode(&s); err == nil {
		return s != ""
	}
	return node.Value != ""
}

// mappingFields indexes a mapping node's keys to their value nodes.
func mappingFields(node *yaml.Node) map[string]*yaml.Node {
	fields := make(map[string]*yaml.Node)
	if node == nil || node.Kind != yaml.MappingNode {
		return fields
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		fields[node.Content[i].Value] = node.Content[i+1]
	}
	return fields
}

func applyProviderDefaults(providers []ProviderConfig) []ProviderConfig {
	for i := range providers {
		providers[i] = WithProviderDefaults(providers[i])
	}
	return providers
}

// loadSingleFile mirrors the TS loadSingleFile: try the whole schema first;
// on any schema violation, salvage field by field — providers, mcp_servers
// and sandbox surface targeted ConfigErrors, hooks are silently dropped, and
// the remaining scalars use JS Boolean()/typeof-string coercion.
func loadSingleFile(path string) (*AppConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read config %s: %w", path, err)
	}
	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return nil, &ConfigError{Message: fmt.Sprintf("Failed to parse config %s: %s", path, err)}
	}
	doc := &root
	if root.Kind == yaml.DocumentNode && len(root.Content) > 0 {
		doc = root.Content[0]
	}
	// TS: a valid-YAML non-record (scalar/sequence) logs and yields the empty
	// config rather than throwing.
	if doc.Kind != yaml.MappingNode {
		log.Error("invalid yaml", "path", path)
		return &AppConfig{}, nil
	}

	fields := mappingFields(doc)
	providersNode, hasProviders := fields["providers"]
	mcpNode, hasMcp := fields["mcp_servers"]
	hooksNode, hasHooks := fields["hooks"]
	sandboxNode, hasSandbox := fields["sandbox"]
	permissionModeNode, hasPermissionMode := fields["permission_mode"]
	coordinatorNode, hasCoordinator := fields["enable_coordinator_mode"]
	forkNode, hasFork := fields["enable_fork"]

	// Whole-schema attempt (TS: AppConfigSchema safeParse). providers is
	// required; permission_mode must be a string when present; the two
	// enable_* flags must be real booleans when present.
	var wholeErr error
	var cfg AppConfig
	if decodeErr := doc.Decode(&cfg); decodeErr != nil {
		wholeErr = decodeErr
	}
	if wholeErr == nil && !hasProviders {
		wholeErr = fmt.Errorf("providers is required")
	}
	if wholeErr == nil && hasProviders {
		if _, err := parseProvidersSection(providersNode); err != nil {
			wholeErr = err
		}
	}
	if wholeErr == nil && hasMcp {
		if _, err := parseMcpServersSection(mcpNode); err != nil {
			wholeErr = err
		}
	}
	if wholeErr == nil && hasHooks {
		if _, err := parseHooksSection(hooksNode); err != nil {
			wholeErr = err
		}
	}
	if wholeErr == nil && hasSandbox {
		if _, err := parseSandboxSection(sandboxNode); err != nil {
			wholeErr = err
		}
	}
	if wholeErr == nil && hasPermissionMode && !isStringScalar(permissionModeNode) {
		wholeErr = fmt.Errorf("permission_mode must be a string")
	}
	for _, flag := range []struct {
		name string
		node *yaml.Node
		ok   bool
	}{{"enable_coordinator_mode", coordinatorNode, hasCoordinator}, {"enable_fork", forkNode, hasFork}} {
		if wholeErr != nil || !flag.ok {
			break
		}
		if flag.node.Kind != yaml.ScalarNode || flag.node.Tag != "!!bool" {
			wholeErr = fmt.Errorf("%s must be a boolean", flag.name)
		}
	}
	if wholeErr == nil {
		cfg.Providers = applyProviderDefaults(cfg.Providers)
		return &cfg, nil
	}

	log.Error("config error", "path", path, "error", wholeErr)

	// Field-by-field salvage (TS fallback branch).
	out := &AppConfig{}
	if hasProviders {
		providers, err := parseProvidersSection(providersNode)
		if err != nil {
			// Providers are required for the app to function; surface schema
			// errors instead of silently dropping them.
			return nil, &ConfigError{Message: fmt.Sprintf(
				"Invalid provider configuration in %s: %s", path, err)}
		}
		out.Providers = applyProviderDefaults(providers)
	}
	if hasPermissionMode && isStringScalar(permissionModeNode) {
		out.PermissionMode = permissionModeNode.Value
	}
	if hasMcp {
		servers, err := parseMcpServersSection(mcpNode)
		if err != nil {
			return nil, &ConfigError{Message: fmt.Sprintf(
				"Invalid MCP server configuration in %s: %s", path, err)}
		}
		out.MCPServers = servers
	}
	if hasHooks {
		// TS drops the whole hooks array silently when it fails the schema.
		if parsed, err := parseHooksSection(hooksNode); err == nil {
			out.Hooks = parsed
		}
	}
	if hasSandbox {
		sandbox, err := parseSandboxSection(sandboxNode)
		if err != nil {
			return nil, &ConfigError{Message: fmt.Sprintf(
				"Invalid sandbox configuration in %s: %s", path, err)}
		}
		out.Sandbox = sandbox
	}
	if hasCoordinator {
		out.EnableCoordinatorMode = jsTruthy(coordinatorNode)
	}
	if hasFork {
		enabled := jsTruthy(forkNode)
		out.EnableFork = &enabled
	}
	// Go extension field (absent from the TS schema): salvage it like the
	// other booleans so a partially-invalid config keeps the deployment mode.
	if node, ok := fields["concurrent"]; ok && node.Kind == yaml.ScalarNode && node.Tag == "!!bool" {
		var concurrent bool
		if err := node.Decode(&concurrent); err == nil {
			out.Concurrent = concurrent
		}
	}
	return out, nil
}

func validateProviders(cfg *AppConfig) error {
	if len(cfg.Providers) == 0 {
		return &ConfigError{Message: "At least one provider MUST be configured."}
	}
	requiredFields := []string{"name", "protocol", "base_url", "model"}
	// base_url is the provider identity: two providers sharing one endpoint
	// would make routing and cache attribution ambiguous (TS: validateProviders
	// checks duplicates inside the same per-provider loop).
	baseURLs := make(map[string]int)
	for i, p := range cfg.Providers {
		var missing []string
		values := map[string]string{
			"name":     p.Name,
			"protocol": p.Protocol,
			"base_url": p.BaseURL,
			"model":    p.Model,
		}
		for _, f := range requiredFields {
			if strings.TrimSpace(values[f]) == "" {
				missing = append(missing, f)
			}
		}
		if len(missing) > 0 {
			return &ConfigError{
				Message: fmt.Sprintf("Provider #%d: missing fields: %s", i+1, strings.Join(missing, ", ")),
			}
		}
		if !validProtocols[p.Protocol] {
			return &ConfigError{
				Message: fmt.Sprintf("Provider #%d: invalid protocol '%s', MUST be one of: anthropic, openai, openai-compat", i+1, p.Protocol),
			}
		}
		if err := validateThinkingMetadata(i, p); err != nil {
			return err
		}
		if previous, ok := baseURLs[p.BaseURL]; ok {
			return &ConfigError{Message: fmt.Sprintf(
				"Provider #%d: duplicate base_url '%s' (already used by provider #%d).", i+1, p.BaseURL, previous+1)}
		}
		baseURLs[p.BaseURL] = i
	}
	return nil
}

// GlobalConfigPath returns the single global config file:
// $HOME/.yukino/config.yaml (TS: globalConfigPath).
func GlobalConfigPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", &ConfigError{Message: fmt.Sprintf("Failed to resolve home directory: %s", err)}
	}
	return filepath.Join(home, ".yukino", "config.yaml"), nil
}

// LoadOptions mirrors the TS loadConfig options.
type LoadOptions struct {
	// AllowEmptyProviders accepts a config with no providers (and tolerates a
	// missing global config file by returning an empty config), for entry
	// points that configure providers later.
	AllowEmptyProviders bool
}

// LoadConfig reads the app config. With an explicit path it loads that file;
// otherwise it loads the single global config $HOME/.yukino/config.yaml
// (TS: loadConfig — there is no project-level or layered config).
func LoadConfig(path string, opts LoadOptions) (*AppConfig, error) {
	if path != "" {
		cfg, err := loadSingleFile(path)
		if err != nil {
			return nil, err
		}
		if err := validateMcpServers(cfg); err != nil {
			return nil, err
		}
		if !opts.AllowEmptyProviders || len(cfg.Providers) > 0 {
			if err := validateProviders(cfg); err != nil {
				return nil, err
			}
		}
		return cfg, nil
	}

	candidate, err := GlobalConfigPath()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(candidate); os.IsNotExist(err) {
		if opts.AllowEmptyProviders {
			return &AppConfig{}, nil
		}
		return nil, &ConfigError{Message: fmt.Sprintf("No config file found, expected %s.", candidate)}
	}

	cfg, err := loadSingleFile(candidate)
	if err != nil {
		return nil, err
	}
	if err := validateMcpServers(cfg); err != nil {
		return nil, err
	}
	if !opts.AllowEmptyProviders || len(cfg.Providers) > 0 {
		if err := validateProviders(cfg); err != nil {
			return nil, err
		}
	}
	return cfg, nil
}

// validateMcpServers rejects ambiguous or unusable MCP server entries
// (TS: validateMcpServers): empty or duplicate names, both or neither of
// command/url, and transport values that contradict the entry shape.
func validateMcpServers(cfg *AppConfig) error {
	names := make(map[string]int)
	for i, server := range cfg.MCPServers {
		position := fmt.Sprintf("MCP server #%d", i+1)
		if strings.TrimSpace(server.Name) == "" {
			return &ConfigError{Message: position + ": name must not be empty."}
		}
		if previous, ok := names[server.Name]; ok {
			return &ConfigError{Message: fmt.Sprintf(
				"%s: duplicate name '%s' (already used by MCP server #%d).", position, server.Name, previous+1)}
		}
		names[server.Name] = i

		hasCommand := strings.TrimSpace(server.Command) != ""
		hasURL := strings.TrimSpace(server.URL) != ""
		if hasCommand == hasURL {
			return &ConfigError{Message: fmt.Sprintf(
				"%s '%s': configure exactly one of command or url.", position, server.Name)}
		}
		if hasCommand && server.Transport != "" && server.Transport != "stdio" {
			return &ConfigError{Message: fmt.Sprintf(
				"%s '%s': command servers must use stdio.", position, server.Name)}
		}
		if hasURL && server.Transport != "" && server.Transport != "http" && server.Transport != "sse" {
			return &ConfigError{Message: fmt.Sprintf(
				"%s '%s': URL transport must be http or sse.", position, server.Name)}
		}
	}
	return nil
}
