package commands

import (
	"fmt"
	"sort"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/workflow"
)

type CommandType string

const (
	TypeLocal     CommandType = "local"
	TypeLocalUI   CommandType = "local_ui"
	TypePrompt    CommandType = "prompt"
	TypeSkillFork CommandType = "skill_fork"
)

// Context carries everything a command handler may need. Optional callbacks
// are nil when the host cannot provide them; handlers must check.
type Context struct {
	Cwd  string
	Args string
	// PermissionMode returns the current effective permission mode.
	PermissionMode func() string
	// TokenCount returns token usage [input, output].
	TokenCount func() (input, output int)
	// ToolCount returns the number of currently enabled tools.
	ToolCount  func() int
	MemoryList func() []string
	Model      string
	// ThinkingLevel returns the current effective thinking level.
	ThinkingLevel func() string
	// AvailableThinkingLevels returns the active client's available logical
	// thinking levels.
	AvailableThinkingLevels func() []string
	// SetThinkingLevel sets the thinking level for the active client.
	SetThinkingLevel func(level string)
	// PersistThinkingLevel persists the thinking level to the global config;
	// it returns an error on failure.
	PersistThinkingLevel func(level string) error
}

type Handler func(ctx *Context) string

type Command struct {
	Name        string
	Type        CommandType
	Description string
	Handler     Handler
	// Agent runs the prompt in this named foreground subagent.
	Agent string
	// IsSkill marks skill-derived commands; excluded from the /help listing
	// (see /skills).
	IsSkill bool
	// Markdown means the handler returns markdown to render richly (e.g. a
	// table), not plain text.
	Markdown bool
}

type Registry struct {
	commands map[string]*Command
	order    []*Command
}

func NewRegistry() *Registry {
	return &Registry{commands: make(map[string]*Command)}
}

// Register adds a command; it panics when the name conflicts.
func (r *Registry) Register(cmd *Command) {
	key := strings.ToLower(cmd.Name)
	if _, exists := r.commands[key]; exists {
		panic(fmt.Sprintf("Command '%s' already registered", cmd.Name))
	}
	r.commands[key] = cmd
	r.order = append(r.order, cmd)
}

func (r *Registry) Find(name string) *Command {
	return r.commands[strings.ToLower(name)]
}

func (r *Registry) Complete(prefix string) []*Command {
	lower := strings.ToLower(prefix)
	var matches []*Command
	for _, cmd := range r.order {
		if strings.HasPrefix(strings.ToLower(cmd.Name), lower) {
			matches = append(matches, cmd)
		}
	}
	return matches
}

func (r *Registry) ListCommands() []*Command {
	cmds := make([]*Command, 0, len(r.commands))
	for _, cmd := range r.commands {
		cmds = append(cmds, cmd)
	}
	sort.Slice(cmds, func(i, j int) bool { return cmds[i].Name < cmds[j].Name })
	return cmds
}

// Parse splits "/name args" input. Command names never contain "/"; a slash
// means the input is a filesystem path (e.g. /path/to/somewhere), which
// should be a plain user message, so Parse returns ok=false.
func Parse(input string) (name, args string, ok bool) {
	if !strings.HasPrefix(input, "/") {
		return "", "", false
	}
	trimmed := strings.TrimFunc(input[1:], isCommandSpace)
	spaceIdx := strings.IndexFunc(trimmed, func(r rune) bool {
		return isCommandSpace(r)
	})
	if spaceIdx == -1 {
		name = trimmed
	} else {
		name = trimmed[:spaceIdx]
	}
	if strings.Contains(name, "/") {
		return "", "", false
	}
	if spaceIdx == -1 {
		return name, "", true
	}
	return name, strings.TrimFunc(trimmed[spaceIdx+len(string([]rune(trimmed[spaceIdx:])[0])):], isCommandSpace), true
}

// Resolved pairs parsed input with the registered command.
type Resolved struct {
	Name    string
	Args    string
	Command *Command
}

// Resolve parses input and resolves it against the registry, handling the
// /skill alias.
func Resolve(input string, registry *Registry) *Resolved {
	name, args, ok := Parse(input)
	if !ok {
		return nil
	}
	if strings.ToLower(name) == "skill" && args != "" {
		parts := strings.Fields(args)
		first := parts[0]
		rest := strings.Join(parts[1:], " ")
		if strings.ToLower(first) == "reload" {
			name, args = "skills", "reload"
		} else {
			name, args = first, rest
		}
	}
	cmd := registry.Find(name)
	resolvedName := name
	if cmd != nil {
		resolvedName = cmd.Name
	}
	return &Resolved{Name: resolvedName, Args: args, Command: cmd}
}

