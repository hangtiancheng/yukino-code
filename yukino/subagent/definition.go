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

package subagent

import (
	"fmt"
	"os"
	"strings"

	"github.com/hangtiancheng/yukino-code/yukino/utils"
	"gopkg.in/yaml.v3"
)

// AgentMemoryScope Persistent memory location: per-user, per-project, or per-checkout (not version
// controlled).
type AgentMemoryScope string

const (
	AgentMemoryScopeUser    AgentMemoryScope = "user"
	AgentMemoryScopeProject AgentMemoryScope = "project"
	AgentMemoryScopeLocal   AgentMemoryScope = "local"
)

// IsolationMode encodes the `isolation` frontmatter field.
type IsolationMode string

const (
	IsolationWorktree IsolationMode = "worktree"
	IsolationRemote   IsolationMode = "remote"
)

// AgentDefinition Fields with no runtime usage yet (Effort, Skills, McpServers, Hooks, Memory,
// OmitMarkdown, RequiredMcpServers) are still parsed so user definitions don't lose data on the
// round-trip and so future channels can pick them up without another schema migration.
//
// Frontmatter keys follow the TS reference schema (loader.ts:84-94): snake_case
// for multi-word keys. The legacy camelCase spellings are accepted as a
// fallback (see frontmatterCamelAliases).
type AgentDefinition struct {
	AgentType       string   `yaml:"name"`
	WhenToUse       string   `yaml:"description"`
	Tools           []string `yaml:"tools"`
	DisallowedTools []string `yaml:"disallowed_tools"`
	Model           string   `yaml:"model"`
	MaxTurns        int      `yaml:"max_turns"`

	// PermissionMode overrides the parent agent's permission mode for this sub-agent. Valid values
	// match internal/permissions.PermissionMode.
	PermissionMode string `yaml:"permission_mode"`

	// Effort is a hint to the model about task complexity ("low" | "medium" | "high" | int). Currently
	// stored only, not yet consumed.
	Effort any `yaml:"effort"`

	// Skills are skill names to preload when the sub-agent starts.
	Skills []string `yaml:"skills"`

	// McpServers are MCP server names or inline configs scoped to this agent. Stored as raw any so
	// future loading can interpret either string refs or inline configs.
	McpServers []any `yaml:"mcp_servers"`

	// RequiredMcpServers gates the agent: if listed servers aren't available at load time, the agent
	// is filtered out by hasRequiredMcpServers.
	RequiredMcpServers []string `yaml:"required_mcp_servers"`

	// Hooks are session-scoped hooks registered when this agent starts. Stored as raw YAML; the hooks
	// package will type-check on consumption.
	Hooks any `yaml:"hooks"`

	// Memory enables persistent memory in one of three scopes.
	Memory AgentMemoryScope `yaml:"memory"`

	// Background forces this agent to always run as a background task when spawned, regardless of
	// run_in_background parameter.
	Background bool `yaml:"background"`

	// Isolation selects a file-system isolation mode for the spawn.
	Isolation IsolationMode `yaml:"isolation"`

	// InitialPrompt is the Markdown body of the definition file (TS loader.ts:
	// initialPrompt = body). The legacy initial_prompt frontmatter key is only
	// consulted when the file has no body.
	InitialPrompt string `yaml:"initial_prompt"`

	// OmitMarkdown drops the AGENTS.md hierarchy from this agent's user context. Read-only agents
	// (Explore, Plan) save tokens by skipping it.
	OmitMarkdown bool `yaml:"omit_markdown"`

	// SystemPrompt is the frontmatter system_prompt key (TS systemPromptOverride).
	SystemPrompt string `yaml:"system_prompt"`

	// FilePath / Source / Filename are populated at load time.
	FilePath string `yaml:"-"`
	Source   string `yaml:"-"`
	Filename string `yaml:"-"`
}

// frontmatterCamelAliases maps legacy camelCase frontmatter keys (the old Go
// schema) onto the snake_case keys of the TS reference schema. When both
// spellings are present, snake_case wins.
var frontmatterCamelAliases = map[string]string{
	"disallowedTools":    "disallowed_tools",
	"maxTurns":           "max_turns",
	"systemPrompt":       "system_prompt",
	"permissionMode":     "permission_mode",
	"initialPrompt":      "initial_prompt",
	"omitMarkdown":       "omit_markdown",
	"mcpServers":         "mcp_servers",
	"requiredMcpServers": "required_mcp_servers",
}

// normalizeFrontmatterKeys rewrites legacy camelCase keys onto the snake_case
// names the struct tags expect, so definitions written against either schema
// parse identically.
func normalizeFrontmatterKeys(raw []byte) ([]byte, error) {
	var m map[string]any
	if err := yaml.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	changed := false
	for camel, snake := range frontmatterCamelAliases {
		v, ok := m[camel]
		if !ok {
			continue
		}
		if _, exists := m[snake]; !exists {
			m[snake] = v
		}
		delete(m, camel)
		changed = true
	}
	if !changed {
		return raw, nil
	}
	return yaml.Marshal(m)
}

