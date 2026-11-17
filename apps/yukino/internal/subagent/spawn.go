package subagent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/memory"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/prompt"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

const (
	SubagentInterruptedMarker = "[Interrupted]"
	NoOutputMarker            = "[No output]"
	TranscriptFilename        = "transcript.jsonl"
	SubagentErrorRecordType   = "subagent_error"
)

// SubagentProgressEvent mirrors the spawn.ts progress union.
type SubagentProgressEvent struct {
	Type     string // tool_use | tool_result | usage | turn_complete
	ToolID   string
	ToolName string
	Args     map[string]any
	Usage    *SubagentUsage
}

type SubagentUsage struct {
	InputTokens  int
	OutputTokens int
}

// AgentEventSink receives subagent progress events.
type AgentEventSink func(event SubagentProgressEvent)

// SubagentRunOptions mirrors SubagentRunOptions.
type SubagentRunOptions struct {
	MaxOutputTokens int
	SessionID       string
	MemoryContent   string
	AgentName       string
	Background      bool
	PermissionMode  string
	// Conversation is the persistent teammate history; the caller supplies its
	// scoped registry.
	Conversation *conversation.Manager
	// ContextSnapshot is inherited context for a definition run; definition
	// tool restrictions still apply.
	ContextSnapshot *conversation.Manager
	// BackgroundTasks false disables the per-run background task manager.
	BackgroundTasks *bool
}

