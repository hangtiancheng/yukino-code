package skills

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"gopkg.in/yaml.v3"

	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

// InstallSkillTool installs a skill from a local file path or an http(s) URL
// into ~/.yukino/skills/<name>/SKILL.md, then reloads the catalog.
type InstallSkillTool struct {
	Cwd         string
	Catalog     *Catalog
	OnInstalled func()
	Network     utils.PublicHttpDependencies
}

func (t *InstallSkillTool) Name() string { return "InstallSkill" }

func (t *InstallSkillTool) Description() string { return InstallSkillDescription }

func (t *InstallSkillTool) Category() tools.ToolCategory { return tools.CategoryWrite }

func (t *InstallSkillTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"source": map[string]any{"type": "string", "description": InstallSkillSourceDescription},
				"name":   map[string]any{"type": "string", "description": InstallSkillNameDescription},
			},
			"required": []string{"source"},
		},
	}
}

func (t *InstallSkillTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	source, _ := args["source"].(string)
	if source == "" {
		return tools.ToolResult{Output: SourceRequiredError, IsError: true}
	}
	content, toolErr := t.readSource(ctx, source)
	if toolErr != nil {
		return *toolErr
	}
	parsed, frontmatter, ok := ParseSkillFile(content)
	if !ok {
		return tools.ToolResult{Output: InvalidSkillSourceError, IsError: true}
	}
	name, _ := args["name"].(string)
	if name == "" {
		name = parsed.Meta.Name
	}
	if !SkillNameRe.MatchString(name) || strings.HasSuffix(name, ".") {
		return tools.ToolResult{Output: InvalidSkillNameError, IsError: true}
	}
	if name != parsed.Meta.Name {
		frontmatter["name"] = name
		serialized, err := yaml.Marshal(frontmatter)
		if err != nil {
			return tools.ToolResult{Output: "Error installing skill: " + utils.AsErrorString(err), IsError: true}
		}
		content = "---\n" + string(serialized) + "---\n\n" + parsed.Body + "\n"
	}
	if err := ctx.Err(); err != nil {
		return tools.ToolResult{Output: "Error installing skill: " + utils.AsErrorString(err), IsError: true}
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return tools.ToolResult{Output: "Error installing skill: " + utils.AsErrorString(err), IsError: true}
	}
	dir, err := filepath.EvalSymlinks(home)
	if err != nil {
		return tools.ToolResult{Output: "Error installing skill: " + utils.AsErrorString(err), IsError: true}
	}
	for _, segment := range []string{storage.YukinoDirName, SkillsDirName, name} {
		dir = filepath.Join(dir, segment)
		info, statErr := os.Lstat(dir)
		if statErr == nil {
			if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
				return installError(fmt.Errorf("Installation directory must be a real directory: %s", dir))
			}
			continue
		}
		if !os.IsNotExist(statErr) {
			return installError(statErr)
		}
		if err := os.Mkdir(dir, 0o777); err != nil {
			return installError(err)
		}
	}
	destination := filepath.Join(dir, SkillFileName)
	mode := os.FileMode(0o666)
	if info, statErr := os.Lstat(destination); statErr == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return installError(fmt.Errorf("Installation target must be a regular file: %s", destination))
		}
		mode = info.Mode().Perm()
	}

	// Replace only this directory entry, never truncating a hard-linked file
	// outside the workspace.
	temporary := filepath.Join(dir, ".SKILL-"+uuid.NewString()+".tmp")
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return installError(err)
	}
	if _, err := file.WriteString(content); err != nil {
		file.Close()
		os.Remove(temporary)
		return installError(err)
	}
	if err := file.Close(); err != nil {
		os.Remove(temporary)
		return installError(err)
	}
	defer os.Remove(temporary)
	if err := os.Rename(temporary, destination); err != nil {
		return installError(err)
	}

	t.Catalog.Load(t.Cwd)
	if t.OnInstalled != nil {
		t.OnInstalled()
	}
	return tools.ToolResult{Output: fmt.Sprintf("Skill '%s' installed to %s", name, destination)}
}

func (t *InstallSkillTool) readSource(ctx context.Context, source string) (string, *tools.ToolResult) {
	if !strings.HasPrefix(strings.ToLower(source), "http://") && !strings.HasPrefix(strings.ToLower(source), "https://") {
		data, err := os.ReadFile(filepath.Join(t.Cwd, source))
		if err != nil {
			return "", &tools.ToolResult{Output: "Error installing skill: " + utils.AsErrorString(err), IsError: true}
		}
		return string(data), nil
	}

	timeoutCtx, cancel := context.WithTimeout(ctx, SkillDownloadTimeoutMS*time.Millisecond)
	defer cancel()
	response, err := utils.FetchPublicHttpUrl(timeoutCtx, source, "GET", nil, t.Network)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return "", &tools.ToolResult{Output: "Error installing skill: " + SkillDownloadTimeoutError, IsError: true}
		}
		return "", &tools.ToolResult{Output: "Error installing skill: " + utils.AsErrorString(err), IsError: true}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", &tools.ToolResult{Output: "Error: fetch failed (" + strconv.Itoa(response.StatusCode) + ")", IsError: true}
	}
	if length, err := strconv.ParseInt(response.Header.Get("Content-Length"), 10, 64); err == nil && length > MaxSkillDownloadBytes {
		return "", &tools.ToolResult{Output: "Error installing skill: " + SkillDownloadTooLargeError, IsError: true}
	}
	limited := io.LimitReader(response.Body, MaxSkillDownloadBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return "", &tools.ToolResult{Output: "Error installing skill: " + utils.AsErrorString(err), IsError: true}
	}
	if len(data) > MaxSkillDownloadBytes {
		return "", &tools.ToolResult{Output: "Error installing skill: " + SkillDownloadTooLargeError, IsError: true}
	}
	if err := timeoutCtx.Err(); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return "", &tools.ToolResult{Output: "Error installing skill: " + SkillDownloadTimeoutError, IsError: true}
		}
		return "", &tools.ToolResult{Output: "Error installing skill: " + utils.AsErrorString(err), IsError: true}
	}
	return string(data), nil
}

func installError(err error) tools.ToolResult {
	log.Error(map[string]any{"err": err}, "skills operation failed")
	return tools.ToolResult{Output: "Error installing skill: " + utils.AsErrorString(err), IsError: true}
}