// firstRunes returns the first n UTF-16 code units of s (TS body.slice(0, 200)
// measures JS string units).
func firstRunes(s string, n int) string {
	return utils.TruncateUTF16(s, n)
}

// validPermissionModes lists the legal values for the permission_mode field in
// an agent definition; the empty string means "no override" — inherit the
// parent agent's mode.
var validPermissionModes = map[string]bool{
	"":                  true,
	"acceptEdits":       true,
	"bypassPermissions": true,
	"default":           true,
	"plan":              true,
}

var validMemoryScopes = map[AgentMemoryScope]bool{
	"":                      true,
	AgentMemoryScopeUser:    true,
	AgentMemoryScopeProject: true,
	AgentMemoryScopeLocal:   true,
}

var validIsolationModes = map[IsolationMode]bool{
	"":                true,
	IsolationWorktree: true,
	IsolationRemote:   true,
}

func ParseAgentFile(path string) (*AgentDefinition, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	content := string(data)
	var def AgentDefinition
	def.FilePath = path

	// TS loader.ts:97-103 — a definition file must start with "---" at offset 0
	// (no leading whitespace) and carry a closing "---"; anything else is not a
	// definition and is skipped silently (parseAgentDefinition returns null).
	if !strings.HasPrefix(content, "---") {
		return nil, nil
	}
	parts := strings.SplitN(content, "---", 3)
	if len(parts) < 3 {
		return nil, nil
	}

	var body string
	frontmatter, err := normalizeFrontmatterKeys([]byte(parts[1]))
	if err != nil {
		return nil, fmt.Errorf("parse frontmatter in %s: %w", path, err)
	}
	if err := yaml.Unmarshal(frontmatter, &def); err != nil {
		return nil, fmt.Errorf("parse frontmatter in %s: %w", path, err)
	}
	body = strings.TrimSpace(parts[2])

	if def.AgentType == "" {
		return nil, fmt.Errorf("agent definition %s: missing required field 'name'", path)
	}

	// TS loader.ts:114 — description is optional and defaults to the first 200
	// characters of the Markdown body.
	if def.WhenToUse == "" {
		def.WhenToUse = firstRunes(body, 200)
	}

	// TS loader.ts:117-122 — the Markdown body is the definition's initialPrompt
	// (a paragraph of the role instructions, see buildSubagentInstructions);
	// systemPromptOverride comes only from the frontmatter system_prompt key.
	// The legacy initial_prompt frontmatter key survives as a fallback for
	// body-less definitions.
	if body != "" {
		def.InitialPrompt = body
	}

	// Normalize and validate `model`. Matches AgentJsonSchema: only "must be a non-empty string" —
	// actual availability is left to the host's ModelResolver / LLM router. Third-party model names
	// like "glm-5.1" must round-trip. Lowercase "inherit" normalizes to "inherit" (the sentinel that
	// means "use parent's client"); everything else stays verbatim so the router can match.
	def.Model = strings.TrimSpace(def.Model)
	if strings.EqualFold(def.Model, "inherit") {
		def.Model = "inherit"
	}

	if !validPermissionModes[def.PermissionMode] {
		return nil, fmt.Errorf("agent definition %s: invalid permissionMode '%s'", path, def.PermissionMode)
	}

	if !validMemoryScopes[def.Memory] {
		return nil, fmt.Errorf("agent definition %s: invalid memory scope '%s'", path, def.Memory)
	}

	if !validIsolationModes[def.Isolation] {
		return nil, fmt.Errorf("agent definition %s: invalid isolation mode '%s'", path, def.Isolation)
	}

	return &def, nil
}

func (d *AgentDefinition) ToSpec() SubAgentSpec {
	return SubAgentSpec{
		Name:                 d.AgentType,
		Description:          d.WhenToUse,
		Tools:                d.Tools,
		DisallowedTools:      d.DisallowedTools,
		SystemPromptOverride: d.SystemPrompt,
		MaxTurns:             d.MaxTurns,
		Model:                d.Model,
		PermissionMode:       d.PermissionMode,
		Background:           d.Background,
		Isolation:            d.Isolation,
		InitialPrompt:        d.InitialPrompt,
		OmitMarkdown:         d.OmitMarkdown,
		Skills:               d.Skills,
		Memory:               d.Memory,
		McpServers:           d.McpServers,
		RequiredMcpServers:   d.RequiredMcpServers,
		Hooks:                d.Hooks,
		Effort:               d.Effort,
	}
}

// HasRequiredMcpServers Returns true when the agent has no MCP requirements or every required
// pattern matches an available server name (case-insensitive substring).
func (d *AgentDefinition) HasRequiredMcpServers(availableServers []string) bool {
	if len(d.RequiredMcpServers) == 0 {
		return true
	}
	for _, pattern := range d.RequiredMcpServers {
		patLower := strings.ToLower(pattern)
		matched := false
		for _, server := range availableServers {
			if strings.Contains(strings.ToLower(server), patLower) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	return true
}
