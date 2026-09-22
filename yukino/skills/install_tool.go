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
	"errors"
	"fmt"
	"net/http"

	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

// InstallSkillTool installs a skill from a local file path or a raw SKILL.md
// URL into the project-level .agents/skills directory, then reloads the
// catalog (TS: InstallSkillTool, install-tool.ts:54-208). skills.sh pages and
// GitHub tree/blob pages are not supported.
//
// The OnInstalled callback is fired after a successful install with the new
// skill's name; the host uses it to re-register the slash command so
// `/<new-skill>` works without a restart.
type InstallSkillTool struct {
	Catalog     *Catalog
	OnInstalled func(name string)
	// WorkDir overrides the catalog's working directory as the installation
	// root (tests). Empty = Catalog.workDir.
	WorkDir string
	// HTTPClient overrides the download client (tests). Empty = default client.
	HTTPClient *http.Client
}

func (t *InstallSkillTool) Name() string { return "InstallSkill" }

func (t *InstallSkillTool) Category() tools.ToolCategory { return tools.CategoryWrite }

func (t *InstallSkillTool) Description() string {
	return "Install a skill from a local file path or an https URL into .agents/skills."
}

func (t *InstallSkillTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"source": map[string]any{
					"type":        "string",
					"description": "Local file path or raw SKILL.md URL (not an HTML or repository page)",
				},
				"name": map[string]any{
					"type":        "string",
					"description": "Optional skill name override; letters, digits, dots, underscores and hyphens",
				},
			},
			"required": []string{"source"},
		},
	}
}

func (t *InstallSkillTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	source, _ := args["source"].(string)
	if source == "" {
		return tools.ToolResult{Output: "Error: source is required", IsError: true}
	}
	nameOverride, _ := args["name"].(string)

	workDir := t.WorkDir
	if workDir == "" && t.Catalog != nil {
		workDir = t.Catalog.workDir
	}
	if workDir == "" {
		return tools.ToolResult{Output: "Error installing skill: no working directory to install into", IsError: true}
	}

	name, err := installSkill(ctx, workDir, source, nameOverride, t.HTTPClient)
	if err != nil {
		var verr *installValidationError
		if errors.As(err, &verr) {
			// TS returns validation failures directly without throwing, so the
			// catch-all log never sees them (install-tool.ts:117-148). Parse
			// failures were already logged inside parseSkillFile.
			return tools.ToolResult{Output: "Error: " + verr.Error(), IsError: true}
		}
		// TS logs every thrown failure before rendering the error result
		// (install-tool.ts:200-206).
		log.Error("skills operation failed", "err", err)
		return tools.ToolResult{Output: fmt.Sprintf("Error installing skill: %v", err), IsError: true}
	}

	// Refresh the catalog so the new skill's frontmatter is indexed and
	// reachable via LoadSkill without a restart (TS: install-tool.ts:194-195).
	if t.Catalog != nil {
		t.Catalog.Reload(workDir)
	}
	if t.OnInstalled != nil {
		t.OnInstalled(name)
	}

	return tools.ToolResult{
		Output: fmt.Sprintf("Skill '%s' installed to .agents/skills/%s/SKILL.md", name, name),
	}
}
