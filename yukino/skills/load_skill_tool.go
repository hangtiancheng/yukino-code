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

package skills

import (
	"context"
	"fmt"
	"strings"

	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

// LoadSkillTool is the on-demand activation entry point. It's registered
// into the main tool registry at startup with progressive-disclosure
// semantics: the model sees the <available-skills> listing built by
// BuildSkillSection in the system context, and calls LoadSkill with the
// chosen name. The full execution envelope is returned as the tool result
// so it enters the conversation as a regular message
// (TS: LoadSkillTool, load-skill-tool.ts:38-113).
type LoadSkillTool struct {
	Catalog *Catalog
	Host    SkillHost
	// ForkHost provides the ability to run an isolated sub-agent; skills declaring
	// mode: fork depend on it. When nil (the host has not wired up a sub-agent
	// runtime) it falls back to inline, so the tool works on any host.
	ForkHost SkillForkHost
}

func (t *LoadSkillTool) Name() string { return "LoadSkill" }

func (t *LoadSkillTool) Category() tools.ToolCategory { return tools.CategoryRead }

func (t *LoadSkillTool) Description() string {
	// Verbatim TS text, including the source's double period after
	// "instructions" (byte-parity with load-skill-tool.ts).
	return "Activate a skill by name. Returns the full SOP body so you can follow its " +
		"instructions.. Call this when the user's request matches one of the available " +
		"Skills listed in the available-skills section. Pass the Skill name without a leading slash."
}

func (t *LoadSkillTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"name": map[string]any{
					"type":        "string",
					"description": "Name of the skill to activate",
				},
			},
			"required": []string{"name"},
		},
	}
}

func (t *LoadSkillTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	name, _ := args["name"].(string)
	if t.Catalog == nil || t.Host == nil {
		return tools.ToolResult{Output: "LoadSkill not wired (Catalog or Host nil)", IsError: true}
	}
	// GetFull re-reads the body from disk (hot reload); on read failure with a
	// cached body the skill is still returned, mirroring TS catalog.get().
	skill, _ := t.Catalog.GetFull(name)
	if skill == nil {
		return tools.ToolResult{
			Output:  fmt.Sprintf("Skill '%s' not found. Available skills: %s", name, t.availableNames()),
			IsError: true,
		}
	}

	// Fork mode: the SOP body does not enter the main conversation; it is handed to an
	// isolated sub-agent to execute, and only the final result is brought back. This way
	// the model loading a skill itself and the user invoking a slash command follow the
	// same mode semantics, and the declared isolation intent holds on both paths.
	if skill.Meta.IsFork() && t.ForkHost != nil {
		result, err := RunFork(ctx, skill, "", t.ForkHost)
		if err != nil {
			return tools.ToolResult{
				Output:  fmt.Sprintf("Skill '%s' fork execution failed: %v", name, err),
				IsError: true,
			}
		}
		return tools.ToolResult{Output: result}
	}

	body, err := RunInline(ctx, skill, "", t.Host)
	if err != nil {
		return tools.ToolResult{
			Output:  fmt.Sprintf("Skill '%s' activation failed: %v", name, err),
			IsError: true,
		}
	}
	return tools.ToolResult{Output: fmt.Sprintf("Skill '%s' activated.\n\n%s", name, body)}
}

// availableNames lists every loaded skill name for the not-found message
// (TS: load-skill-tool.ts:78-86). Order is catalog load order, exactly like
// TS list() — no sorting.
func (t *LoadSkillTool) availableNames() string {
	metas := t.Catalog.List()
	if len(metas) == 0 {
		return "(none)"
	}
	names := make([]string, 0, len(metas))
	for _, m := range metas {
		names = append(names, m.Name)
	}
	return strings.Join(names, ", ")
}
