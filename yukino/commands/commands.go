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
	"fmt"
	"sort"
	"strings"
	"unicode"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"github.com/hangtiancheng/yukino-code/yukino/config"
)

type CommandType string

const (
	TypeLocal   CommandType = "local"
	TypeLocalUI CommandType = "local_ui"
	TypePrompt  CommandType = "prompt"
	// TypeSkillFork is for skills declared with `mode: fork`. The handler
	// runs the skill in an isolated sub-agent (no main-loop touch) and
	// returns the final assistant text; the TUI dispatcher inserts that
	// text into the main chat as an assistant message instead of pumping
	// it through the regular Agent Loop.
	TypeSkillFork CommandType = "skill_fork"
)

type Context struct {
	Args           string
	MemoryList     func() []string
	MemoryClear    func()
	TokenCount     func() (input, output int)
	PermissionMode func() string
	ToolCount      func() int
	SessionInfo    func() string
	SkillList      func() []SkillInfo
	SkillReload    func() int // reload catalog + prompt, returns new skill count
	MCPInfo        func() string
	WorkDir        string
	Model          string
	// Thinking controls (TS CommandContext.thinkingLevel & friends). All
	// optional; /thinking degrades gracefully when the host leaves them nil.
	ThinkingLevel           func() config.ThinkingLevel
	AvailableThinkingLevels func() []config.ThinkingLevel
	SetThinkingLevel        func(level config.ThinkingLevel) error
	PersistThinkingLevel    func(level config.ThinkingLevel) error
}

type SkillInfo struct {
	Name        string
	Description string
}

type Handler func(ctx *Context) string

type Command struct {
	Name        string
	Description string
	Aliases     []string
	Type        CommandType
	ArgPrompt   string
	Hidden      bool
	// IsSkill marks commands contributed by a skill (TS: isSkill), so hosts
	// can tell skill entries apart from built-in and user commands.
	IsSkill bool
	Handler Handler
}

type Registry struct {
	commands map[string]*Command
	// order preserves registration order (TS: the commands Map's insertion
	// order, observable in complete()).
	order   []string
	aliases map[string]string
}

func NewRegistry() *Registry {
	return &Registry{
		commands: make(map[string]*Command),
		aliases:  make(map[string]string),
	}
}

func (r *Registry) Register(cmd *Command) {
	// Panic messages mirror the TS Error wording (commands.ts:78-106); Go has
	// no exceptions, and callers filter with HasConflict before registering.
	if _, exists := r.commands[cmd.Name]; exists {
		panic(fmt.Sprintf("Command '%s' already registered", cmd.Name))
	}
	if owner, exists := r.aliases[cmd.Name]; exists {
		panic(fmt.Sprintf("Command name '%s' collides with alias of '%s'", cmd.Name, owner))
	}
	for _, alias := range cmd.Aliases {
		if _, exists := r.commands[alias]; exists {
			panic(fmt.Sprintf("Alias '%s' for '%s' collides with existing command name", alias, cmd.Name))
		}
		if owner, exists := r.aliases[alias]; exists {
			panic(fmt.Sprintf("Alias '%s' for '%s' already registered by '%s'", alias, cmd.Name, owner))
		}
	}
	r.commands[cmd.Name] = cmd
	r.order = append(r.order, cmd.Name)
	for _, alias := range cmd.Aliases {
		r.aliases[alias] = cmd.Name
	}
}

// HasConflict reports whether cmd would collide with an already registered
// command name or alias. Dynamic loaders (e.g. for user-defined commands)
// should call it before Register to filter out conflicting entries, as
// Register panics on conflict (TS commands.ts:108-124).
func (r *Registry) HasConflict(cmd *Command) bool {
	if r.Find(cmd.Name) != nil {
		return true
	}
	for _, alias := range cmd.Aliases {
		if r.Find(alias) != nil {
			return true
		}
	}
	return false
}

func (r *Registry) Find(name string) *Command {
	if cmd, ok := r.commands[name]; ok {
		return cmd
	}
	if canonical, ok := r.aliases[name]; ok {
		return r.commands[canonical]
	}
	return nil
}

// Complete returns every command whose name or any alias starts with prefix,
// compared case-insensitively, in registration order (TS commands.ts:133-140:
// `[...this.commands.values()].filter(...)` keeps the Map's insertion order).
func (r *Registry) Complete(prefix string) []*Command {
	lower := strings.ToLower(prefix)
	var out []*Command
	for _, name := range r.order {
		cmd := r.commands[name]
		if cmd == nil {
			continue
		}
		if strings.HasPrefix(strings.ToLower(cmd.Name), lower) {
			out = append(out, cmd)
			continue
		}
		for _, alias := range cmd.Aliases {
			if strings.HasPrefix(strings.ToLower(alias), lower) {
				out = append(out, cmd)
				break
			}
		}
	}
	return out
}

