package ui

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"strconv"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/yukino-js/yukino/yukino/internal/bootstrap"
	"github.com/yukino-js/yukino/yukino/internal/commands"
	"github.com/yukino-js/yukino/yukino/internal/compact"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/file_history"
	"github.com/yukino-js/yukino/yukino/internal/history"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/memory"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/todo"
	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/workflow"
)

func (m Model) buildCommandContext(args string) *commands.Context {
	wd, _ := os.Getwd()
	modelName := ""
	if m.selectedProvider != nil {
		modelName = m.selectedProvider.Model
	}
	ctx := &commands.Context{
		Args:  args,
		Cwd:   wd,
		Model: modelName,
		MemoryList: func() []string {
			if m.memoryMgr == nil {
				return nil
			}
			memories := m.memoryMgr.GetMemories()
			names := make([]string, 0, len(memories))
			for _, memory := range memories {
				names = append(names, memory.Name)
			}
			return names
		},
		TokenCount: func() (int, int) {
			return m.totalInput, m.totalOutput
		},
		PermissionMode: func() string {
			if m.ag != nil && m.ag.Checker != nil {
				return string(m.ag.Checker.Mode())
			}
			return "default"
		},
		ToolCount: func() int {
			return len(m.registry.ListTools())
		},
		ThinkingLevel: func() string {
			if control, ok := m.client.(llm.ThinkingLevelControl); ok {
				return control.GetThinkingLevel()
			}
			if m.selectedProvider != nil && m.selectedProvider.Thinking != "" {
				return m.selectedProvider.Thinking
			}
			return config.DefaultThinkingLevel
		},
		AvailableThinkingLevels: func() []string {
			if control, ok := m.client.(llm.ThinkingLevelControl); ok {
				return control.GetSupportedThinkingLevels()
			}
			if m.selectedProvider != nil {
				return config.GetSupportedThinkingLevels(m.selectedProvider)
			}
			return config.ThinkingLevels
		},
		PersistThinkingLevel: func(level string) error {
			if m.selectedProvider == nil {
				return fmt.Errorf("no active provider")
			}
			return config.PersistThinkingLevel(m.selectedProvider.BaseURL, level)
		},
	}
	if control, ok := m.client.(llm.ThinkingLevelControl); ok {
		ctx.SetThinkingLevel = func(level string) {
			control.SetThinkingLevel(level)
			if m.selectedProvider != nil {
				m.selectedProvider.Thinking = control.GetThinkingLevel()
				for index := range m.providers {
					if m.providers[index].BaseURL == m.selectedProvider.BaseURL {
						m.providers[index].Thinking = m.selectedProvider.Thinking
					}
				}
			}
		}
	}
	return ctx
}

// newUICommandRegistry mirrors the app-level command registration in
// src/ui/app.tsx: /provider is registered by the UI, not the default registry.
func newUICommandRegistry() *commands.Registry {
	registry := commands.CreateDefaultRegistry()
	registry.Register(&commands.Command{
		Name:        "provider",
		Type:        commands.TypeLocalUI,
		Description: "Switch the active provider",
	})
	return registry
}

