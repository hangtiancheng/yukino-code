package workflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/logger"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/worktree"
)

var backendLog = logger.CreateChildLogger("workflow-backend")

var fencedJSONRe = regexp.MustCompile("(?s)```[\\w-]*\\s*\\n([\\s\\S]*?)\\n?```")

// ExtractStructuredOutput parses the JSON value the agent produced: the whole
// text, then fenced blocks, then balanced brace/bracket spans, preferring the
// last candidate.
func ExtractStructuredOutput(text string) (any, error) {
	var value any
	if err := json.Unmarshal([]byte(text), &value); err == nil {
		return value, nil
	}
	var candidates []string
	for _, match := range fencedJSONRe.FindAllStringSubmatch(text, -1) {
		candidates = append(candidates, match[1])
	}
	for start := 0; start < len(text); start++ {
		if text[start] != '{' && text[start] != '[' {
			continue
		}
		var stack []byte
		quoted := false
		for end := start; end < len(text); end++ {
			ch := text[end]
			if quoted {
				if ch == '\\' {
					end++
				} else if ch == '"' {
					quoted = false
				}
				continue
			}
			switch ch {
			case '"':
				quoted = true
			case '{', '[':
				stack = append(stack, ch)
			case '}', ']':
				expected := byte('{')
				if ch == ']' {
					expected = '['
				}
				if len(stack) == 0 || stack[len(stack)-1] != expected {
					end = len(text)
					break
				}
				stack = stack[:len(stack)-1]
				if len(stack) == 0 {
					candidates = append(candidates, text[start:end+1])
					start = end
					end = len(text)
				}
			}
		}
	}
	for i := len(candidates) - 1; i >= 0; i-- {
		if err := json.Unmarshal([]byte(candidates[i]), &value); err == nil {
			return value, nil
		}
	}
	return nil, errors.New("Workflow agent produced no valid JSON output")
}

// YukinoWorkflowHost carries the launching tool execution context into the
// backend adapter.
type YukinoWorkflowHost struct {
	Context context.Context
}

// WorkflowBackendOptions wires the yukino agent stack into the adapter.
type WorkflowBackendOptions struct {
	Registry    *tools.Registry
	GetClient   func() llm.Client
	GetProvider func() *config.ProviderConfig
}

type yukinoBackend struct {
	options WorkflowBackendOptions
}

// CreateYukinoBackend builds the default agent adapter, mirroring
// createYukinoBackend.
func CreateYukinoBackend(options WorkflowBackendOptions) AgentAdapter {
	return &yukinoBackend{options: options}
}

func (b *yukinoBackend) ID() string { return "yukino" }

func (b *yukinoBackend) Capabilities() AgentAdapterCapabilities {
	return AgentAdapterCapabilities{StructuredOutput: true, Tools: true}
}

func (b *yukinoBackend) Initialize() error { return nil }

func (b *yukinoBackend) Dispose() error { return nil }

