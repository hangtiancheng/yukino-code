package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/yukino-js/yukino/yukino/internal/logger"
	"github.com/yukino-js/yukino/yukino/internal/storage"
)

type ConfigError struct {
	Message string
}

func (e *ConfigError) Error() string { return e.Message }

func ResolveAPIKey(p *ProviderConfig) string {
	if p.APIKey != "" {
		return p.APIKey
	}
	envVar := EnvKeyMap[p.Protocol]
	if envVar == "" {
		return ""
	}
	return os.Getenv(envVar)
}

type MCPServerConfig struct {
	Name      string
	Enabled   *bool
	Command   string
	Args      []string
	URL       string
	Transport string
	Headers   map[string]string
	Env       map[string]string
}

type HookActionConfig struct {
	Type    string
	Command string
	URL     string
	Method  string
	Prompt  string
}

type HookConfig struct {
	ID        string
	Event     string
	Condition string
	Action    HookActionConfig
	Reject    bool
	Once      bool
	Async     bool
	OnError   string
}

type SandboxYamlConfig struct {
	Enabled        *bool
	AutoAllow      *bool
	NetworkEnabled *bool
}

// SandboxEnabled mirrors config?.enabled ?? false.
func (c *SandboxYamlConfig) SandboxEnabled() bool {
	return c != nil && c.Enabled != nil && *c.Enabled
}

// SandboxAutoAllow mirrors config?.auto_allow ?? false.
func (c *SandboxYamlConfig) SandboxAutoAllow() bool {
	return c != nil && c.AutoAllow != nil && *c.AutoAllow
}

// SandboxNetworkEnabled mirrors config?.network_enabled ?? true.
func (c *SandboxYamlConfig) SandboxNetworkEnabled() bool {
	return c == nil || c.NetworkEnabled == nil || *c.NetworkEnabled
}

type AppConfig struct {
	DefaultProvider       int
	Providers             []ProviderConfig
	PermissionMode        string
	MCPLoading            string
	Theme                 string
	MCPServers            []MCPServerConfig
	Hooks                 []HookConfig
	Sandbox               *SandboxYamlConfig
	EnableCoordinatorMode bool
	// Whether auto memory is enabled: gates index injection, recall, and
	// background extraction, plus consolidation. Defaults to enabled;
	// `enable_memory: false` turns the whole automatic memory pipeline off.
	// Left a pointer so "not set" and "explicitly false" stay distinguishable.
	EnableMemory *bool
	// Environment defaults applied only to unset variables.
	Env map[string]string
}

func (c *AppConfig) MemoryEnabled() bool { return c.EnableMemory == nil || *c.EnableMemory }

// ApplyConfigEnv fills only variables that are unset in the real environment —
// explicit environment always wins. Idempotent: repeated config loads never
// clobber anything.
func ApplyConfigEnv(env map[string]string) {
	for key, value := range env {
		if _, exists := os.LookupEnv(key); !exists {
			os.Setenv(key, value)
		}
	}
}

// HydrateConfigEnv fills the process environment from the global config's env
// block before anything reads it. Tolerant by design: a missing or broken
// config is reported by the real LoadConfig call later; hydration must never
// block startup.
func HydrateConfigEnv() {
	_, _ = LoadConfig("", LoadOptions{AllowEmptyProviders: true})
}

// yamlLineRE extracts the position from yaml.v3 messages such as
// "line 3: mapping values are not allowed in this context" and from the
// per-error lines of its unmarshal TypeErrors.
var yamlLineRE = regexp.MustCompile(`line (\d+): ?`)

// yamlErrorDetail reports a parse failure as reason + line only, keeping the
// message shape stable and free of raw parser internals.
func yamlErrorDetail(err error) string {
	message := strings.TrimPrefix(err.Error(), "yaml: ")
	if loc := yamlLineRE.FindStringSubmatchIndex(message); loc != nil {
		reason := strings.TrimSpace(message[loc[1]:])
		if newline := strings.IndexByte(reason, '\n'); newline >= 0 {
			reason = strings.TrimSpace(reason[:newline])
		}
		if reason == "" {
			reason = YAMLParseError
		}
		return fmt.Sprintf("%s (line %s)", reason, message[loc[2]:loc[3]])
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return YAMLParseError
	}
	return message
}

