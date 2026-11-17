package subagent

import (
	"fmt"
	"math"
	"os"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/yukino-js/yukino/yukino/internal/frontmatter"
)

type AgentDefinition struct {
	AgentType       string   `yaml:"name"`
	WhenToUse       string   `yaml:"description"`
	Tools           []string `yaml:"tools"`
	DisallowedTools []string `yaml:"disallowed_tools"`
	SystemPrompt    string   `yaml:"system_prompt"`
	MaxTurns        int      `yaml:"max_turns"`
	Model           string   `yaml:"model"`
	PermissionMode  string   `yaml:"permission_mode"`
	ReadOnly        bool     `yaml:"-"`
	Background      bool     `yaml:"background"`
	Worktree        bool     `yaml:"worktree"`
	InitialPrompt   string   `yaml:"-"`
	Source          string   `yaml:"-"`
	FilePath        string   `yaml:"-"`
}

var validPermissionModes = map[string]bool{"": true, "default": true, "acceptEdits": true, "plan": true, "bypassPermissions": true}

func ParseAgentFile(path string) (*AgentDefinition, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	fm, body, ok := frontmatter.Split(string(data))
	if !ok {
		return nil, fmt.Errorf("agent definition %s: missing frontmatter", path)
	}
	var raw map[string]any
	if err := yaml.Unmarshal([]byte(fm), &raw); err != nil {
		return nil, err
	}
	name, ok := raw["name"].(string)
	if !ok || strings.TrimSpace(name) == "" {
		return nil, fmt.Errorf("agent definition %s: missing required field 'name'", path)
	}
	for _, key := range []string{"description", "system_prompt", "model", "permission_mode"} {
		if value, present := raw[key]; present {
			if _, ok := value.(string); !ok {
				return nil, fmt.Errorf("%s must be a string", key)
			}
		}
	}
	for _, key := range []string{"tools", "disallowed_tools"} {
		if value, present := raw[key]; present {
			values, ok := value.([]any)
			if !ok {
				return nil, fmt.Errorf("%s must be a string array", key)
			}
			for _, v := range values {
				if _, ok := v.(string); !ok {
					return nil, fmt.Errorf("%s must be a string array", key)
				}
			}
		}
	}
	for _, key := range []string{"background", "worktree"} {
		if value, present := raw[key]; present {
			if _, ok := value.(bool); !ok {
				return nil, fmt.Errorf("%s must be a boolean", key)
			}
		}
	}
	if value, present := raw["max_turns"]; present {
		switch n := value.(type) {
		case uint64:
			if n == 0 || n > uint64(^uint(0)>>1) {
				return nil, fmt.Errorf("max_turns must be a positive integer")
			}
		case int:
			if n <= 0 {
				return nil, fmt.Errorf("max_turns must be a positive integer")
			}
		case int64:
			if n <= 0 {
				return nil, fmt.Errorf("max_turns must be a positive integer")
			}
		case float64:
			// YAML parses values like 5.0 as floats; the reference's
			// z.number().int() accepts integral floats, so mirror that.
			if n <= 0 || n != math.Trunc(n) || n > float64(uint64(^uint(0)>>1)) {
				return nil, fmt.Errorf("max_turns must be a positive integer")
			}
		default:
			return nil, fmt.Errorf("max_turns must be a positive integer")
		}
	}
	var def AgentDefinition
	if err := yaml.Unmarshal([]byte(fm), &def); err != nil {
		return nil, err
	}
	def.AgentType = strings.TrimSpace(name)
	if _, present := raw["description"]; !present {
		chars := []rune(body)
		if len(chars) > 200 {
			chars = chars[:200]
		}
		def.WhenToUse = string(chars)
	}
	if !validPermissionModes[def.PermissionMode] {
		return nil, fmt.Errorf("invalid permission_mode '%s'", def.PermissionMode)
	}
	def.InitialPrompt = body
	def.FilePath = path
	return &def, nil
}

func (d *AgentDefinition) ToSpec() SubAgentSpec {
	return SubAgentSpec{Name: d.AgentType, Description: d.WhenToUse, Tools: d.Tools, DisallowedTools: d.DisallowedTools, SystemPromptOverride: d.SystemPrompt, MaxTurns: d.MaxTurns, Model: d.Model, PermissionMode: d.PermissionMode, ReadOnly: d.ReadOnly, Background: d.Background, Worktree: d.Worktree, InitialPrompt: d.InitialPrompt}
}

// specToDefinition inverts ToSpec: the teammate spawn flow resolves a
// SubAgentSpec (possibly the synthesized plan-teammate spec) while
// SpawnSubagent consumes a definition, mirroring the reference's
// options.definition plumbing.
func specToDefinition(spec SubAgentSpec) *AgentDefinition {
	return &AgentDefinition{
		AgentType:       spec.Name,
		WhenToUse:       spec.Description,
		Tools:           spec.Tools,
		DisallowedTools: spec.DisallowedTools,
		SystemPrompt:    spec.SystemPromptOverride,
		MaxTurns:        spec.MaxTurns,
		Model:           spec.Model,
		PermissionMode:  spec.PermissionMode,
		ReadOnly:        spec.ReadOnly,
		Background:      spec.Background,
		Worktree:        spec.Worktree,
		InitialPrompt:   spec.InitialPrompt,
	}
}