// ListCommands returns the non-hidden commands sorted by name with the ICU
// root collator (TS commands.ts:142-146: `.sort((a, b) =>
// a.name.localeCompare(b.name))` — localeCompare is ICU collation, so a plain
// byte sort would order "Zebra" before "apple"). The collator is created per
// call because collate.Collator is not safe for concurrent use.
func (r *Registry) ListCommands() []*Command {
	var cmds []*Command
	for _, name := range r.order {
		cmd := r.commands[name]
		if cmd == nil || cmd.Hidden {
			continue
		}
		cmds = append(cmds, cmd)
	}
	collator := collate.New(language.Und)
	sort.SliceStable(cmds, func(i, j int) bool {
		return collator.CompareString(cmds[i].Name, cmds[j].Name) < 0
	})
	return cmds
}

// Parse splits slash-command input into name and args; an empty name means
// the input is not a command. Mirrors TS parse (commands.ts:154-173): names
// are case-sensitive, split on any whitespace, and a name containing "/" is
// a filesystem path (e.g. /path/to/x), i.e. a plain user message.
func Parse(input string) (name string, args string) {
	if !strings.HasPrefix(input, "/") {
		return "", ""
	}
	trimmed := strings.TrimSpace(input[1:])
	idx := strings.IndexFunc(trimmed, unicode.IsSpace)
	if idx == -1 {
		name = trimmed
	} else {
		name = trimmed[:idx]
	}
	if strings.Contains(name, "/") {
		return "", ""
	}
	if idx == -1 {
		return name, ""
	}
	return name, strings.TrimSpace(trimmed[idx:])
}