func loadSingleFile(path string) (*AppConfig, error) {
	data, err := storage.ReadPrivateFileSync(path)
	if err != nil {
		return nil, err
	}
	var raw map[string]any
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, &ConfigError{Message: fmt.Sprintf("Invalid YAML in %s: %s", path, yamlErrorDetail(err))}
	}
	cfg, err := parseAppConfig(raw)
	if err != nil {
		return nil, &ConfigError{Message: fmt.Sprintf("Invalid configuration in %s: %s", path, err)}
	}
	// Hydrate before LoadConfig's validation below, so the defaults apply even
	// when the real load later reports a provider/MCP validation error.
	ApplyConfigEnv(cfg.Env)
	for i := range cfg.Providers {
		cfg.Providers[i] = WithProviderDefaults(cfg.Providers[i])
	}
	return cfg, nil
}

var validPermissionModes = map[string]bool{
	"default": true, "acceptEdits": true, "plan": true, "bypassPermissions": true,
}

func parseAppConfig(raw map[string]any) (*AppConfig, error) {
	cfg := &AppConfig{MCPLoading: "auto", Theme: "auto"}
	for key, value := range raw {
		switch key {
		case "default_provider":
			n, err := asNumber(value)
			if err != nil {
				return nil, fmt.Errorf("default_provider: %w", err)
			}
			cfg.DefaultProvider = int(n)
		case "providers":
			list, ok := value.([]any)
			if !ok {
				return nil, fmt.Errorf("providers: expected a list, got %T", value)
			}
			for i, item := range list {
				rec, ok := item.(map[string]any)
				if !ok {
					return nil, fmt.Errorf("providers[%d]: expected a mapping, got %T", i, item)
				}
				p, err := parseProviderConfig(rec)
				if err != nil {
					return nil, fmt.Errorf("providers[%d]: %w", i, err)
				}
				cfg.Providers = append(cfg.Providers, p)
			}
		case "permission_mode":
			mode, err := asString(value)
			if err != nil || !validPermissionModes[mode] {
				return nil, fmt.Errorf("permission_mode: invalid enum value '%v'", value)
			}
			cfg.PermissionMode = mode
		case "mcp_loading":
			mode, err := asString(value)
			if err != nil || !contains(MCPLoadingModes, mode) {
				return nil, fmt.Errorf("mcp_loading: invalid enum value '%v'", value)
			}
			cfg.MCPLoading = mode
		case "theme":
			mode, err := asString(value)
			if err != nil || !contains(ThemeModes, mode) {
				return nil, fmt.Errorf("theme: invalid enum value '%v'", value)
			}
			cfg.Theme = mode
		case "mcp_servers":
			list, ok := value.([]any)
			if !ok {
				return nil, fmt.Errorf("mcp_servers: expected a list, got %T", value)
			}
			for i, item := range list {
				rec, ok := item.(map[string]any)
				if !ok {
					return nil, fmt.Errorf("mcp_servers[%d]: expected a mapping, got %T", i, item)
				}
				server, err := parseMCPServerConfig(rec)
				if err != nil {
					return nil, fmt.Errorf("mcp_servers[%d]: %w", i, err)
				}
				cfg.MCPServers = append(cfg.MCPServers, server)
			}
		case "hooks":
			list, ok := value.([]any)
			if !ok {
				return nil, fmt.Errorf("hooks: expected a list, got %T", value)
			}
			for i, item := range list {
				rec, ok := item.(map[string]any)
				if !ok {
					return nil, fmt.Errorf("hooks[%d]: expected a mapping, got %T", i, item)
				}
				hook, err := parseHookConfig(rec)
				if err != nil {
					return nil, fmt.Errorf("hooks[%d]: %w", i, err)
				}
				cfg.Hooks = append(cfg.Hooks, hook)
			}
		case "sandbox":
			rec, ok := value.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("sandbox: expected a mapping, got %T", value)
			}
			sandbox, err := parseSandboxConfig(rec)
			if err != nil {
				return nil, fmt.Errorf("sandbox: %w", err)
			}
			cfg.Sandbox = &sandbox
		case "enable_coordinator_mode":
			b, err := asBool(value)
			if err != nil {
				return nil, fmt.Errorf("enable_coordinator_mode: %w", err)
			}
			cfg.EnableCoordinatorMode = b
		case "enable_memory":
			b, err := asBool(value)
			if err != nil {
				return nil, fmt.Errorf("enable_memory: %w", err)
			}
			cfg.EnableMemory = &b
		case "env":
			env, err := parseEnvBlock(value)
			if err != nil {
				return nil, err
			}
			cfg.Env = env
		}
	}
	return cfg, nil
}