// SpawnSubagent runs one subagent to completion, mirroring spawn.ts. The
// abort signal is the context; permission requests route through the
// tools.ExecutionContext carried by ctx.
func SpawnSubagent(ctx context.Context, definition *AgentDefinition, userPrompt string, parentClient llm.Client, parentRegistry *tools.Registry, parentProvider *config.ProviderConfig, cwd string, onProgress func(turn int, lastTool string), onEvent AgentEventSink, modelOverride string, checkerOverride *permissions.Checker, options SubagentRunOptions) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	spec := definition.ToSpec()

	// Determine the model: call-level override > definition-level model > parent provider.
	effectiveModel := modelOverride
	if effectiveModel == "" {
		effectiveModel = definition.Model
	}
	resolvedModel := effectiveModel
	if resolvedModel == "" && parentProvider != nil {
		resolvedModel = parentProvider.Model
	}
	env := prompt.DetectEnvironment(cwd)
	env.Model = resolvedModel
	systemPrompt := definition.SystemPrompt
	if systemPrompt == "" {
		systemPrompt = prompt.BuildSystemPrompt(env)
	}
	provider := config.ProviderConfig{}
	if parentProvider != nil {
		provider = *parentProvider
	}
	if options.MaxOutputTokens > 0 {
		provider.MaxOutputTokens = float64(options.MaxOutputTokens)
	}
	provider.Model = resolvedModel
	if control, ok := parentClient.(llm.ThinkingLevelControl); ok {
		provider.Thinking = control.GetThinkingLevel()
	}
	client := parentClient
	if effectiveModel != "" || definition.SystemPrompt != "" {
		created, err := llm.NewClient(&provider, systemPrompt)
		if err != nil {
			return "", err
		}
		client = created
	}

	// Persistent teammates reuse their prepared registry. One-shot runs apply
	// role restrictions equally to inherited and fresh conversations.
	registry := parentRegistry
	disposeRegistry := false
	if options.Conversation == nil {
		permissionMode := definition.PermissionMode
		if checkerOverride != nil && checkerOverride.Teammate {
			permissionMode = string(checkerOverride.Mode())
		}
		registry = FilterToolsForAgent(parentRegistry, definition.Tools, definition.DisallowedTools, options.Background, permissionMode)
		disposeRegistry = true
	}
	sessionID := options.SessionID
	if sessionID == "" {
		sessionID = session.NewID()
	}
	transcriptPath, _ := storage.SessionPath(sessionID, TranscriptFilename)

	var taskManager *TaskManager
	if options.BackgroundTasks == nil || *options.BackgroundTasks {
		taskManager = NewTaskManager()
		if err := taskManager.UseSession(sessionID); err != nil {
			if disposeRegistry {
				_ = registry.Dispose()
			}
			return "", err
		}
	}

	var output strings.Builder
	submittedPlan := ""
	turn := 0
	runErr := func() error {
		inherited := checkerOverride
		if inherited == nil {
			inherited = permissions.NewChecker(permissions.NewPathSandbox(cwd, true), permissions.NewRuleEngine(cwd), permissions.PermissionMode(options.PermissionMode))
		}
		var checker *permissions.Checker
		if inherited.Teammate {
			checker = inherited.ForCwd(cwd)
		} else {
			checker = inherited.ForSubagent(cwd, permissions.PermissionMode(definition.PermissionMode))
		}
		if definition.ReadOnly {
			checker.ReadOnly = true
		}
		conv := options.Conversation
		if conv == nil {
			conv = options.ContextSnapshot
		}
		if conv == nil {
			conv = conversation.NewManager()
		}
		initialize := conv.Len() == 0
		if initialize && options.Conversation != nil && options.ContextSnapshot != nil {
			options.Conversation.AppendMessages(options.ContextSnapshot.GetMessages())
		}
		if options.Conversation == nil || initialize {
			conv.AddSystemReminder(buildSubagentInstructions(spec))
		}
		conv.AddUserMessage(userPrompt)
		var initialMessages []conversation.Message
		if _, err := os.Stat(transcriptPath); err == nil {
			messages := conv.GetMessages()
			initialMessages = messages[max(0, len(messages)-1):]
		} else {
			initialMessages = conv.GetMessages()
		}
		for _, message := range initialMessages {
			session.SaveTranscriptMessage(transcriptPath, session.FromConversation(message))
		}

		child := agent.New(client, registry, provider.Protocol)
		child.AgentName = options.AgentName
		if child.AgentName == "" {
			child.AgentName = definition.AgentType
		}
		child.SessionID = sessionID
		child.TranscriptPath = transcriptPath
		child.WorkDir = cwd
		child.MaxIterations = definition.MaxTurns
		child.Checker = checker
		child.FileStateCache = tools.NewFileStateCache()
		child.Instructions = memory.LoadInstructions(cwd)
		child.MemoryContent = options.MemoryContent
		child.ContextWindow = config.GetContextWindow(&provider)
		child.MaxOutputTokens = config.GetMaxOutputTokens(&provider)
		// The reference passes a null task manager when backgroundTasks is
		// false; the Go agent gates background execution on this flag so the
		// parent registry's manager is never inherited.
		child.DisableBackground = taskManager == nil
		if taskManager != nil {
			child.TaskManager = taskManager
			child.NotificationFn = func() ([]string, error) {
				var messages []string
				drained, err := taskManager.DrainNotifications()
				if err != nil {
					return nil, err
				}
				for _, n := range drained {
					messages = append(messages, FormatAgentTaskNotification(n))
				}
				return messages, nil
			}
		}

		var interrupted bool
		completed := false
		for event := range child.Run(ctx, conv) {
			switch e := event.(type) {
			case agent.StreamText:
				output.WriteString(e.Text)
			case agent.ToolUseEvent:
				if onProgress != nil {
					onProgress(turn, e.ToolName)
				}
				if onEvent != nil {
					onEvent(SubagentProgressEvent{Type: "tool_use", ToolID: e.ToolID, ToolName: e.ToolName, Args: e.Args})
				}
			case agent.ToolResultEvent:
				if e.ToolName == "ExitPlanMode" && !e.IsError {
					submittedPlan = e.Output
				}
				if onEvent != nil {
					onEvent(SubagentProgressEvent{Type: "tool_result", ToolID: e.ToolID})
				}
			case agent.UsageEvent:
				if onEvent != nil {
					onEvent(SubagentProgressEvent{Type: "usage", Usage: &SubagentUsage{InputTokens: e.InputTokens, OutputTokens: e.OutputTokens}})
				}
			case agent.TurnComplete:
				turn++
				if onProgress != nil {
					onProgress(turn, "")
				}
				if onEvent != nil {
					onEvent(SubagentProgressEvent{Type: "turn_complete"})
				}
			case agent.PermissionRequestEvent:
				// The reference routes permission prompts through the
				// onPermissionRequest callback; the Go agent surfaces them as
				// events answered through the ctx runtime (deny when absent).
				reply := agent.PermissionReply{Response: agent.PermDeny}
				if runtime, ok := tools.RuntimeContext(ctx); ok && runtime.RequestPermission != nil {
					response := runtime.RequestPermission(ctx, tools.PermissionRequest{ToolName: e.ToolName, Desc: e.Desc, AgentName: e.AgentName, Cwd: e.Cwd, ToolCallID: e.ToolID, Args: e.Args, RememberPatterns: e.Decision.RememberPatterns})
					reply = agent.PermissionReply{Response: agent.PermissionResponse(response)}
				}
				e.ResponseCh <- reply
			case agent.LoopComplete:
				completed = true
				if e.StopReason == "interrupted" {
					interrupted = true
				}
			case agent.ErrorEvent:
				return errors.New(e.Message)
			}
		}
		text := output.String()
		if interrupted {
			sep := ""
			if text != "" {
				sep = "\n\n"
			}
			return &spawnResult{text: text + sep + SubagentInterruptedMarker}
		}
		if completed && submittedPlan != "" {
			sep := ""
			if text != "" {
				sep = "\n\n"
			}
			return &spawnResult{text: text + sep + submittedPlan}
		}
		if text == "" {
			text = NoOutputMarker
		}
		return &spawnResult{text: text}
	}()

	if taskManager != nil {
		_ = taskManager.StopAll(context.Background())
	}
	if disposeRegistry {
		_ = registry.Dispose()
	}

	var result *spawnResult
	if errors.As(runErr, &result) {
		return result.text, nil
	}
	if runErr != nil {
		detail := runErr.Error()
		session.SaveTranscriptMessage(transcriptPath, session.Message{Role: "system", Type: SubagentErrorRecordType, Content: detail, Timestamp: time.Now().Unix()})
		wrapped := detail
		if text := output.String(); text != "" {
			wrapped += "\n\nPartial output:\n" + text
		}
		wrapped += "\n\nTranscript: " + transcriptPath
		return "", fmt.Errorf("%s: %w", wrapped, runErr)
	}
	return NoOutputMarker, nil
}

// spawnResult carries a successful spawn output through the error channel so
// the shared teardown path stays single-exit.
type spawnResult struct{ text string }

func (r *spawnResult) Error() string { return r.text }
