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

package commands

import (
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// LoadUserCommands loads user-defined slash commands from .yukino/commands/*.md
// (user home first, then project, so the project wins on a name collision).
// Subdirectories namespace the command name: sub/dir/foo.md → "sub:dir:foo".
func LoadUserCommands(workDir string) []*Command {
	home, err := os.UserHomeDir()
	if err != nil {
		home = ""
	}
	var bases []string
	if home != "" {
		bases = append(bases, filepath.Join(home, ".yukino", "commands"))
	}
	bases = append(bases, filepath.Join(workDir, ".yukino", "commands"))

	byName := make(map[string]*Command)
	order := make([]string, 0)
	for _, base := range bases {
		if _, err := os.Stat(base); err != nil {
			continue
		}
		for _, cmd := range walkCommandDir(base, base) {
			if _, seen := byName[cmd.Name]; !seen {
				order = append(order, cmd.Name)
			}
			byName[cmd.Name] = cmd
		}
	}
	out := make([]*Command, 0, len(order))
	for _, name := range order {
		out = append(out, byName[name])
	}
	return out
}

func walkCommandDir(base, dir string) []*Command {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []*Command
	for _, entry := range entries {
		full := filepath.Join(dir, entry.Name())
		info, err := os.Stat(full)
		if err != nil {
			continue
		}
		if info.IsDir() {
			out = append(out, walkCommandDir(base, full)...)
		} else if strings.HasSuffix(entry.Name(), ".md") {
			if cmd := parseCommandFile(base, full); cmd != nil {
				out = append(out, cmd)
			}
		}
	}
	return out
}

// commandName maps a file path to its slash-command name: the path relative to
// base, lowercased, spaces replaced with dashes, separators replaced with ":".
func commandName(base, full string) string {
	rel := strings.TrimPrefix(full, base+string(filepath.Separator))
	rel = strings.TrimSuffix(rel, ".md")
	parts := strings.FieldsFunc(rel, func(r rune) bool { return r == '/' || r == '\\' })
	for i, p := range parts {
		parts[i] = strings.ReplaceAll(strings.ToLower(p), " ", "-")
	}
	return strings.Join(parts, ":")
}

type commandFrontmatter struct {
	Description string   `yaml:"description"`
	ArgHint     string   `yaml:"argument-hint"`
	Aliases     []string `yaml:"aliases"`
}

func parseCommandFile(base, full string) *Command {
	raw, err := os.ReadFile(full)
	if err != nil {
		return nil
	}

	description := ""
	argumentHint := ""
	var aliases []string
	body := string(raw)

	if strings.HasPrefix(body, "---") {
		if end := strings.Index(body[3:], "---"); end != -1 {
			frontmatter := strings.TrimSpace(body[3 : 3+end])
			body = strings.TrimSpace(body[3+end+3:])
			var fm commandFrontmatter
			if err := yaml.Unmarshal([]byte(frontmatter), &fm); err == nil {
				description = fm.Description
				argumentHint = fm.ArgHint
				aliases = fm.Aliases
			}
			// Frontmatter parse errors are ignored; the whole file stays the body.
		}
	}

	name := commandName(base, full)
	if name == "" {
		return nil
	}
	if description == "" {
		if argumentHint != "" {
			description = "custom command (args: " + argumentHint + ")"
		} else {
			description = "custom command"
		}
	}

	commandBody := body
	return &Command{
		Name:        name,
		Aliases:     aliases,
		Type:        TypePrompt,
		Description: description,
		ArgPrompt:   argumentHint,
		Handler: func(ctx *Context) string {
			return RenderBody(commandBody, ctx.Args)
		},
	}
}

// RenderBody renders a command body, substituting $ARGUMENTS; if there is no
// placeholder and args were given, they are appended.
func RenderBody(body, args string) string {
	if strings.Contains(body, "$ARGUMENTS") {
		return strings.ReplaceAll(body, "$ARGUMENTS", args)
	}
	if args != "" {
		return body + "\n\n" + args
	}
	return body
}