func parseMCPServerConfig(raw map[string]any) (MCPServerConfig, error) {
	var server MCPServerConfig
	name, err := requireString(raw, "name")
	if err != nil {
		return server, err
	}
	server.Name = name
	if v, ok, err := optionalValue(raw, "enabled"); err != nil {
		return server, err
	} else if ok {
		enabled, err := asBool(v)
		if err != nil {
			return server, fmt.Errorf("enabled: %w", err)
		}
		server.Enabled = &enabled
	}
	for field, target := range map[string]*string{"command": &server.Command, "url": &server.URL, "transport": &server.Transport} {
		v, ok, err := optionalValue(raw, field)
		if err != nil {
			return server, err
		}
		if ok {
			s, err := asString(v)
			if err != nil {
				return server, fmt.Errorf("%s: expected a string, got %T", field, v)
			}
			*target = s
		}
	}
	if v, ok, err := optionalValue(raw, "args"); err != nil {
		return server, err
	} else if ok {
		args, err := asStringList(v)
		if err != nil {
			return server, fmt.Errorf("args: %w", err)
		}
		server.Args = args
	}
	for field, target := range map[string]*map[string]string{"headers": &server.Headers, "env": &server.Env} {
		v, ok, err := optionalValue(raw, field)
		if err != nil {
			return server, err
		}
		if ok {
			m, err := asStringMap(v)
			if err != nil {
				return server, fmt.Errorf("%s: %w", field, err)
			}
			*target = m
		}
	}
	return server, nil
}

func parseSandboxConfig(raw map[string]any) (SandboxYamlConfig, error) {
	var sandbox SandboxYamlConfig
	for field, target := range map[string]**bool{"enabled": &sandbox.Enabled, "auto_allow": &sandbox.AutoAllow, "network_enabled": &sandbox.NetworkEnabled} {
		v, ok, err := optionalValue(raw, field)
		if err != nil {
			return sandbox, err
		}
		if ok {
			b, err := asBool(v)
			if err != nil {
				return sandbox, fmt.Errorf("%s: %w", field, err)
			}
			*target = &b
		}
	}
	return sandbox, nil
}

func parseHookConfig(raw map[string]any) (HookConfig, error) {
	var hook HookConfig
	event, err := requireString(raw, "event")
	if err != nil {
		return hook, err
	}
	hook.Event = event
	if v, ok, err := optionalValue(raw, "id"); err != nil {
		return hook, err
	} else if ok {
		if hook.ID, err = asString(v); err != nil {
			return hook, fmt.Errorf("id: expected a string, got %T", v)
		}
	}
	if v, ok, err := optionalValue(raw, "condition"); err != nil {
		return hook, err
	} else if ok {
		if hook.Condition, err = asString(v); err != nil {
			return hook, fmt.Errorf("condition: expected a string, got %T", v)
		}
	}
	actionRaw, ok := raw["action"]
	if !ok || actionRaw == nil {
		return hook, fmt.Errorf("action: required")
	}
	actionRec, ok := actionRaw.(map[string]any)
	if !ok {
		return hook, fmt.Errorf("action: expected a mapping, got %T", actionRaw)
	}
	actionType, err := requireString(actionRec, "type")
	if err != nil {
		return hook, fmt.Errorf("action: %w", err)
	}
	hook.Action.Type = actionType
	for field, target := range map[string]*string{
		"command": &hook.Action.Command, "url": &hook.Action.URL,
		"method": &hook.Action.Method, "prompt": &hook.Action.Prompt,
	} {
		v, ok, err := optionalValue(actionRec, field)
		if err != nil {
			return hook, fmt.Errorf("action: %w", err)
		}
		if ok {
			s, err := asString(v)
			if err != nil {
				return hook, fmt.Errorf("action.%s: expected a string, got %T", field, v)
			}
			*target = s
		}
	}
	for field, target := range map[string]*bool{"reject": &hook.Reject, "once": &hook.Once, "async": &hook.Async} {
		v, ok, err := optionalValue(raw, field)
		if err != nil {
			return hook, err
		}
		if ok {
			b, err := asBool(v)
			if err != nil {
				return hook, fmt.Errorf("%s: %w", field, err)
			}
			*target = b
		}
	}
	if v, ok, err := optionalValue(raw, "on_error"); err != nil {
		return hook, err
	} else if ok {
		if hook.OnError, err = asString(v); err != nil {
			return hook, fmt.Errorf("on_error: expected a string, got %T", v)
		}
	}
	return hook, nil
}