func (b *yukinoBackend) Run(params *AgentRunParams, ctx *AgentAdapterContext) (result AgentRunResult, retErr error) {
	host, ok := UnwrapHostHandle(ctx.Host).(*YukinoWorkflowHost)
	if !ok {
		return result, errors.New("Invalid Yukino workflow host")
	}
	provider := b.options.GetProvider()
	client := b.options.GetClient()

	loader := subagent.NewAgentLoader()
	_ = loader.LoadAll()
	definition := loader.Get(params.AgentType)
	if definition == nil {
		builtin := subagent.BuiltinSpecs[subagent.GeneralPurposeAgentType]
		definition = &subagent.AgentDefinition{
			AgentType:       builtin.Name,
			WhenToUse:       builtin.Description,
			Tools:           builtin.Tools,
			DisallowedTools: builtin.DisallowedTools,
			SystemPrompt:    builtin.SystemPromptOverride,
			MaxTurns:        builtin.MaxTurns,
			Model:           builtin.Model,
			PermissionMode:  builtin.PermissionMode,
			ReadOnly:        builtin.ReadOnly,
			Source:          "built-in",
		}
	}

	execution, _ := tools.RuntimeContext(host.Context)
	cwd := execution.WorkDir
	if cwd == "" {
		cwd = "."
	}
	checker := (*permissions.Checker)(nil)
	if execution.Plan != nil {
		checker, _ = execution.Plan.Owner.(*permissions.Checker)
	}
	if checker == nil {
		checker = permissions.NewChecker(permissions.NewPathSandbox(cwd, true), permissions.NewRuleEngine(cwd), permissions.ModeDefault)
	}

	var wt *worktree.WorktreeResult
	defer func() {
		if wt == nil {
			return
		}
		if !worktree.HasWorktreeChanges(context.Background(), wt.WorktreePath, wt.HeadCommit) {
			if err := worktree.RemoveAgentWorktree(context.Background(), wt.WorktreePath, wt.WorktreeBranch, wt.GitRoot, false); err != nil {
				backendLog.Warn(map[string]any{"path": wt.WorktreePath}, "workflow worktree cleanup failed")
			}
		} else {
			backendLog.Info(map[string]any{"path": wt.WorktreePath, "branch": wt.WorktreeBranch}, "workflow worktree retained")
		}
	}()

	if err := ctx.Ctx.Err(); err != nil {
		return result, err
	}
	if params.Isolation == "worktree" {
		created, err := worktree.CreateAgentWorktree(ctx.Ctx, fmt.Sprintf("wf_%s_%d", ctx.RunID, ctx.AgentID), "", cwd)
		if err != nil {
			return DeadResult("worktree-failed", ErrorString(err)), nil
		}
		wt = created
	}

	registry := subagent.FilterToolsForAgent(b.options.Registry, params.AllowedTools, nil, true)
	defer registry.Dispose()

	promptParts := []string{}
	if wt != nil {
		promptParts = append(promptParts, worktree.BuildWorktreeNotice(cwd, wt.WorktreePath))
	}
	if params.Schema != nil {
		schemaJSON := params.SchemaRaw
		if schemaJSON == "" {
			schemaJSON = SchemaJSON(params.Schema)
		}
		promptParts = append(promptParts, BuildStructuredOutputPrompt(params.Prompt, schemaJSON))
	} else {
		promptParts = append(promptParts, params.Prompt)
	}
	promptText := strings.Join(promptParts, "\n\n")

	outputTokens := 0
	tokenCount := 0
	toolCount := 0
	onEvent := func(event subagent.SubagentProgressEvent) {
		if event.Type == "usage" && event.Usage != nil {
			outputTokens += event.Usage.OutputTokens
			tokenCount = event.Usage.InputTokens + event.Usage.OutputTokens
		}
		if event.Type == "tool_use" {
			toolCount++
		}
		if ctx.OnProgress != nil {
			ctx.OnProgress(AgentProgressUpdate{TokenCount: tokenCount, ToolCount: toolCount})
		}
	}

	spawnCtx, cancel := context.WithCancel(ctx.Ctx)
	defer cancel()
	spawnCtx = tools.WithExecutionContext(spawnCtx, execution)
	runCwd := cwd
	runChecker := checker
	if wt != nil {
		runCwd = wt.WorktreePath
		var err error
		runChecker, err = checker.ForWorktree(ctx.Ctx, *wt)
		if err != nil {
			return DeadResult("worktree-failed", ErrorString(err)), nil
		}
	}
	output, err := subagent.SpawnSubagent(spawnCtx, definition, promptText, client, registry, provider, runCwd, nil, onEvent, params.Model, runChecker, subagent.SubagentRunOptions{
		Background:      true,
		MaxOutputTokens: params.MaxTokens,
	})
	if err != nil {
		return result, err
	}
	if err := ctx.Ctx.Err(); err != nil {
		return result, err
	}

	var value any = output
	if params.Schema != nil {
		extracted, extractErr := ExtractStructuredOutput(output)
		if extractErr != nil {
			return DeadResult("no-structured-output", ErrorString(extractErr)), nil
		}
		value = extracted
	}
	model := params.Model
	if model == "" {
		model = definition.Model
	}
	if model == "" && provider != nil {
		model = provider.Model
	}
	return OkResult(value, outputTokens, tokenCount, toolCount, model), nil
}
