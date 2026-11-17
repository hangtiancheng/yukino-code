package skills

import (
	"context"
	"fmt"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

// LoadSkillTool activates a skill by name. Inline skills return the full SOP
// body so it enters the conversation as a regular message; fork-mode skills
// delegate to a subagent and return only its result.
type LoadSkillTool struct {
	Catalog  *Catalog
	Host     SkillHost
	ForkHost SkillForkHost
}

func (t *LoadSkillTool) Name() string { return "LoadSkill" }

func (t *LoadSkillTool) Description() string { return LoadSkillDescription }

func (t *LoadSkillTool) Category() tools.ToolCategory { return tools.CategoryRead }

func (t *LoadSkillTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"name": map[string]any{"type": "string", "description": LoadSkillNameDescription},
			},
			"required": []string{"name"},
		},
	}
}

func (t *LoadSkillTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	name, _ := args["name"].(string)
	skill := t.Catalog.Get(name)
	if skill == nil {
		names := make([]string, 0, len(t.Catalog.List()))
		for _, meta := range t.Catalog.List() {
			names = append(names, meta.Name)
		}
		available := "(none)"
		if len(names) > 0 {
			available = strings.Join(names, ", ")
		}
		return tools.ToolResult{Output: fmt.Sprintf("Skill '%s' not found. Available skills: %s", name, available), IsError: true}
	}
	if skill.Meta.IsFork() && t.ForkHost != nil {
		result, err := RunFork(ctx, skill, "", t.ForkHost)
		if err != nil {
			return tools.ToolResult{Output: fmt.Sprintf("Skill '%s' fork execution failed: %s", name, utils.AsErrorString(err)), IsError: true}
		}
		return tools.ToolResult{Output: result}
	}
	body := RunInline(skill, "", t.Host)
	return tools.ToolResult{Output: fmt.Sprintf("Skill '%s' activated.\n\n%s", name, body)}
}

type delegatedSkillHost struct{}

func (delegatedSkillHost) ActivateSkill(string, string) {}

func (t *LoadSkillTool) ForDelegatedAgent() tools.Tool {
	return &LoadSkillTool{Catalog: t.Catalog, Host: delegatedSkillHost{}}
}