// parseEnvBlock accepts a plain mapping (env: {KEY: value}) or a list of
// single-key mappings. Scalars are stringified for the process environment;
// an empty value (KEY:) becomes "".
func parseEnvBlock(value any) (map[string]string, error) {
	if value == nil {
		return map[string]string{}, nil
	}
	merged := map[string]string{}
	addEntry := func(k string, v any) error {
		s, err := envValueString(v)
		if err != nil {
			return fmt.Errorf("env: '%s': %w", k, err)
		}
		merged[k] = s
		return nil
	}
	switch block := value.(type) {
	case map[string]any:
		for k, v := range block {
			if err := addEntry(k, v); err != nil {
				return nil, err
			}
		}
	case []any:
		for _, item := range block {
			entry, ok := item.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("env: list entries must be single-key mappings")
			}
			for k, v := range entry {
				if err := addEntry(k, v); err != nil {
					return nil, err
				}
			}
		}
	default:
		return nil, fmt.Errorf("env: expected a mapping or a list of mappings, got %T", value)
	}
	return merged, nil
}

func envValueString(v any) (string, error) {
	switch t := v.(type) {
	case nil:
		return "", nil
	case string:
		return t, nil
	case bool:
		return strconv.FormatBool(t), nil
	case int:
		return strconv.Itoa(t), nil
	case int64:
		return strconv.FormatInt(t, 10), nil
	case uint64:
		return strconv.FormatUint(t, 10), nil
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64), nil
	default:
		return "", fmt.Errorf("expected a scalar value, got %T", v)
	}
}

func validateProviders(cfg *AppConfig) error {
	if len(cfg.Providers) == 0 {
		return &ConfigError{Message: NoProvidersError}
	}
	baseURLs := map[string]int{}
	for i, p := range cfg.Providers {
		values := map[string]string{
			"name": p.Name, "protocol": p.Protocol, "base_url": p.BaseURL, "model": p.Model,
		}
		var missing []string
		for _, field := range []string{"name", "protocol", "base_url", "model"} {
			if strings.TrimSpace(values[field]) == "" {
				missing = append(missing, field)
			}
		}
		if len(missing) > 0 {
			return &ConfigError{Message: fmt.Sprintf("Provider #%d: missing fields: %s", i+1, strings.Join(missing, ", "))}
		}
		if previous, dup := baseURLs[p.BaseURL]; dup {
			return &ConfigError{Message: fmt.Sprintf(
				"Provider #%d: duplicate base_url '%s' (already used by provider #%d).",
				i+1, p.BaseURL, previous+1,
			)}
		}
		baseURLs[p.BaseURL] = i
	}
	return nil
}

func validateMcpServers(cfg *AppConfig) error {
	names := map[string]int{}
	for i, server := range cfg.MCPServers {
		position := fmt.Sprintf("MCP server #%d", i+1)
		if strings.TrimSpace(server.Name) == "" {
			return &ConfigError{Message: position + ": name must not be empty."}
		}
		if previous, dup := names[server.Name]; dup {
			return &ConfigError{Message: fmt.Sprintf(
				"%s: duplicate name '%s' (already used by MCP server #%d).", position, server.Name, previous+1,
			)}
		}
		names[server.Name] = i
		hasCommand := strings.TrimSpace(server.Command) != ""
		hasURL := strings.TrimSpace(server.URL) != ""
		if hasCommand == hasURL {
			return &ConfigError{Message: fmt.Sprintf("%s '%s': configure exactly one of command or url.", position, server.Name)}
		}
		if hasCommand && server.Transport != "" && server.Transport != "stdio" {
			return &ConfigError{Message: fmt.Sprintf("%s '%s': command servers must use stdio.", position, server.Name)}
		}
		if hasURL && server.Transport != "" && server.Transport != "http" && server.Transport != "sse" {
			return &ConfigError{Message: fmt.Sprintf("%s '%s': URL transport must be http or sse.", position, server.Name)}
		}
	}
	return nil
}

