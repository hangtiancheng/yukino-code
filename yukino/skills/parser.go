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
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// frontmatterRe matches the leading YAML frontmatter block. Delimiters occupy
// their own lines; a `---` inside YAML strings or inside the markdown body is
// content, not a delimiter (TS: catalog.ts:267-269).
var frontmatterRe = regexp.MustCompile(`(?s)^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)`)

// parsedSkill is the result of a successful parseSkillFile call (TS: the
// { meta, body, frontmatter } object, catalog.ts:260-264).
type parsedSkill struct {
	Meta SkillMeta
	Body string
	// Frontmatter is the raw decoded YAML mapping including unknown keys.
	// InstallSkill re-serialises it when a name override rewrites the file
	// (TS: install-tool.ts:151).
	Frontmatter map[string]any
	// FrontmatterNode is the decoded YAML document, preserving the original
	// key order and scalar styles for the name-override rewrite.
	FrontmatterNode *yaml.Node
}

// parseSkillFile splits SKILL.md content into validated metadata and body.
// It returns an error — and the caller skips the whole skill — when the
// frontmatter block is missing or fails validation: name must be a non-empty
// string, mode and fork_context must be valid enums, and present-but-null
// values are rejected (TS: YamlFrontmatterSchema + parseSkillFile,
// catalog.ts:252-293).
func parseSkillFile(content string) (*parsedSkill, error) {
	// Strip a leading BOM before matching the opening delimiter (TS: catalog.ts:266).
	normalized := strings.TrimPrefix(content, "\uFEFF")
	match := frontmatterRe.FindStringSubmatch(normalized)
	if match == nil {
		// TS returns null without logging when the frontmatter block is absent.
		return nil, fmt.Errorf("no YAML frontmatter block")
	}
	body := strings.TrimSpace(normalized[len(match[0]):])

	var raw any
	if err := yaml.Unmarshal([]byte(match[1]), &raw); err != nil {
		// TS logs inside parseSkillFile's catch (catalog.ts:289-292).
		log.Error("skills operation failed", "err", err)
		return nil, fmt.Errorf("parse frontmatter YAML: %w", err)
	}
	data, ok := raw.(map[string]any)
	if !ok {
		log.Error("skills operation failed", "err", fmt.Errorf("frontmatter is not a YAML mapping"))
		return nil, fmt.Errorf("frontmatter is not a YAML mapping")
	}

	name, err := requiredString(data, "name")
	if err != nil {
		log.Error("skills operation failed", "err", err)
		return nil, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		err := fmt.Errorf("frontmatter name is empty")
		log.Error("skills operation failed", "err", err)
		return nil, err
	}
	description, err := optionalString(data, "description")
	if err != nil {
		log.Error("skills operation failed", "err", err)
		return nil, err
	}
	mode, err := optionalEnum(data, "mode", "inline", "fork")
	if err != nil {
		log.Error("skills operation failed", "err", err)
		return nil, err
	}
	model, err := optionalString(data, "model")
	if err != nil {
		log.Error("skills operation failed", "err", err)
		return nil, err
	}
	forkContext, err := optionalEnum(data, "fork_context", "full", "none", "recent")
	if err != nil {
		log.Error("skills operation failed", "err", err)
		return nil, err
	}

	// Keep the decoded document node so a name-override rewrite can preserve
	// the original key order (TS: yaml.dump of the spread frontmatter object,
	// install-tool.ts:151).
	var node yaml.Node
	if err := yaml.Unmarshal([]byte(match[1]), &node); err != nil {
		log.Error("skills operation failed", "err", err)
		return nil, fmt.Errorf("parse frontmatter YAML: %w", err)
	}

	return &parsedSkill{
		Meta: SkillMeta{
			Name:        name,
			Description: description,
			Mode:        resolveMode(mode, data["context"]),
			Model:       model,
			ForkContext: forkContext,
		},
		Body:            body,
		Frontmatter:     data,
		FrontmatterNode: &node,
	}, nil
}

