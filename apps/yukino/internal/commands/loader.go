package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/yukino-js/yukino/yukino/internal/frontmatter"
	"github.com/yukino-js/yukino/yukino/internal/storage"
)

type CommandMeta struct {
	Description  string `yaml:"description"`
	ArgumentHint string `yaml:"argument-hint"`
}

type loadedCommand struct {
	command    *Command
	sourcePath string
}

// LoadUserCommands loads markdown commands from ~/.yukino/prompts.
// Subdirectories namespace command names: sub/dir/foo.md becomes
// "sub:dir:foo". Name collisions resolve by source path: the
// lexicographically smallest path wins.
func LoadUserCommands() []*Command {
	base := storage.YukinoPath(PromptsDirName)
	if _, err := os.Stat(base); err != nil {
		return nil
	}
	loaded := walkDir(base, base)
	sort.Slice(loaded, func(i, j int) bool {
		return loaded[i].sourcePath < loaded[j].sourcePath
	})
	byName := map[string]loadedCommand{}
	var order []string
	for _, item := range loaded {
		if _, exists := byName[item.command.Name]; exists {
			continue
		}
		byName[item.command.Name] = item
		order = append(order, item.command.Name)
	}
	out := make([]*Command, 0, len(order))
	for _, name := range order {
		out = append(out, byName[name].command)
	}
	return out
}

func walkDir(base, dir string) []loadedCommand {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []loadedCommand
	for _, entry := range entries {
		full := filepath.Join(dir, entry.Name())
		info, err := os.Lstat(full)
		if err != nil {
			continue
		}
		if info.IsDir() {
			out = append(out, walkDir(base, full)...)
			continue
		}
		if strings.HasSuffix(entry.Name(), CommandFileExtension) {
			if cmd := parseCommandFile(base, full); cmd != nil {
				out = append(out, loadedCommand{command: cmd, sourcePath: full})
			}
		}
	}
	return out
}

func commandName(base, full string) string {
	rel := strings.TrimPrefix(full, base+string(filepath.Separator))
	rel = CommandFileExtensionRe.ReplaceAllString(rel, "")
	parts := strings.FieldsFunc(rel, func(r rune) bool { return r == '/' || r == '\\' })
	for i, p := range parts {
		parts[i] = strings.ReplaceAll(strings.ToLower(p), " ", "-")
	}
	return strings.Join(parts, ":")
}

func parseCommandFile(base, full string) *Command {
	data, err := os.ReadFile(full)
	if err != nil {
		return nil
	}
	name := commandName(base, full)
	if name == "" {
		return nil
	}
	var meta CommandMeta
	raw := strings.TrimPrefix(string(data), "\ufeff")
	fm, body, ok := frontmatter.Split(raw)
	if !ok {
		body = raw
	} else {
		var fields map[string]any
		if yaml.Unmarshal([]byte(fm), &fields) == nil && fields != nil {
			description, descriptionOK := fields["description"].(string)
			hint, hintOK := fields["argument-hint"].(string)
			_, hasDescription := fields["description"]
			_, hasHint := fields["argument-hint"]
			if (!hasDescription || descriptionOK) && (!hasHint || hintOK) {
				meta = CommandMeta{Description: description, ArgumentHint: hint}
			}
		}
	}
	description := meta.Description
	if description == "" {
		if meta.ArgumentHint != "" {
			description = fmt.Sprintf("custom command (args: %s)", meta.ArgumentHint)
		} else {
			description = "custom command"
		}
	}
	rendered := body
	return &Command{
		Name:        name,
		Type:        TypePrompt,
		Description: description + " " + CustomCommandTag,
		Handler: func(ctx *Context) string {
			return RenderBody(rendered, ctx.Args)
		},
	}
}

// ParseCommandArgs splits command arguments honoring single and double
// quotes and backslash escapes.
func ParseCommandArgs(input string) []string {
	var args []string
	var current strings.Builder
	quote := rune(0)
	started := false
	runes := []rune(input)
	for index := 0; index < len(runes); index++ {
		char := runes[index]
		nextEscapable := index+1 < len(runes) && (quote == 0 || quote == '"' && (runes[index+1] == '\\' || runes[index+1] == '"'))
		if char == '\\' && quote != '\'' && nextEscapable {
			index++
			current.WriteRune(runes[index])
			started = true
			continue
		}
		if quote != 0 {
			if char == quote {
				quote = 0
			} else {
				current.WriteRune(char)
			}
			continue
		}
		if char == '"' || char == '\'' {
			quote = char
			started = true
			continue
		}
		if isCommandSpace(char) {
			if started {
				args = append(args, current.String())
				current.Reset()
				started = false
			}
			continue
		}
		current.WriteRune(char)
		started = true
	}
	if started {
		args = append(args, current.String())
	}
	return args
}

// RenderBody substitutes argument placeholders ($ARGUMENTS, $@, $1...,
// ${1:-fallback}, ${@:start:length}) in a command body. When the body has no
// placeholder and args are present, they are appended.
func RenderBody(body, args string) string {
	positional := ParseCommandArgs(args)
	substituted := false
	at := func(start, length int) string {
		offset := start - 1
		if offset < 0 {
			offset = 0
		}
		if offset > len(positional) {
			offset = len(positional)
		}
		end := len(positional)
		if length >= 0 && length < end-offset {
			end = offset + length
		}
		return strings.Join(positional[offset:end], " ")
	}
	valueFor := func(target string) string {
		switch target {
		case "ARGUMENTS":
			return args
		case "@":
			return strings.Join(positional, " ")
		default:
			n, err := strconv.Atoi(target)
			if err != nil || n < 1 || n > len(positional) {
				return ""
			}
			return positional[n-1]
		}
	}
	rendered := ArgumentPlaceholderRe.ReplaceAllStringFunc(body, func(match string) string {
		groups := ArgumentPlaceholderRe.FindStringSubmatch(match)
		substituted = true
		target, fallback, start, length, simple := groups[1], groups[2], groups[3], groups[4], groups[5]
		if target != "" {
			value := valueFor(target)
			if value != "" {
				return value
			}
			return fallback
		}
		if start != "" {
			startN, _ := strconv.Atoi(start)
			lengthN := -1
			if length != "" {
				lengthN, _ = strconv.Atoi(length)
			}
			return at(startN, lengthN)
		}
		return valueFor(simple)
	})
	if !substituted && args != "" {
		return body + "\n\n" + args
	}
	return rendered
}