type mcpJSONEntry struct {
	Enabled *bool             `json:"enabled"`
	Command *string           `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
	Type    string            `json:"type"`
	URL     *string           `json:"url"`
	Headers map[string]string `json:"headers"`
}

// mcpServerFromJSONEntry maps one .mcp.json entry onto an MCPServerConfig. An
// explicit type wins; otherwise stdio is inferred from command and http from
// url. Entries that lack the field their transport needs are rejected.
func mcpServerFromJSONEntry(name string, entry mcpJSONEntry) (MCPServerConfig, bool) {
	transport := entry.Type
	if transport == "" {
		if entry.Command != nil {
			transport = "stdio"
		} else {
			transport = "http"
		}
	}
	if transport == "stdio" {
		if entry.Command == nil || *entry.Command == "" || entry.URL != nil {
			return MCPServerConfig{}, false
		}
		return MCPServerConfig{Name: name, Command: *entry.Command, Args: entry.Args, Env: entry.Env}, true
	}
	if entry.URL == nil || *entry.URL == "" || entry.Command != nil {
		return MCPServerConfig{}, false
	}
	return MCPServerConfig{Name: name, URL: *entry.URL, Transport: transport, Headers: entry.Headers}, true
}

// mcpServersInOrder returns the mcpServers object keys in document order with
// their raw entries, so one pass over the file keeps insertion order.
func mcpServersInOrder(data []byte) ([]string, map[string]json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	tok, err := dec.Token()
	if err != nil {
		return nil, nil, err
	}
	delim, ok := tok.(json.Delim)
	if !ok || delim != '{' {
		return nil, nil, fmt.Errorf("expected a JSON object")
	}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, nil, err
		}
		key, _ := keyTok.(string)
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, nil, err
		}
		if key != "mcpServers" {
			continue
		}
		var servers map[string]json.RawMessage
		if err := json.Unmarshal(value, &servers); err != nil {
			return nil, nil, err
		}
		names, err := objectKeyOrder(value)
		if err != nil {
			return nil, nil, err
		}
		return names, servers, nil
	}
	return nil, nil, nil
}

func objectKeyOrder(raw json.RawMessage) ([]string, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '{' {
		return nil, fmt.Errorf("expected a JSON object")
	}
	var keys []string
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		keys = append(keys, keyTok.(string))
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return nil, err
		}
	}
	return keys, nil
}

// LoadProjectMcpServers reads project-level MCP servers from <cwd>/.mcp.json.
// A missing file yields nil silently and a malformed one yields nil with a log
// entry, so a broken repo-side config does not prevent startup, and an entry
// that cannot be mapped is skipped so one bad server does not hide its
// siblings.
var configLog = logger.CreateChildLogger("config")

func LoadProjectMcpServers(cwd string) []MCPServerConfig {
	path := filepath.Join(cwd, ProjectMCPFilename)
	if _, err := os.Stat(path); err != nil {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		configLog.Error(map[string]any{"err": err, "path": path}, "invalid .mcp.json")
		return nil
	}
	names, entries, err := mcpServersInOrder(data)
	if err != nil {
		configLog.Error(map[string]any{"error": err, "path": path}, "invalid .mcp.json")
		return nil
	}
	var servers []MCPServerConfig
	for _, name := range names {
		if strings.TrimSpace(name) == "" {
			configLog.Warn(map[string]any{"name": name, "path": path}, "skipping invalid .mcp.json server entry")
			continue
		}
		var entry mcpJSONEntry
		if err := json.Unmarshal(entries[name], &entry); err != nil {
			configLog.Warn(map[string]any{"name": name, "path": path, "error": err}, "skipping invalid .mcp.json server entry")
			continue
		}
		if entry.Type != "" && entry.Type != "stdio" && entry.Type != "sse" && entry.Type != "http" {
			configLog.Warn(map[string]any{"name": name, "path": path}, "skipping invalid .mcp.json server entry")
			continue
		}
		if entry.Enabled != nil && !*entry.Enabled {
			continue
		}
		if server, ok := mcpServerFromJSONEntry(name, entry); ok {
			servers = append(servers, server)
		} else {
			configLog.Warn(map[string]any{"name": name, "path": path}, "skipping invalid .mcp.json server entry")
		}
	}
	return servers
}

// WithProjectMcpServers returns a copy of cfg with the servers from
// <cwd>/.mcp.json appended. User-level (config.yaml) entries win on a name
// collision: the project file ships with the repository and is less trusted
// than the user's own config.
func WithProjectMcpServers(cfg *AppConfig, cwd string) *AppConfig {
	projectServers := LoadProjectMcpServers(cwd)
	if len(projectServers) == 0 {
		return cfg
	}
	known := map[string]bool{}
	for _, s := range cfg.MCPServers {
		known[s.Name] = true
	}
	out := *cfg
	merged := make([]MCPServerConfig, len(cfg.MCPServers), len(cfg.MCPServers)+len(projectServers))
	copy(merged, cfg.MCPServers)
	for _, s := range projectServers {
		if !known[s.Name] {
			merged = append(merged, s)
		}
	}
	out.MCPServers = merged
	return &out
}

type LoadOptions struct {
	AllowEmptyProviders bool
}

func LoadConfig(path string, options LoadOptions) (*AppConfig, error) {
	load := func(path string) (*AppConfig, error) {
		cfg, err := loadSingleFile(path)
		if err != nil {
			return nil, err
		}
		if err := validateMcpServers(cfg); err != nil {
			return nil, err
		}
		if !options.AllowEmptyProviders || len(cfg.Providers) > 0 {
			if err := validateProviders(cfg); err != nil {
				return nil, err
			}
		}
		return cfg, nil
	}

	if path != "" {
		return load(path)
	}

	candidate := GlobalConfigPath()
	if _, err := os.Stat(candidate); err != nil {
		if os.IsNotExist(err) {
			if options.AllowEmptyProviders {
				return &AppConfig{MCPLoading: "auto", Theme: "auto"}, nil
			}
			return nil, &ConfigError{Message: fmt.Sprintf("No config file found, expected %s.", candidate)}
		}
		return nil, err
	}
	return load(candidate)
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

func requireString(raw map[string]any, key string) (string, error) {
	v, ok := raw[key]
	if !ok || v == nil {
		return "", fmt.Errorf("%s: required", key)
	}
	s, err := asString(v)
	if err != nil {
		return "", fmt.Errorf("%s: expected a string, got %T", key, v)
	}
	return s, nil
}

// optionalValue mirrors zod's .optional(): an absent key is fine, an explicit
// null is rejected.
func optionalValue(raw map[string]any, key string) (any, bool, error) {
	v, ok := raw[key]
	if !ok {
		return nil, false, nil
	}
	if v == nil {
		return nil, false, fmt.Errorf("%s: unexpected null", key)
	}
	return v, true, nil
}

func asString(v any) (string, error) {
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("expected a string, got %T", v)
	}
	return s, nil
}

func asBool(v any) (bool, error) {
	b, ok := v.(bool)
	if !ok {
		return false, fmt.Errorf("expected a boolean, got %T", v)
	}
	return b, nil
}

func asNumber(v any) (float64, error) {
	switch n := v.(type) {
	case int:
		return float64(n), nil
	case int64:
		return float64(n), nil
	case uint64:
		return float64(n), nil
	case float64:
		return n, nil
	case float32:
		return float64(n), nil
	default:
		return 0, fmt.Errorf("expected a number, got %T", v)
	}
}

// asCoercedNumber mirrors z.coerce.number().
func asCoercedNumber(v any) (float64, error) {
	if n, err := asNumber(v); err == nil {
		return n, nil
	}
	switch t := v.(type) {
	case string:
		if strings.TrimSpace(t) == "" {
			return 0, nil
		}
		if f, err := strconv.ParseFloat(strings.TrimSpace(t), 64); err == nil {
			return f, nil
		}
	case bool:
		if t {
			return 1, nil
		}
		return 0, nil
	}
	return 0, fmt.Errorf("cannot coerce %T to a number", v)
}

func asStringList(v any) ([]string, error) {
	list, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("expected a list, got %T", v)
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		s, err := asString(item)
		if err != nil {
			return nil, fmt.Errorf("expected a string, got %T", item)
		}
		out = append(out, s)
	}
	return out, nil
}

func asStringMap(v any) (map[string]string, error) {
	rec, ok := v.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("expected a mapping, got %T", v)
	}
	out := make(map[string]string, len(rec))
	for k, item := range rec {
		s, err := asString(item)
		if err != nil {
			return nil, fmt.Errorf("'%s': expected a string, got %T", k, item)
		}
		out[k] = s
	}
	return out, nil
}