// requiredString returns the value of key, which must be present and be a
// string (TS: z.string() — a present-but-null value fails validation).
func requiredString(data map[string]any, key string) (string, error) {
	v, ok := data[key]
	if !ok {
		return "", fmt.Errorf("frontmatter missing %s", key)
	}
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("frontmatter %s must be a string", key)
	}
	return s, nil
}

// optionalString returns the value of key, or "" when the key is absent.
// A present value must be a string — including explicit null, which fails
// (TS: z.string().optional()).
func optionalString(data map[string]any, key string) (string, error) {
	v, present := data[key]
	if !present {
		return "", nil
	}
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("frontmatter %s must be a string", key)
	}
	return s, nil
}

// optionalEnum validates key against allowed when present
// (TS: z.enum([...]).optional()).
func optionalEnum(data map[string]any, key string, allowed ...string) (string, error) {
	v, present := data[key]
	if !present {
		return "", nil
	}
	s, ok := v.(string)
	if ok {
		for _, a := range allowed {
			if s == a {
				return s, nil
			}
		}
	}
	return "", fmt.Errorf("frontmatter %s must be one of: %s", key, strings.Join(allowed, ", "))
}

// resolveMode normalises the execution mode. Some agent ecosystems use
// `context: fork` to express "isolated execution", which is semantically
// equivalent to `mode: fork`; both forms are interchangeable so externally
// sourced skills work without modification (TS: resolveMode, catalog.ts:242-250).
func resolveMode(mode string, rawContext any) string {
	if mode == "inline" || mode == "fork" {
		return mode
	}
	if s, ok := rawContext.(string); ok && s == "fork" {
		return "fork"
	}
	return "inline"
}

// parseFrontmatterOnly does phase-1 loading: read just enough of the skill
// directory to extract the validated SkillMeta, leaving PromptBody empty.
// Cheap enough to run for hundreds of skills at startup. Invalid skills
// return an error so the catalog skips them (TS: scanDirectory + loadSkill,
// catalog.ts:118-180).
func parseFrontmatterOnly(dir string) (*Skill, error) {
	mdPath := filepath.Join(dir, "SKILL.md")
	data, err := os.ReadFile(mdPath)
	if err != nil {
		// TS loadSkill's catch logs read failures (catalog.ts:176-179).
		log.Error("skills operation failed", "err", err)
		return nil, fmt.Errorf("read SKILL.md: %w", err)
	}
	parsed, err := parseSkillFile(string(data))
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", mdPath, err)
	}
	skill := &Skill{
		Meta:        parsed.Meta,
		SourceDir:   dir,
		SourceFile:  mdPath,
		IsDirectory: true,
		BodyLoaded:  false,
	}
	// Record the file modification time for hot reload detection (TS:
	// entry.loadedMtimeMs; 0 when the mtime cannot be read skips reloading).
	if info, serr := os.Stat(mdPath); serr == nil {
		skill.LoadedMtimeMs = info.ModTime().UnixMilli()
	} else {
		// Fail gracefully if the timestamp cannot be retrieved (TS logs).
		log.Error("skills operation failed", "err", serr)
	}
	return skill, nil
}

// loadSkillBody reads the body for an already-frontmatter-parsed skill
// (phase-2 load). On any read/parse error, leaves the existing PromptBody
// untouched and returns the error so the caller can fall back to the cached
// version (TS: catalog.ts — a single bad write must not make a skill vanish).
func loadSkillBody(skill *Skill) error {
	mdPath := filepath.Join(skill.SourceDir, "SKILL.md")
	data, err := os.ReadFile(mdPath)
	if err != nil {
		return fmt.Errorf("read SKILL.md: %w", err)
	}
	parsed, err := parseSkillFile(string(data))
	if err != nil {
		return fmt.Errorf("parse SKILL.md: %w", err)
	}
	skill.PromptBody = parsed.Body
	skill.BodyLoaded = true
	if info, serr := os.Stat(mdPath); serr == nil {
		skill.LoadedMtimeMs = info.ModTime().UnixMilli()
	}
	return nil
}
