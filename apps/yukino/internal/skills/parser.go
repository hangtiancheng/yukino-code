package skills

import (
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/yukino-js/yukino/yukino/internal/frontmatter"
	"github.com/yukino-js/yukino/yukino/internal/logger"
)

var log = logger.CreateChildLogger("skills")

// ParseSkillFile parses a SKILL.md document. It returns ok=false when the
// frontmatter is missing or invalid.
func ParseSkillFile(content string) (Skill, map[string]any, bool) {
	normalized := strings.TrimPrefix(content, "\uFEFF")
	fm, body, ok := frontmatter.Split(normalized)
	if !ok {
		return Skill{}, nil, false
	}
	var raw map[string]any
	if fm != "" {
		if err := yaml.Unmarshal([]byte(fm), &raw); err != nil {
			log.Error(map[string]any{"err": err}, "skills operation failed")
			return Skill{}, nil, false
		}
	}
	if raw == nil {
		raw = map[string]any{}
	}
	name, isString := raw["name"].(string)
	name = strings.TrimSpace(name)
	if !isString || name == "" {
		return Skill{}, nil, false
	}
	meta := SkillMeta{Name: name}
	if value, present := raw["description"]; present {
		description, ok := value.(string)
		if !ok {
			return Skill{}, nil, false
		}
		meta.Description = description
	}
	if value, present := raw["mode"]; present {
		mode, ok := value.(string)
		if !ok || (mode != "inline" && mode != "fork") {
			return Skill{}, nil, false
		}
	}
	if value, present := raw["model"]; present {
		model, ok := value.(string)
		if !ok {
			return Skill{}, nil, false
		}
		meta.Model = model
	}
	if value, present := raw["fork_context"]; present {
		forkContext, ok := value.(string)
		if !ok {
			return Skill{}, nil, false
		}
		switch forkContext {
		case "full", "none", "recent":
			meta.ForkContext = forkContext
		default:
			return Skill{}, nil, false
		}
	}
	meta.Mode = resolveMode(raw)
	return Skill{Meta: meta, Body: strings.TrimSpace(body)}, raw, true
}

// resolveMode normalizes fork execution: some ecosystems use `context: fork`
// where this project uses `mode: fork`.
func resolveMode(raw map[string]any) string {
	if mode, ok := raw["mode"].(string); ok && (mode == "inline" || mode == "fork") {
		return mode
	}
	if contextValue, ok := raw["context"].(string); ok && contextValue == "fork" {
		return "fork"
	}
	return "inline"
}