func (m Model) executeCommand(text string, existingInput *history.InputEntry) (updated tea.Model, command tea.Cmd) {
	defer func() {
		if failure := recover(); failure != nil {
			m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: fmt.Sprintf("Error: %v", failure)})
			updated = m
			command = nil
		}
	}()
	parsed := commands.Resolve(text, m.cmdRegistry)
	if parsed == nil {
		return m, nil
	}
	name, args, cmd := parsed.Name, parsed.Args, parsed.Command
	var input history.InputEntry
	if existingInput != nil {
		input = *existingInput
	} else {
		var commandName *string
		if cmd != nil {
			commandName = &cmd.Name
		}
		var err error
		input, err = history.RecordInput(history.InputOptions{Text: text, Cwd: m.getWorkDir(), SessionID: &m.sessionID, Source: "cli", CommandName: commandName})
		if err != nil {
			return m.inputError(err)
		}
		m.historyEntries, err = history.LoadInputTexts()
		if err != nil {
			return m.inputError(err)
		}
	}
	if cmd == nil {
		m.chatMessages = append(m.chatMessages, chatMessage{
			role:    "system",
			content: fmt.Sprintf("Unknown command: /%s", name),
		})
		return m, nil
	}

	name = cmd.Name
	ctx := m.buildCommandContext(args)

	// The TUI intercepts these commands by name and renders the real status
	// itself; the registry handlers are placeholders.
	switch name {
	case "thinking":
		if strings.TrimSpace(args) == "" {
			if _, ok := m.client.(llm.ThinkingLevelControl); ok {
				return m.openThinkingDialog()
			}
		}
	case "workflows":
		if strings.TrimSpace(args) == "" {
			return m.openWorkflowsDialog()
		}
		if service := workflow.GetWorkflowService(m.registry); service != nil {
			ctx := m.workflowContext()
			return m, func() tea.Msg {
				output, err := service.Command(args, ctx)
				return workflowActionDoneMsg{output: output, err: err}
			}
		}
	case "status":
		m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: m.buildSessionStatus()})
		return m, nil
	case "memory":
		m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: m.buildMemoryStatus(args)})
		return m, nil
	case "mcp":
		return m.runMCPCommand(args)
	case "skills":
		if m.skillCatalog == nil {
			m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: "Skills: no catalog loaded."})
			return m, nil
		}
		if strings.TrimSpace(args) == "reload" {
			m.skillCatalog.Reload()
			bootstrap.WireSkillsToRegistry(m.skillCatalog, m.cmdRegistry, m)
			m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: fmt.Sprintf("Skills reloaded. %d skill(s) available.", len(m.skillCatalog.List()))})
			return m, nil
		}
		list := m.skillCatalog.List()
		if len(list) == 0 {
			m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: "No skills found in .agents/skills/."})
			return m, nil
		}
		var sb strings.Builder
		sb.WriteString("Available skills:\n")
		for _, s := range list {
			sb.WriteString(fmt.Sprintf("  /%s — %s\n", s.Name, s.Description))
		}
		sb.WriteString("\nType /skills reload to hot-reload skills from disk.")
		m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: sb.String()})
		return m, nil
	case "goal":
		return m.runGoalCommand(args, input)
	}

	switch cmd.Type {
	case commands.TypeLocalUI:
		switch name {
		case "clear":
			m.pendingMessages = nil
			m.steeringPending = nil
			m.queuePaused = false
			if m.taskMgr != nil {
				if err := m.taskMgr.StopAll(context.Background()); err != nil {
					return m.inputError(err)
				}
			}
			if m.teamMgr != nil {
				m.teamMgr.StopAll()
			}
			m.stopMemoryTasks()
			m.chatMessages = nil
			m.committedUpTo = 0
			m.conversation.Reset()
			m.sessionID = session.NewID()
			m.resetSessionContext()
			if m.ag != nil {
				m.ag.Checker.SetPlanFilePath("")
			}
			m.injectSessionContext()
			if m.taskMgr != nil {
				if err := m.taskMgr.UseSession(m.sessionID); err != nil {
					m.chatMessages = append(m.chatMessages, chatMessage{role: "error", content: err.Error()})
					return m, nil
				}
			}
			m.fileHistory = file_history.New(m.sessionID)
			m.defaultTools.EditFile.FileHistory = m.fileHistory
			m.defaultTools.WriteFile.FileHistory = m.fileHistory
			if m.ag != nil {
				m.ag.FileHistory = m.fileHistory
				m.ag.SetSessionID(m.sessionID)
				m.ag.GoalManager = m.currentGoal()
			}
			store, err := todo.NewStore(m.sessionID)
			if err != nil {
				panic(err)
			}
			if err := m.todoList.UseStore(store); err != nil {
				panic(err)
			}
			if m.taskMgr != nil {
				if err := m.taskMgr.Clear(); err != nil {
					m.chatMessages = append(m.chatMessages, chatMessage{role: "error", content: err.Error()})
					return m, nil
				}
			}
			m.totalInput = 0
			m.interactionStats = bootstrap.InteractionSummary{StartedAt: float64(time.Now().UnixMilli())}
			m.activeToolIDs = nil
			m.agentStartedAt, m.toolBatchStartedAt = time.Time{}, time.Time{}
			m.totalOutput = 0
			m.totalCacheRead = 0
			m.totalCacheCreation = 0
			m.subagents = nil
			m.prepareOutput()
			return m, tea.Batch(
				func() tea.Msg { return tea.ClearScreen() },
				tea.Println(m.renderTranscriptHeader()),
			)
		case "compact":
			if m.client == nil || m.conversation == nil {
				m.chatMessages = append(m.chatMessages, chatMessage{
					role: "error", content: "Compact requires an active provider.",
				})
				return m, nil
			}
			client := m.client
			conv := m.conversation
			var recovery *compact.RecoveryState
			var schemas []map[string]any
			if m.ag != nil {
				recovery = m.ag.RecoveryState
				schemas = m.ag.Registry.FilteredSchemas(m.ag.Protocol, m.ag.ToolNameFilter)
			}
			compactWD, _ := os.Getwd()
			compactSessionID := m.sessionID
			names := make([]string, 0, len(schemas))
			for _, schema := range schemas {
				if name := tools.SchemaName(schema); name != "" {
					names = append(names, name)
				}
			}
			sessionFilePath := session.SessionFilePath(compactWD, compactSessionID)
			customInstructions := args
			compactCtx, cancel := context.WithCancel(context.Background())
			m.compacting = true
			m.cancelStream = cancel
			return m, tea.Batch(func() tea.Msg {
				result, err := compact.ForceCompact(compactCtx, conv, client, recovery, names, schemas, sessionFilePath, customInstructions)
				if err == nil && result.Boundary != nil {
					err = session.SaveCompactBoundary(compactWD, compactSessionID, result.Boundary.Summary, result.Boundary.Keep)
				}
				message := ""
				if err == nil {
					message = result.Message
				}
				return compactDoneMsg{message: message, err: err}
			}, m.spinner.Tick)
		case "resume":
			return m.handleResume(args)
		case "rewind":
			return m.handleRewind()
		case "sandbox":
			return m.runSandboxCommand(args)
		case "quit":
			return m, tea.Quit
		case "model":
			if strings.TrimSpace(args) != "" {
				return m.applyModelSelection(args)
			}
			if m.client == nil {
				m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: ClientNotReady})
				return m, nil
			}
			return m.openModelDialog()
		case "provider":
			return m.openProviderDialog()
		case "login":
			return m.openLoginDialog()
		case "worktree":
			command := exec.Command("git", "worktree", "list")
			command.Dir = m.getWorkDir()
			message := "Not a git repository or git worktree not available."
			if output, err := command.Output(); err == nil {
				message = "Worktree list:\n" + string(output)
			}
			m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: message})
			return m, nil
		}

	case commands.TypePrompt:
		if cmd.Handler != nil {
			prompt := cmd.Handler(ctx)
			if m.client == nil || m.ag == nil || (cmd.Agent == "" && strings.TrimSpace(prompt) == "") {
				return m, nil
			}
			return m.sendPromptCommand(text, prompt, cmd.Agent, input)
		}

	case commands.TypeSkillFork:
		return m.startSkillFork(name, args)

	case commands.TypeLocal:
		if cmd.Handler != nil {
			output := cmd.Handler(ctx)
			m.chatMessages = append(m.chatMessages, chatMessage{role: "system", content: output, markdown: cmd.Markdown})
			return m, nil
		}
	}

	m.chatMessages = append(m.chatMessages, chatMessage{
		role:    "system",
		content: fmt.Sprintf("Unknown command: /%s", name),
	})
	return m, nil
}