func CreateDefaultRegistry() *Registry {
	r := NewRegistry()

	r.Register(&Command{
		Name:        "workflows",
		Type:        TypeLocalUI,
		Description: workflow.WorkflowCommandDescription,
		Handler:     func(ctx *Context) string { return "workflows" },
	})
	r.Register(&Command{
		Name:        "ultracode",
		Type:        TypePrompt,
		Description: "Orchestrate and verify a task with workflow subagents",
		Handler: func(ctx *Context) string {
			return workflow.UltracodePrompt + "\n\nTask: " + ctx.Args
		},
	})
	r.Register(&Command{
		Name:        "login",
		Type:        TypeLocalUI,
		Description: "Configure, save, and activate LLM provider",
		Handler:     func(ctx *Context) string { return "login" },
	})
	r.Register(&Command{
		Name:        "model",
		Type:        TypeLocalUI,
		Description: "Switch the model of the current provider",
		Handler:     func(ctx *Context) string { return "model" },
	})
	r.Register(&Command{
		Name:        "help",
		Type:        TypeLocal,
		Description: "Show available commands",
		Markdown:    true,
		Handler: func(ctx *Context) string {
			if ctx.Args != "" {
				cmd := r.Find(ctx.Args)
				if cmd == nil {
					return fmt.Sprintf("Unknown command: %s", ctx.Args)
				}
				return fmt.Sprintf("`/%s` — %s", cmd.Name, cmd.Description)
			}
			// List all commands; skills are discoverable via /skills instead.
			lines := []string{
				"**Available commands**",
				"",
				"| Command | Description |",
				"| --- | --- |",
			}
			escapeCell := func(value string) string {
				return strings.ReplaceAll(value, "|", "\\|")
			}
			for _, cmd := range r.ListCommands() {
				if cmd.IsSkill {
					continue
				}
				lines = append(lines, fmt.Sprintf("| `/%s` | %s |", cmd.Name, escapeCell(cmd.Description)))
			}
			lines = append(lines, "", "Type `/help <command>` for details.")
			return strings.Join(lines, "\n")
		},
	})
	r.Register(&Command{
		Name:        "clear",
		Type:        TypeLocalUI,
		Description: "Clear conversation history",
		Handler:     func(ctx *Context) string { return "clear" },
	})
	r.Register(&Command{
		Name:        "compact",
		Type:        TypeLocalUI,
		Description: "Force context compaction",
		Handler:     func(ctx *Context) string { return "compact" },
	})
	r.Register(&Command{
		Name:        "status",
		Type:        TypeLocal,
		Description: "Show current status",
		Handler: func(ctx *Context) string {
			lines := []string{"Yukino Status", "──────────────"}
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
			lines = append(lines, fmt.Sprintf("  Directory: %s", ctx.Cwd))
			return strings.Join(lines, "\n")
		},
	})
	r.Register(&Command{
		Name:        "session",
		Type:        TypeLocal,
		Description: "Show session info",
		Handler:     func(ctx *Context) string { return SessionActiveMessage },
	})
	r.Register(&Command{
		Name:        "plan",
		Type:        TypePrompt,
		Agent:       subagent.PlanAgentName,
		Description: "Plan the current task in a foreground agent",
		Handler:     func(ctx *Context) string { return BuildPlanPrompt(ctx.Args) },
	})
	r.Register(&Command{
		Name:        "goal",
		Type:        TypePrompt,
		Description: "Set or view a persistent goal that drives auto-continuation across turns; status, pause, resume, continue, complete, clear, replace; --budget <tokens>",
		Handler:     func(ctx *Context) string { return strings.TrimSpace("/goal " + ctx.Args) },
	})
	r.Register(&Command{
		Name:        "resume",
		Type:        TypeLocalUI,
		Description: "Resume a previous session",
		Handler:     func(ctx *Context) string { return "resume" },
	})
	r.Register(&Command{
		Name:        "quit",
		Type:        TypeLocalUI,
		Description: "Exit Yukino",
		Handler:     func(ctx *Context) string { return "quit" },
	})
	r.Register(&Command{
		Name:        "memory",
		Type:        TypeLocal,
		Description: "Show memory status",
		// Placeholder token: the TUI and remote server intercept /memory by
		// name and render the real status themselves.
		Handler: func(ctx *Context) string { return "memory" },
	})
	r.Register(&Command{
		Name:        "skills",
		Type:        TypeLocalUI,
		Description: "List available skills",
		Handler:     func(ctx *Context) string { return "skills" },
	})
	r.Register(&Command{
		Name:        "worktree",
		Type:        TypeLocalUI,
		Description: "Manage git worktrees",
		Handler:     func(ctx *Context) string { return "worktree" },
	})
	r.Register(&Command{
		Name:        "review",
		Type:        TypePrompt,
		Description: ReviewCommandDescription,
		Agent:       subagent.ReviewAgentName,
		Handler:     func(ctx *Context) string { return BuildReviewPrompt(ctx.Args) },
	})
	r.Register(&Command{
		Name:        "rewind",
		Type:        TypeLocalUI,
		Description: "Rewind conversation to a previous checkpoint",
		Handler:     func(ctx *Context) string { return "rewind" },
	})
	r.Register(&Command{
		Name:        "mcp",
		Type:        TypeLocal,
		Description: "Show MCP server status; /mcp reload re-reads the config and reconnects",
		// Placeholder token: the TUI and remote server intercept /mcp by name
		// and render the real status themselves.
		Handler: func(ctx *Context) string { return "mcp" },
	})
	r.Register(&Command{
		Name:        "sandbox",
		Type:        TypeLocalUI,
		Description: "Toggle OS sandbox mode for command execution (auto, manual, off)",
		Handler:     func(ctx *Context) string { return "sandbox" },
	})
	r.Register(&Command{
		Name:        "thinking",
		Type:        TypeLocal,
		Description: "Show or set the thinking level (off, minimal, low, medium, high, xhigh, max)",
		Handler: func(ctx *Context) string {
			arg := strings.ToLower(strings.TrimSpace(ctx.Args))
			available := config.ThinkingLevels
			if ctx.AvailableThinkingLevels != nil {
				available = ctx.AvailableThinkingLevels()
			}
			if arg == "" {
				current := "unknown"
				if ctx.ThinkingLevel != nil {
					current = ctx.ThinkingLevel()
				}
				return fmt.Sprintf("Thinking level: %s\nUsage: /thinking <%s>", current, strings.Join(available, " | "))
			}
			if !config.IsValidThinkingLevel(arg) {
				return fmt.Sprintf("Unknown thinking level %q. Available levels: %s", arg, strings.Join(available, ", "))
			}
			supported := false
			for _, level := range available {
				if level == arg {
					supported = true
					break
				}
			}
			if !supported {
				return fmt.Sprintf("Thinking level %q is not supported. Available levels: %s", arg, strings.Join(available, ", "))
			}
			if ctx.SetThinkingLevel == nil {
				return ThinkingLevelControlUnavailable
			}
			ctx.SetThinkingLevel(arg)
			effective := arg
			if ctx.ThinkingLevel != nil {
				effective = ctx.ThinkingLevel()
			}
			adjustment := ""
			if effective != arg {
				adjustment = fmt.Sprintf(" (requested %s)", arg)
			}
			// Persist the effective level, not the request. A save failure must
			// not undo the runtime change.
			if ctx.PersistThinkingLevel != nil {
				if err := ctx.PersistThinkingLevel(effective); err != nil {
					return fmt.Sprintf("Thinking level set to %s%s for this session, but saving failed: %s", effective, adjustment, err)
				}
				return fmt.Sprintf("Thinking level set to %s%s and saved.", effective, adjustment)
			}
			return fmt.Sprintf("Thinking level set to %s%s.", effective, adjustment)
		},
	})

	return r
}

func isCommandSpace(r rune) bool {
	return r == '\u0009' || r == '\u000a' || r == '\u000b' || r == '\u000c' || r == '\u000d' || r == '\u0020' || r == '\u00a0' || r == '\u1680' || r >= '\u2000' && r <= '\u200a' || r == '\u2028' || r == '\u2029' || r == '\u202f' || r == '\u205f' || r == '\u3000' || r == '\ufeff'
}

// Has reports whether a command is registered.
func (r *Registry) Has(name string) bool { return r.Find(name) != nil }

// RegisterPromptCommand registers a prompt-type command; used by the
// workflow service for named workflows.
func (r *Registry) RegisterPromptCommand(name, description string, handler func(args string) string) {
	r.Register(&Command{Name: name, Type: TypePrompt, Description: description, Handler: func(ctx *Context) string {
		return handler(ctx.Args)
	}})
}