func CreateDefaultRegistry() *Registry {
	r := NewRegistry()

	r.Register(&Command{
		Name:        "login",
		Description: "Configure, save, and activate an LLM provider",
		Type:        TypeLocalUI,
	})

	r.Register(&Command{
		Name:        "help",
		Description: "Show available commands",
		Aliases:     []string{"h", "?"},
		Type:        TypeLocal,
		Handler: func(ctx *Context) string {
			if ctx.Args != "" {
				cmd := r.Find(ctx.Args)
				if cmd == nil {
					return fmt.Sprintf("Unknown command: %s", ctx.Args)
				}
				var sb strings.Builder
				fmt.Fprintf(&sb, "/%s — %s\n", cmd.Name, cmd.Description)
				if len(cmd.Aliases) > 0 {
					fmt.Fprintf(&sb, "  Aliases: %s\n", strings.Join(cmd.Aliases, ", "))
				}
				return sb.String()
			}
			var sb strings.Builder
			sb.WriteString("Available commands:\n\n")
			for _, cmd := range r.ListCommands() {
				// Skills are discoverable via /skills instead (TS filters
				// isSkill out of the /help listing).
				if cmd.IsSkill {
					continue
				}
				aliases := ""
				if len(cmd.Aliases) > 0 {
					aliases = ", /" + strings.Join(cmd.Aliases, ", /")
				}
				fmt.Fprintf(&sb, "  /%s%s\n    %s\n", cmd.Name, aliases, cmd.Description)
			}
			sb.WriteString("\nType /help <command> for details.")
			return sb.String()
		},
	})

	r.Register(&Command{
		Name:        "clear",
		Description: "Clear conversation history",
		Type:        TypeLocalUI,
	})

	r.Register(&Command{
		Name:        "compact",
		Description: "Force context compaction",
		Aliases:     []string{"c"},
		Type:        TypeLocalUI,
	})

	r.Register(&Command{
		Name:        "status",
		Description: "Show current status",
		Aliases:     []string{"s"},
		Type:        TypeLocal,
		Handler: func(ctx *Context) string {
			// Display actual runtime status instead of placeholder text. All
			// optional callbacks are nil-checked (TS commands.ts:240-276);
			// hosts may leave them unset.
			var lines []string
			lines = append(lines, "Yukino Status", "──────────────")
			mode := "default"
			if ctx.PermissionMode != nil {
				mode = ctx.PermissionMode()
			}
			lines = append(lines, fmt.Sprintf("  Mode:      %s", mode))
			if ctx.TokenCount != nil {
				input, output := ctx.TokenCount()
				lines = append(lines, fmt.Sprintf("  Tokens:    %d in / %d out", input, output))
			}
			if ctx.ToolCount != nil {
				lines = append(lines, fmt.Sprintf("  Tools:     %d enabled", ctx.ToolCount()))
			}
			if ctx.MemoryList != nil {
				lines = append(lines, fmt.Sprintf("  Memories:  %d entries", len(ctx.MemoryList())))
			}
			if ctx.Model != "" {
				lines = append(lines, fmt.Sprintf("  Model:     %s", ctx.Model))
			}
			lines = append(lines, fmt.Sprintf("  Directory: %s", ctx.WorkDir))
			return strings.Join(lines, "\n")
		},
	})

	r.Register(&Command{
		Name:        "session",
		Description: "Show session info",
		Type:        TypeLocal,
		Handler: func(ctx *Context) string {
			sub, _ := parseSubcommand(ctx.Args)
			switch sub {
			case "", "info":
				if ctx.SessionInfo == nil {
					return "Session info not available."
				}
				return ctx.SessionInfo()
			case "list":
				if ctx.SessionInfo == nil {
					return "Session info not available."
				}
				return ctx.SessionInfo()
			default:
				return "Usage: /session [list|info]"
			}
		},
	})

	r.Register(&Command{
		Name:        "plan",
		Description: "Enter plan mode",
		Aliases:     []string{"p"},
		Type:        TypeLocalUI,
	})

	r.Register(&Command{
		Name:        "resume",
		Description: "Resume a previous session",
		Aliases:     []string{"r"},
		Type:        TypeLocalUI,
	})

	r.Register(&Command{
		Name:        "quit",
		Description: "Exit Yukino",
		Aliases:     []string{"exit", "q"},
		Type:        TypeLocalUI,
	})

	r.Register(&Command{
		Name:        "memory",
		Description: "Show memory status",
		Type:        TypeLocal,
		Handler: func(ctx *Context) string {
			sub, subArgs := parseSubcommand(ctx.Args)

			if ctx.MemoryList == nil || ctx.MemoryClear == nil {
				return "Memory management not available."
			}

			switch sub {
			case "", "list":
				memories := ctx.MemoryList()
				if len(memories) == 0 {
					return "No memories saved yet. They are auto-extracted; /memory clear wipes them."
				}
				// TS UI rendering: "Memories (N):" header, two-space indented
				// "[type] name — description" lines, no truncation.
				lines := make([]string, 0, len(memories))
				for _, mem := range memories {
					lines = append(lines, "  "+mem)
				}
				return fmt.Sprintf("Memories (%d):\n%s", len(memories), strings.Join(lines, "\n"))

			case "clear":
				ctx.MemoryClear()
				return "All memories cleared."

			default:
				_ = subArgs
				return "Usage: /memory [list|clear]"
			}
		},
	})

	r.Register(&Command{
		Name:        "skills",
		Description: "List available skills",
		Type:        TypeLocal,
		Handler: func(ctx *Context) string {
			if strings.TrimSpace(ctx.Args) == "reload" {
				if ctx.SkillReload == nil {
					return "Skill reload not available."
				}
				count := ctx.SkillReload()
				return fmt.Sprintf("Skills reloaded. %d skill(s) available.", count)
			}
			if ctx.SkillList == nil {
				return "Skills not available."
			}
			skills := ctx.SkillList()
			if len(skills) == 0 {
				return "No skills found in .agents/skills/."
			}
			var sb strings.Builder
			fmt.Fprintf(&sb, "Available skills (%d):\n\n", len(skills))
			for _, s := range skills {
				desc := s.Description
				if len(desc) > 100 {
					desc = desc[:100] + "…"
				}
				fmt.Fprintf(&sb, "  /%s\n    %s\n\n", s.Name, desc)
			}
			sb.WriteString("Type /<skill-name> to invoke a skill.\n")
			sb.WriteString("Type /skills reload to hot-reload skills from disk.")
			return sb.String()
		},
	})

	r.Register(&Command{
		Name:        "worktree",
		Description: "Manage git worktrees",
		Aliases:     []string{"wt"},
		Type:        TypeLocalUI,
	})

	r.Register(&Command{
		Name:        "code-review",
		Description: "Manage code review team (create, add, remove, list)",
		Aliases:     []string{"cr"},
		Type:        TypeLocal,
		Handler: func(ctx *Context) string {
			args := strings.TrimSpace(ctx.Args)
			if args == "" {
				return "Usage: /code-review <command> [args]\nCommands: create, add <name>, remove <name>, list, status"
			}
			return "code-review:" + args
		},
	})

	r.Register(&Command{
		Name:        "review",
		Description: "Review the uncommitted code changes for bugs and improvements",
		Type:        TypePrompt,
		Handler: func(ctx *Context) string {
			prompt := "Review the current uncommitted changes. Run `git status` and `git diff` to see them, " +
				"then report concrete findings (file:line) for correctness bugs, security issues, and obvious " +
				"simplifications. Be specific and concise."
			if ctx.Args != "" {
				prompt += "\n\nFocus on: " + ctx.Args
			}
			return prompt
		},
	})

	r.Register(&Command{
		Name:        "rewind",
		Description: "Rewind conversation to a previous checkpoint",
		Type:        TypeLocalUI,
	})

	r.Register(&Command{
		Name:        "mcp",
		Description: "Show MCP server status; /mcp reload re-reads the config and reconnects",
		Type:        TypeLocal,
		Handler: func(ctx *Context) string {
			if ctx.MCPInfo == nil {
				return "No MCP servers configured"
			}
			info := ctx.MCPInfo()
			if info == "" {
				return "No MCP servers connected"
			}
			return info
		},
	})

	r.Register(&Command{
		Name:        "sandbox",
		Description: "Toggle OS sandbox mode for command execution",
		Type:        TypeLocalUI,
	})

	r.Register(&Command{
		Name:        "thinking",
		Description: "Show or set the thinking level (off, minimal, low, medium, high, xhigh, max)",
		Aliases:     []string{"think"},
		Type:        TypeLocal,
		Handler: func(ctx *Context) string {
			arg := strings.ToLower(strings.TrimSpace(ctx.Args))
			available := config.ThinkingLevels
			if ctx.AvailableThinkingLevels != nil {
				available = ctx.AvailableThinkingLevels()
			}
			if arg == "" {
				current := "unknown"
				if ctx.ThinkingLevel != nil {
					current = string(ctx.ThinkingLevel())
				}
				return fmt.Sprintf("Thinking level: %s\nUsage: /thinking <%s>", current, joinLevels(available, " | "))
			}
			if !config.IsValidThinkingLevel(arg) {
				return fmt.Sprintf("Unknown thinking level %q. Available levels: %s", arg, joinLevels(available, ", "))
			}
			if !containsLevel(available, arg) {
				return fmt.Sprintf("Thinking level %q is not supported. Available levels: %s", arg, joinLevels(available, ", "))
			}
			if ctx.SetThinkingLevel == nil {
				return "Thinking level control is not available in this context."
			}
			effective := config.ThinkingLevel(arg)
			if err := ctx.SetThinkingLevel(effective); err != nil {
				return fmt.Sprintf("Unable to set thinking level: %v. Try /thinking <%s>. Nothing was saved.", err, joinLevels(available, " | "))
			}
			if ctx.ThinkingLevel != nil {
				effective = ctx.ThinkingLevel()
			}
			adjustment := ""
			if string(effective) != arg {
				adjustment = fmt.Sprintf(" (requested %s)", arg)
			}
			// Persist the effective level, not the request. A save failure
			// must not undo the runtime change.
			if ctx.PersistThinkingLevel != nil {
				if err := ctx.PersistThinkingLevel(effective); err != nil {
					return fmt.Sprintf("Thinking level set to %s%s for this session, but saving failed: %v", effective, adjustment, err)
				}
				return fmt.Sprintf("Thinking level set to %s%s and saved.", effective, adjustment)
			}
			return fmt.Sprintf("Thinking level set to %s%s.", effective, adjustment)
		},
	})

	return r
}

func parseSubcommand(args string) (sub string, rest string) {
	args = strings.TrimSpace(args)
	if args == "" {
		return "", ""
	}
	parts := strings.SplitN(args, " ", 2)
	sub = strings.ToLower(parts[0])
	if len(parts) > 1 {
		rest = strings.TrimSpace(parts[1])
	}
	return
}

func joinLevels(levels []config.ThinkingLevel, sep string) string {
	names := make([]string, 0, len(levels))
	for _, level := range levels {
		names = append(names, string(level))
	}
	return strings.Join(names, sep)
}

func containsLevel(levels []config.ThinkingLevel, name string) bool {
	for _, level := range levels {
		if string(level) == name {
			return true
		}
	}
	return false
}