// buildSessionStatus renders the rich /status block (src/ui/app.tsx parity:
// provider, sandbox, MCP, session).
func (m Model) buildSessionStatus() string {
	permMode := string(permissions.ModeDefault)
	if m.ag != nil && m.ag.Checker != nil {
		permMode = string(m.ag.Checker.Mode())
	}
	// The reference /status reads the sandbox mode state (not the availability-
	// gated checker flags), so an enabled-but-blocked sandbox still shows ON.
	sandboxEnabled, sandboxAutoAllow := m.sandboxEnabled, m.sandboxAutoAllow
	var model, providerName, protocol string
	if m.selectedProvider != nil {
		model = m.selectedProvider.Model
		providerName = m.selectedProvider.Name
		protocol = m.selectedProvider.Protocol
	}
	sbStatus := "OFF"
	if sandboxEnabled {
		sb := m.sandboxRuntime.Get()
		state := "blocked"
		if sb != nil && sb.Available() {
			state = "ready"
		}
		label := "ON (manual)"
		if sandboxAutoAllow {
			label = "ON (auto-allow)"
		}
		sbStatus = label + ", " + state
	}
	memories := "disabled (enable_memory: false)"
	if m.memoryEnabled {
		count := 0
		if m.memoryMgr != nil {
			count = len(m.memoryMgr.GetMemories())
		}
		memories = strconv.Itoa(count)
	}
	skillCount := 0
	if m.skillCatalog != nil {
		skillCount = len(m.skillCatalog.List())
	}
	mcpServers := 0
	if m.mcpMgr != nil {
		mcpServers = len(m.mcpMgr.ConnectedServers())
	}
	wd, _ := os.Getwd()
	lines := []string{
		"Mode:      " + permMode,
		"Model:     " + model,
		fmt.Sprintf("Provider:  %s (%s)", providerName, protocol),
		fmt.Sprintf("Tokens:    %d in / %d out", m.totalInput, m.totalOutput),
		fmt.Sprintf("Tools:     %d", len(m.registry.ListTools())),
		"Sandbox:   " + sbStatus,
		"Memories:  " + memories,
		fmt.Sprintf("Skills:    %d", skillCount),
		fmt.Sprintf("MCP:       %d server(s), %d tool(s)", mcpServers, bootstrap.CountMcpTools(m.registry)),
		"Session:   " + m.sessionID,
		"Directory: " + wd,
	}
	return strings.Join(lines, "\n")
}

// buildMemoryStatus renders /memory output (src/ui/app.tsx parity).
func (m Model) buildMemoryStatus(args string) string {
	if !m.memoryEnabled {
		return "Auto memory is disabled (enable_memory: false in config.yaml)."
	}
	sub := ""
	if fields := strings.Fields(strings.TrimSpace(args)); len(fields) > 0 {
		sub = fields[0]
	}
	wd, _ := os.Getwd()
	mgr := memory.NewManager(wd, nil)
	if sub == "clear" {
		mgr.Clear()
		return "All memories cleared."
	}
	mems := mgr.GetMemories()
	if len(mems) == 0 {
		return "No memories saved yet. They are auto-extracted; /memory clear wipes them."
	}
	lines := make([]string, 0, len(mems))
	for _, mem := range mems {
		lines = append(lines, fmt.Sprintf("  [%s] %s — %s", mem.Type, mem.Name, mem.Description))
	}
	return fmt.Sprintf("Memories (%d):\n%s", len(mems), strings.Join(lines, "\n"))
}
