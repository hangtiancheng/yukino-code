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

package subagent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/hangtiancheng/yukino-code/yukino/agent"
	"github.com/hangtiancheng/yukino-code/yukino/config"
	"github.com/hangtiancheng/yukino-code/yukino/conversation"
	"github.com/hangtiancheng/yukino-code/yukino/llm"
	"github.com/hangtiancheng/yukino-code/yukino/logger"
	"github.com/hangtiancheng/yukino-code/yukino/memory"
	"github.com/hangtiancheng/yukino-code/yukino/permissions"
	promptbuild "github.com/hangtiancheng/yukino-code/yukino/prompt"
	"github.com/hangtiancheng/yukino-code/yukino/teams"
	"github.com/hangtiancheng/yukino-code/yukino/tools"
	"github.com/hangtiancheng/yukino-code/yukino/utils"
	"github.com/hangtiancheng/yukino-code/yukino/worktree"
)

// log mirrors the TS module-scoped child logger
// (createChildLogger({module:"subagent"})).
var log = logger.CreateChildLogger("subagent")

const ForkBoilerplateTag = "<fork_boilerplate>"

var teammateNameWhitespace = regexp.MustCompile(`\s+`)

// teammateNameFromDescription mirrors the TS teammate name derivation
// (agent-tool.ts:433-436): whitespace runs collapse to dashes, the result is
// lowercased and capped at 30 UTF-16 code units.
func teammateNameFromDescription(description string) string {
	name := strings.ToLower(teammateNameWhitespace.ReplaceAllString(description, "-"))
	return utils.TruncateUTF16(name, 30)
}

// ForkAgentType is the type name for fork sub-agents; it is embedded in
// QuerySource to identify conversations that were forked.
const ForkAgentType = "fork"

// GeneralPurposeAgentType is the fallback target when subagent_type is omitted
// while forking is disabled.
const GeneralPurposeAgentType = "general-purpose"

// ForkQuerySource is the origin marker for fork sub-agents, of the form
// `agent:builtin:fork`. It is the primary signal for detecting "currently
// inside a fork sub-agent"; when unavailable, detection falls back to scanning
// the conversation history for ForkBoilerplateTag.
const ForkQuerySource = "agent:builtin:" + ForkAgentType

type AgentTool struct {
	Client llm.Client
	// ModelResolver builds a fresh client for a subagent (TS spawn.ts
	// createClient): model is an alias or concrete id ("" inherits the base
	// provider's model) and systemPrompt is used verbatim.
	ModelResolver func(model, systemPrompt string) (llm.Client, error)
	Registry      *tools.Registry
	Protocol      string
	TaskMgr       *TaskManager
	Loader        *AgentLoader
	Conversation  *conversation.Manager // parent conversation, needed for Fork
	TeamMgr       *teams.TeamManager    // optional, enables team_name parameter

	// WorkDir is the session working directory sub-agents inherit (TS: the
	// spawner passes its workDir). Sub-agents resolve relative paths and create
	// worktrees against it rather than the server process cwd; worktree
	// isolation overrides it with the worktree path.
	WorkDir string

	// QuerySource identifies the spawning agent for nested-fork detection. Empty for the main thread;
	// set to ForkQuerySource (or "agent:builtin:<type>") when the AgentTool instance lives inside a
	// spawned sub-agent. Compaction-resistant — survives even when the fork boilerplate gets
	// summarized out of conversation history.
	QuerySource string

	// ForkDisabled, when true, makes an omitted subagent_type fall back to the
	// general-purpose agent instead of forking. The "disabled" rather than
	// "enabled" semantics keep the zero value as the default behavior (fork
	// available), so construction sites don't have to set it explicitly.
	ForkDisabled bool

	// ContextWindow / MaxOutputTokens carry the provider budgets into spawned
	// loops (TS spawn.ts: contextWindow: getContextWindow(provider), maxOutput:
	// getMaxOutputTokens(provider)). Zero falls back to the TS defaults (1M
	// window via agent.New, DefaultMaxOutputTokens output).
	ContextWindow   int
	MaxOutputTokens int
}

func (t *AgentTool) Name() string                 { return "Agent" }
func (t *AgentTool) Category() tools.ToolCategory { return tools.CategoryRead }

// Description mirrors the TS tool's `description` field
// (agent-tool.ts:75); the schema carries the longer buildDescription text.
func (t *AgentTool) Description() string {
	return "Launch a subagent to handle complex, multi-step tasks."
}

// buildDescription mirrors the TS schema description (agent-tool.ts
// buildDescription), listing the available roles in definition load order.
func (t *AgentTool) buildDescription() string {
	context := "Omitting subagent_type forks a snapshot of the current conversation."
	if t.ForkDisabled {
		context = "Omitting subagent_type selects general-purpose."
	}
	var roles []string
	if t.Loader != nil {
		for _, name := range t.Loader.ListNames() {
			def := t.Loader.Get(name)
			roles = append(roles, "- "+name+": "+def.WhenToUse)
		}
	} else {
		for _, name := range builtinOrder {
			spec := BuiltinSpecs[name]
			roles = append(roles, "- "+name+": "+spec.Description)
		}
	}
	return `Delegate a bounded task to a subagent. ` + context + ` A named role receives a fresh conversation, so include the goal, relevant files, constraints, whether edits are allowed, and the expected result.

Available roles (pass a role as subagent_type, not as a tool name):
` + strings.Join(roles, "\n") + `

Foreground calls return results inline. With run_in_background=true, the call returns a task ID immediately and the final result arrives through a task notification. Use team_name for persistent teammates and SendMessage for their follow-up assignments. Do not predict results before receiving them.

Launch independent tasks together; avoid concurrent writes to the same files. Review returned evidence and integrate it before reporting completion. Worktree isolation separates edits but does not merge them.`
}

func (t *AgentTool) Schema() map[string]any {
	agentTypes := []string{"general-purpose", "plan", "explore"}
	if t.Loader != nil {
		agentTypes = t.Loader.ListNames()
	}

	subagentTypeDescription := "Agent role. Omit to fork the current conversation snapshot."
	if t.ForkDisabled {
		subagentTypeDescription = "Agent role. Defaults to general-purpose."
	}

	return map[string]any{
		"name":        t.Name(),
		"description": t.buildDescription(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"description": map[string]any{
					"type":        "string",
					"description": "Short description of what the agent will do",
				},
				"prompt": map[string]any{
					"type":        "string",
					"description": "The task for the agent to perform",
				},
				"subagent_type": map[string]any{
					"type":        "string",
					"enum":        agentTypes,
					"description": subagentTypeDescription,
				},
				// Go extension: TS leaves model as a free-form string; the enum
				// lists the resolver aliases while any concrete id still passes
				// through the resolver.
				"model": map[string]any{
					"type":        "string",
					"enum":        []string{"sonnet", "opus", "haiku"},
					"description": "Override the model for this agent.",
				},
				"run_in_background": map[string]any{
					"type":        "boolean",
					"description": "Run this one-shot subagent asynchronously. Returns a task ID immediately and delivers the final result through a task notification.",
					"default":     false,
				},
				"isolation": map[string]any{
					"type": "string",
					"enum": []string{"worktree"},
					"description": "Set to 'worktree' to run the agent in its own Git worktree, so its edits " +
						"cannot collide with the parent or with other agents working in parallel.",
				},
				"plan_mode_required": map[string]any{
					"type": "boolean",
					"description": "Only meaningful together with team_name. When true, the teammate starts in " +
						"plan mode: it can read and investigate but cannot modify anything until it " +
						"submits a plan and you approve it via SendMessage with " +
						"type='plan_approval_response'. Use it for risky or ambiguous tasks where a " +
						"wrong direction would cost a lot of rework.",
				},
				"team_name": map[string]any{
					"type": "string",
					"description": "REQUIRED when creating team members. Spawns the agent as a long-running " +
						"teammate under this team (created via TeamCreate). Unlike regular subagents, " +
						"team members persist after the lead returns and communicate via SendMessage. " +
						"Without team_name the agent runs as a one-shot subagent that blocks and returns inline.",
				},
				// Go extensions (no TS counterpart).
				"name": map[string]any{
					"type":        "string",
					"description": "Name for the agent, enabling SendMessage communication.",
				},
				"mode": map[string]any{
					"type":        "string",
					"enum":        []string{"default", "acceptEdits", "plan", "bypassPermissions"},
					"description": "Permission mode override for the spawned agent (e.g., 'plan' to require plan approval).",
				},
			},
			"required": []string{"description", "prompt"},
		},
	}
}

func (t *AgentTool) selectClient(specModel, overrideModel, systemPromptOverride, workDir string) (llm.Client, bool) {
	model := overrideModel
	if model == "" {
		model = specModel
	}
	if (model == "" || model == "inherit") && systemPromptOverride == "" {
		return t.Client, false
	}
	if t.ModelResolver == nil {
		return t.Client, false
	}
	effective := model
	if effective == "inherit" {
		effective = ""
	}
	// TS spawn.ts:103-112 — the fresh client's system prompt is the
	// definition's override, else the standard buildSystemPrompt with the
	// resolved model in the environment.
	systemPrompt := systemPromptOverride
	if systemPrompt == "" {
		env := promptbuild.DetectEnvironment(workDir)
		if effective != "" {
			env.Model = llm.ResolveModelId(effective)
		}
		systemPrompt = promptbuild.BuildSystemPrompt(env)
	}
	if c, err := t.ModelResolver(effective, systemPrompt); err == nil {
		// TS spawn.ts:108 — the fresh provider carries the parent client's
		// runtime thinking level (`parentClient.getThinkingLevel?.() ??
		// parentProvider.thinking`), so a mid-session level change reaches
		// subagents too.
		if t.Client != nil && c != t.Client {
			c.SetThinkingLevel(t.Client.GetThinkingLevel())
		}
		return c, systemPromptOverride != ""
	}
	return t.Client, false
}

// applyBudgets mirrors the TS spawn.ts provider budgets (getContextWindow /
// getMaxOutputTokens) on a spawned loop.
func (t *AgentTool) applyBudgets(ag *agent.Agent) {
	if t.ContextWindow > 0 {
		ag.ContextWindow = t.ContextWindow
	}
	maxOutput := t.MaxOutputTokens
	if maxOutput <= 0 {
		maxOutput = config.DefaultMaxOutputTokens
	}
	if ag.ContextWindow > 0 && maxOutput > ag.ContextWindow {
		maxOutput = ag.ContextWindow
	}
	ag.MaxOutputTokens = maxOutput
}

func (t *AgentTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	description := utils.StrArg(args, "description")
	prompt := utils.StrArg(args, "prompt")
	if description == "" || prompt == "" {
		return tools.ToolResult{Output: "Error: description and prompt are required", IsError: true}
	}

	subagentType := utils.StrArg(args, "subagent_type")
	if subagentType == "" && t.ForkDisabled {
		subagentType = GeneralPurposeAgentType
	}
	modelOverride := utils.StrArg(args, "model")
	runInBackground := utils.BoolArg(args, "run_in_background")
	agentName := utils.StrArg(args, "name")
	teamName := utils.StrArg(args, "team_name")
	modeOverride := utils.StrArg(args, "mode")
	isolation := utils.StrArg(args, "isolation")
	planModeRequired, _ := args["plan_mode_required"].(bool)

	if modeOverride != "" && !validPermissionModes[modeOverride] {
		return tools.ToolResult{
			Output:  fmt.Sprintf("Error: invalid mode '%s'. Valid: default, acceptEdits, plan, bypassPermissions", modeOverride),
			IsError: true,
		}
	}

	// Team-member path: team_name takes precedence over fork/subagent (TS
	// agent-tool.ts:282-291). Runs the agent as a persistent teammate; the
	// lead coordinates through SendMessage / mailbox notifications.
	if teamName != "" && t.TeamMgr != nil {
		return t.runAsTeammate(ctx, teamName, agentName, description, prompt, modelOverride, subagentType, isolation, planModeRequired)
	}

	// Fork path: no subagent_type specified. A fork blocks and returns its
	// output inline by default; only run_in_background=true detaches it into a
	// background task (TS agent-tool.ts:294-315).
	if subagentType == "" {
		isolate := isolation == "worktree"
		if runInBackground && t.Conversation != nil {
			return t.runForkBackground(ctx, description, prompt, modelOverride, isolate)
		}
		return t.runFork(ctx, description, prompt, modelOverride, isolate)
	}

	// Definition path: resolve spec from loader or builtins.
	var spec SubAgentSpec
	if t.Loader != nil {
		def := t.Loader.Get(subagentType)
		if def == nil {
			return tools.ToolResult{
				Output:  fmt.Sprintf("Error: unknown agent type '%s'. Available: %s", subagentType, strings.Join(t.Loader.ListNames(), ", ")),
				IsError: true,
			}
		}
		spec = def.ToSpec()
	} else {
		s, ok := BuiltinSpecs[subagentType]
		if !ok {
			return tools.ToolResult{
				Output:  fmt.Sprintf("Error: unknown agent type '%s'. Available: general-purpose, plan, explore", subagentType),
				IsError: true,
			}
		}
		spec = s
	}

	// Per-call mode override beats the definition's permissionMode (Go
	// extension; TS has no mode parameter).
	if modeOverride != "" {
		spec.PermissionMode = modeOverride
	}

	// Worktree isolation: provision a separate working copy for the child
	// agent; its changes land on its own branch and cannot collide with the
	// parent or other parallel child agents (TS agent-tool.ts:326-343). The
	// worktree is created once here and shared by the inline and background
	// paths.
	effectivePrompt := prompt
	workDir := t.WorkDir
	worktreePath := ""
	if isolation == "worktree" || spec.Isolation == IsolationWorktree {
		wt, err := worktree.CreateAgentWorktree(ctx, t.WorkDir, generateAgentSlug(description))
		if err != nil {
			return tools.ToolResult{
				Output:  fmt.Sprintf("Error creating agent worktree: %s", err),
				IsError: true,
			}
		}
		workDir = wt.WorktreePath
		worktreePath = wt.WorktreePath
		parentCwd := t.WorkDir
		if parentCwd == "" {
			parentCwd, _ = os.Getwd()
		}
		effectivePrompt = worktree.BuildWorktreeNotice(parentCwd, wt.WorktreePath) + "\n\n" + prompt
	}

	run := func(runCtx context.Context) tools.ToolResult {
		return t.runSync(runCtx, spec, effectivePrompt, modelOverride, workDir, worktreePath, runInBackground || spec.Background)
	}
	if runInBackground {
		return t.startBackground(description, ctx, run)
	}
	return run(ctx)
}

// startBackground registers the runner as a background task named after the
// tool's description argument (TS agent-tool.ts startBackground). The result
// arrives as a task notification; a failing runner surfaces its output wrapped
// as "Error: <output>" like the TS task-manager catch branch.
func (t *AgentTool) startBackground(description string, ctx context.Context, runner func(runCtx context.Context) tools.ToolResult) tools.ToolResult {
	taskID := t.TaskMgr.CreateTask(description, tools.BackgroundTaskOptions{
		OriginToolCallID: tools.ToolCallIDFromContext(ctx),
	})
	// TS startBackground hands the runner a fresh AbortController detached
	// from the spawn-time signal: a parent-turn abort must not kill a running
	// background agent — only an explicit task stop does. WithoutCancel keeps
	// the tool-context values while dropping the parent's cancellation.
	runCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	t.TaskMgr.SetRunning(taskID, cancel)

	go func() {
		result := runner(runCtx)
		if result.IsError {
			// TS: throw new Error(result.output) → task-manager catch → "Error: <output>".
			t.TaskMgr.SetFailed(taskID, "Error: "+result.Output)
			return
		}
		t.TaskMgr.SetCompleted(taskID, result.Output)
	}()

	return tools.ToolResult{
		Output: fmt.Sprintf(
			"Background agent '%s' started (task_id: %s). Its result will arrive as a task notification.",
			description, taskID,
		),
	}
}

// runSpec executes one definition-based subagent run and returns the TS
// spawnSubagent result string — raw output, the "[No output]" fallback, or the
// interrupted marker — or the agent error (TS: `case "error": throw
// event.error`).
func (t *AgentTool) runSpec(ctx context.Context, spec SubAgentSpec, taskPrompt, modelOverride, workDir, worktreePath string, isAsync bool) (string, error) {
	// TS spawn.ts:94 — options.abortSignal?.throwIfAborted(): a spawn whose
	// signal is already aborted fails before any work with the Node AbortError
	// message (rendered by the caller as `Agent error: This operation was
	// aborted`).
	if ctx.Err() != nil {
		return "", errAborted
	}
	client, overrideApplied := t.selectClient(spec.Model, modelOverride, spec.SystemPromptOverride, workDir)
	subRegistry := FilterToolsForAgent(t.Registry, spec.Tools, spec.DisallowedTools, isAsync)

	subAgent := agent.New(client, subRegistry, t.Protocol)
	subAgent.WorkDir = workDir
	// TS spawn.ts:154 — every spawned run gets a fresh file state cache, so a
	// subagent's read-before-edit gate never shares (or pollutes) the parent's.
	subAgent.FileStateCache = tools.NewFileStateCache()
	// TS spawn.ts:131 + agent-tool.ts:330-369 — with a parent checker the
	// worktree path gets the forWorkDir clone and the plain path shares the
	// parent instance; without one a fresh checker is created (definition
	// permissionMode, acceptEdits default).
	subAgent.Checker = checkerForSpawn(ctx, workDir, worktreePath, spec.PermissionMode)
	// TS spawn.ts options.onPermissionRequest: the run inherits the parent
	// loop's approval path from the tool context; without one the run is
	// handler-less and asks settle with the TS no-handler message.
	if h := permissions.RequestHandlerFromContext(ctx); h != nil {
		subAgent.OnPermissionRequest = h
	} else {
		subAgent.PermissionsHeadless = true
	}
	if spec.MaxTurns > 0 {
		subAgent.MaxIterations = spec.MaxTurns
	} else {
		subAgent.MaxIterations = 200
	}
	t.applyBudgets(subAgent)
	// TS spawn.ts:154 — the subagent loads the project instructions of its
	// effective working directory (the worktree override wins, matching the TS
	// spawnHandler's workDirOverride ?? workDir).
	subAgent.Instructions = memory.LoadInstructions(workDir)
	// Per-run background task registry (TS spawn.ts:141): shells backgrounded
	// inside this run register here and notify this run's own loop.
	runMgr := attachPerRunTaskManager(subAgent)

	conv := conversation.NewManager()
	// TS spawn.ts:133 — every subagent session opens with the role
	// instructions built from its definition (prompt/delegation.ts
	// buildSubagentInstructions); the definition's initialPrompt is a
	// paragraph of that reminder, not a separate user message.
	conv.AddSystemReminder(promptbuild.BuildSubagentInstructions(spec.Name, spec.Description, spec.InitialPrompt))
	if spec.SystemPromptOverride != "" && !overrideApplied {
		// Degraded fallback: without a client factory the override cannot
		// replace the system prompt (TS spawn.ts:103-112), so it rides along
		// as a system reminder instead.
		conv.AddSystemReminder(spec.SystemPromptOverride)
	}
	conv.AddUserMessage(taskPrompt)

	var output strings.Builder
	interrupted := false
	ch := subAgent.Run(ctx, conv)
	for ev := range ch {
		switch e := ev.(type) {
		case agent.StreamText:
			output.WriteString(e.Text)
		case agent.ErrorEvent:
			runMgr.StopAll()
			return "", errors.New(e.Message)
		case agent.LoopComplete:
			if e.StopReason == "interrupted" {
				interrupted = true
			}
		}
	}
	// TS spawn.ts:217 — the run's background shells are stopped when the
	// loop settles.
	runMgr.StopAll()

	if interrupted {
		// TS spawn.ts:200-202 — the marker rides with the accumulated output
		// (separator only when there is output to separate).
		out := output.String()
		if out != "" {
			out += "\n\n"
		}
		return out + SubagentInterruptedMarker, nil
	}
	if output.Len() == 0 {
		return "[No output]", nil
	}
	return output.String(), nil
}

// runSync runs a definition spawn inline (TS: `background ? startBackground :
// run(ctx)` with run() calling the spawnHandler) and shapes the result like
// the TS run() closure: raw output plus the worktree-retention suffix on
// success, "Agent error: ..." plus the single-newline note on failure. The
// isolated worktree is always retained for later integration.
func (t *AgentTool) runSync(ctx context.Context, spec SubAgentSpec, taskPrompt, modelOverride, workDir, worktreePath string, isAsync bool) tools.ToolResult {
	output, err := t.runSpec(ctx, spec, taskPrompt, modelOverride, workDir, worktreePath, isAsync)
	if err != nil {
		return tools.ToolResult{
			Output:  "Agent error: " + err.Error() + retainedWorktreeNote(worktreePath),
			IsError: true,
		}
	}
	if worktreePath != "" {
		output += "\n\nWorktree retained at: " + worktreePath
	}
	return tools.ToolResult{Output: output}
}

// errAborted mirrors the Node AbortError message thrown by
// signal.throwIfAborted() (TS spawn.ts:94, agent-tool.ts:573).
var errAborted = errors.New("This operation was aborted")

// errNestedFork is the TS nested-fork guard message (agent-tool.ts:552-566).
var errNestedFork = errors.New("cannot fork from a forked agent. Use subagent_type to spawn a definition-based agent instead.")

// forkGuard runs the TS runFork pre-try guard checks; their failures render
// with the plain `Error: ` prefix instead of the try/catch `Fork error: `
// shape. Two layers of nested-fork detection:
// (1) Primary: querySource — set on the AgentTool instance when it's constructed inside a fork
//
//	child. Compaction-resistant; catches the case where conversation history was rewritten or
//	summarized.
//
// (2) Fallback: message scan for ForkBoilerplateTag.
func (t *AgentTool) forkGuard() error {
	if t.Conversation == nil {
		return errors.New("fork requires parent conversation context")
	}
	if t.QuerySource == ForkQuerySource {
		return errNestedFork
	}
	for _, msg := range t.Conversation.GetMessages() {
		if strings.Contains(msg.Content, ForkBoilerplateTag) {
			return errNestedFork
		}
	}
	return nil
}

// prepareFork builds the forked conversation, client, registry and agent
// shared by the foreground and background fork paths (the TS runFork try
// block: throwIfAborted, createAgentWorktree, cloneRegistryForFork, the
// conversation snapshot and the forkHandler setup). Errors from this phase
// render as `Fork error: <msg>`. A non-nil snapshot is the conversation copy
// taken at call time (TS: `const snapshot = this.conversation.fork()`
// precedes startBackground); nil forks the live conversation.
func (t *AgentTool) prepareFork(ctx context.Context, prompt, modelOverride string, isolate bool, snapshot *conversation.Manager) (*conversation.Manager, *agent.Agent, *TaskManager, string, error) {
	// Worktree isolation (TS runFork: isolate → throwIfAborted,
	// createAgentWorktree, notice, workDir + permission checker re-rooted).
	workDir := t.WorkDir
	worktreePath := ""
	if isolate {
		if ctx.Err() != nil {
			return nil, nil, nil, "", errAborted
		}
		wtResult, err := worktree.CreateAgentWorktree(ctx, t.WorkDir, generateAgentSlug(prompt))
		if err != nil {
			// TS: the raw createAgentWorktree throw lands in the runFork catch
			// (`Fork error: <msg>`) — no extra prefix.
			return nil, nil, nil, worktreePath, err
		}
		worktreePath = wtResult.WorktreePath
		workDir = wtResult.WorktreePath
		parentCwd := t.WorkDir
		if parentCwd == "" {
			parentCwd, _ = os.Getwd()
		}
		prompt = worktree.BuildWorktreeNotice(parentCwd, wtResult.WorktreePath) + "\n\n" + prompt
	}

	// Build forked conversation: copy parent messages + patch incomplete tool_use + append task.
	// The background path passes the snapshot taken synchronously at call time
	// (TS: conversation.fork() precedes startBackground), so a fork sees the
	// conversation as it was when the tool was invoked.
	base := snapshot
	if base == nil {
		base = t.Conversation.Fork()
	}
	forkedConv := buildForkedConversation(base, prompt)

	client, _ := t.selectClient("", modelOverride, "", workDir)
	// The fork inherits the parent agent's tool pool verbatim so the outgoing
	// request prefix is byte-identical to the parent's and prompt cache hits
	// still land. Within that pool, the Agent tool is swapped for a shallow copy
	// with QuerySource=ForkQuerySource, so any further fork attempt is rejected
	// by the primary check in prepareFork.
	subRegistry := cloneRegistryForFork(t.Registry)

	subAgent := agent.New(client, subRegistry, t.Protocol)
	subAgent.WorkDir = workDir
	subAgent.FileStateCache = tools.NewFileStateCache()
	// TS runFork + the host fork handler: the worktree path forWorkDir-clones
	// the parent checker, the plain path shares it, and without a parent a
	// fresh acceptEdits checker is created at the fork's workDir.
	subAgent.Checker = checkerForSpawn(ctx, workDir, worktreePath, "")
	// TS runFork passes the tool context through to the fork handler, whose
	// onPermissionRequest the forked loop inherits; without one the fork is
	// handler-less like TS.
	if h := permissions.RequestHandlerFromContext(ctx); h != nil {
		subAgent.OnPermissionRequest = h
	} else {
		subAgent.PermissionsHeadless = true
	}
	t.applyBudgets(subAgent)
	subAgent.Instructions = memory.LoadInstructions(workDir)
	subAgent.MaxIterations = 200
	// Per-run background task registry (TS spawn.ts:141): the fork's
	// backgrounded shells notify the fork's own loop; the runner must StopAll
	// when the fork settles.
	runMgr := attachPerRunTaskManager(subAgent)

	return forkedConv, subAgent, runMgr, worktreePath, nil
}

// runFork executes a fork in the foreground and blocks until the forked agent
// completes, returning its output inline (TS agent-tool.ts:308-314 — this is
// the default; only run_in_background=true detaches the fork into a task).
func (t *AgentTool) runFork(ctx context.Context, description, prompt, modelOverride string, isolate bool) tools.ToolResult {
	if err := t.forkGuard(); err != nil {
		return tools.ToolResult{Output: "Error: " + err.Error(), IsError: true}
	}
	return t.runForkTry(ctx, description, prompt, modelOverride, isolate, nil)
}

// runForkTry is the TS runFork try/catch body shared by the foreground and
// background paths: prepare + drain, with thrown failures logged and rendered
// as `Fork error: <msg>` plus the worktree-retention note.
func (t *AgentTool) runForkTry(ctx context.Context, description, prompt, modelOverride string, isolate bool, snapshot *conversation.Manager) tools.ToolResult {
	forkedConv, subAgent, runMgr, worktreePath, err := t.prepareFork(ctx, prompt, modelOverride, isolate, snapshot)
	if err != nil {
		// TS runFork catch: log.error({err}, "subagent operation failed") then
		// `Fork error: ${asErrorString(err)}` + the retained-worktree note.
		log.Error("subagent operation failed", "err", err)
		return tools.ToolResult{
			Output:  "Fork error: " + err.Error() + retainedWorktreeNote(worktreePath),
			IsError: true,
		}
	}
	return t.drainFork(forkedConv, subAgent, runMgr, worktreePath, description, ctx)
}

// retainedWorktreeNote mirrors the TS runFork suffix; TS always retains the
// isolated worktree for later integration.
func retainedWorktreeNote(path string) string {
	if path == "" {
		return ""
	}
	return "\nWorktree retained at: " + path
}

// runForkBackground registers the fork as a background task and returns the
// task id immediately; the result arrives as a task notification (TS
// agent-tool.ts:295-307 — background && fork → snapshot, then
// startBackground(runFork)).
func (t *AgentTool) runForkBackground(ctx context.Context, description, prompt, modelOverride string, isolate bool) tools.ToolResult {
	// TS takes the conversation snapshot synchronously, before startBackground,
	// so the fork sees the conversation as of the tool call.
	snapshot := t.Conversation.Fork()
	return t.startBackground(description, ctx, func(runCtx context.Context) tools.ToolResult {
		if err := t.forkGuard(); err != nil {
			return tools.ToolResult{Output: "Error: " + err.Error(), IsError: true}
		}
		return t.runForkTry(runCtx, description, prompt, modelOverride, isolate, snapshot)
	})
}

// drainFork consumes a forked agent's event stream and shapes the TS runFork +
// host forkHandler result. Like the TS forkHandler, a loop error event is not
// thrown: it renders inside the normal `Forked agent "<description>":` wrapper
// (`Error: <msg>` alone, or the accumulated output plus `\n\n[Error: <msg>]`)
// and the call itself succeeds.
func (t *AgentTool) drainFork(forkedConv *conversation.Manager, subAgent *agent.Agent, runMgr *TaskManager, worktreePath, description string, ctx context.Context) tools.ToolResult {
	var output strings.Builder
	ch := subAgent.Run(ctx, forkedConv)
	for ev := range ch {
		switch e := ev.(type) {
		case agent.StreamText:
			output.WriteString(e.Text)
		case agent.ErrorEvent:
			runMgr.StopAll()
			return forkedResult(description, worktreePath, forkHandlerError(output.String(), e.Message))
		}
	}
	// TS spawn.ts:217 — the run's background shells are stopped when the
	// loop settles.
	runMgr.StopAll()

	return forkedResult(description, worktreePath, output.String())
}

// forkHandlerError mirrors the TS host forkHandler's error-event rendering:
// `output ? "${output}\n\n[Error: ${msg}]" : "Error: ${msg}"`.
func forkHandlerError(output, msg string) string {
	if output == "" {
		return "Error: " + msg
	}
	return output + "\n\n[Error: " + msg + "]"
}

// forkedResult wraps the forkHandler output like TS runFork
// (`Forked agent "<description>":\n<output>` plus the worktree note, with the
// TS `[No output]` fallback for an empty run).
func forkedResult(description, worktreePath, output string) tools.ToolResult {
	if output == "" {
		output = "[No output]"
	}
	return tools.ToolResult{
		Output: fmt.Sprintf("Forked agent \"%s\":\n%s%s", description, output, retainedWorktreeNote(worktreePath)),
	}
}

// checkerForSpawn mirrors the TS checker selection for a spawned loop
// (remote/server.ts spawnHandler: `workDirOverride ?
// context?.permissionChecker?.forWorkDir(workDirOverride) :
// context?.permissionChecker`, then spawn.ts:131 `checkerOverride ?? new
// PermissionChecker(workDir, permMode)`): the parent checker rides on the tool
// context — with it, a non-worktree spawn shares the parent instance as-is
// (parent mode wins — the definition's permissionMode only applies without an
// override) and a worktree spawn gets the ForWorkDir clone. Without a parent
// checker a fresh checker is created at the effective workDir with the
// definition's permissionMode, defaulting to acceptEdits (subagents are
// headless: there is no UI to answer an Ask).
func checkerForSpawn(ctx context.Context, workDir, worktreePath, specPermMode string) *permissions.Checker {
	parent := permissions.CheckerFromContext(ctx)
	if worktreePath != "" {
		if parent != nil {
			return parent.ForWorkDir(worktreePath)
		}
	} else if parent != nil {
		return parent
	}
	mode := specPermMode
	if mode == "" {
		mode = string(permissions.ModeAcceptEdits)
	}
	return permissions.NewChecker(
		permissions.NewPathSandbox(workDir),
		permissions.NewRuleEngine(workDir),
		permissions.PermissionMode(mode),
	)
}

// cloneRegistryForFork returns a registry that copies the parent verbatim except that any
// *AgentTool instance is replaced with a shallow copy whose QuerySource is set to ForkQuerySource.
// This way the fork child sees tool definitions that are identical to the parent's at the protocol
// level (so prompt cache hits still land), but a further fork attempt is caught at call time by the
// QuerySource check in runFork.
func cloneRegistryForFork(reg *tools.Registry) *tools.Registry {
	forked := tools.NewRegistry()
	// TS tool-filter.ts:204 — the forked registry inherits the loading mode.
	forked.McpLoadingMode = reg.McpLoadingMode
	for _, tool := range reg.ListTools() {
		// Strip main-agent-only tools (ComputerUse, AskUserQuestion, ExitPlanMode):
		// each depends on main-thread UI state or a singleton device, so a fork
		// must not operate them (TS cloneRegistryForFork).
		if MainAgentOnlyTools[tool.Name()] {
			continue
		}
		if at, ok := tool.(*AgentTool); ok {
			clone := *at
			clone.QuerySource = ForkQuerySource
			forked.Register(&clone)
			continue
		}
		forked.Register(tool)
	}
	return forked
}

// forkBoilerplate mirrors the TS FORK_BOILERPLATE (agent-tool.ts:68-71)
// injected into forked child agents.
const forkBoilerplate = ForkBoilerplateTag + `
You are a forked Yukino worker, not the parent agent. The inherited conversation is background context; work only on the assignment that follows.
Do not fork again or ask the user for confirmation. Respect current permissions and report blockers to the parent. Return a concise account of findings or changes, relevant paths, checks actually run, and remaining work.
</fork_boilerplate>`

// buildForkedConversation takes the fork snapshot and appends the fork
// boilerplate + task. The snapshot is a deep copy of the parent (TS:
// conversation.fork()), so the long-term-memory flag and usage anchor survive.
// A dangling tool_use from an interrupted parent turn is patched at request
// time by each llm client's EnsureToolPairing pass, exactly like TS — the
// fork itself does not rewrite history.
func buildForkedConversation(parent *conversation.Manager, task string) *conversation.Manager {
	forked := parent.Fork()

	// Append fork boilerplate + task as user message (TS:
	// `${FORK_BOILERPLATE}\n\nYour task:\n${prompt}`).
	forked.AddUserMessage(forkBoilerplate + "\n\nYour task:\n" + task)
	return forked
}

// runAsTeammate spawns a persistent teammate in the specified team (TS
// agent-tool.ts runAsTeammate). The lead returns immediately and coordinates
// through SendMessage + idle notifications in the team mailbox.
func (t *AgentTool) runAsTeammate(
	ctx context.Context,
	teamName, memberName, description, prompt, modelOverride, subagentType, isolation string,
	planModeRequired bool,
) tools.ToolResult {
	if t.TeamMgr == nil {
		return tools.ToolResult{
			Output:  fmt.Sprintf("Error: team manager '%s' not found.", teamName),
			IsError: true,
		}
	}
	// If the team does not exist, create one on the fly: in coordinator mode
	// TeamCreate is not in the allowlist, so requiring the lead to create a
	// team first would block at step one. Single-team invariant: creating a
	// team sweeps every other team first, matching TeamCreate semantics.
	team := t.TeamMgr.GetTeam(teamName)
	if team == nil {
		t.TeamMgr.DeleteAll()
		team = t.TeamMgr.CreateTeamFull(teamName, teams.LeadName, description)
	}

	// Derive the teammate name from the description and deduplicate (TS
	// agent-tool.ts:433-441). An explicit name is a Go extension; only a live
	// member blocks it (a name restored from config.json has no running agent
	// and is meant to be re-spawned).
	if memberName == "" {
		memberName = teammateNameFromDescription(description)
		base := memberName
		for suffix := 2; team.HasMember(memberName); suffix++ {
			memberName = fmt.Sprintf("%s-%d", base, suffix)
		}
	} else if existing := team.GetMember(memberName); existing != nil && existing.Cancel != nil {
		return tools.ToolResult{
			Output:  fmt.Sprintf("Error: team '%s' already has a member named '%s'", teamName, memberName),
			IsError: true,
		}
	}

	// Resolve spec when subagent_type is set so the teammate respects the same
	// disallow list any other sub-agent of that type would (Go extension; TS
	// ignores subagent_type on the team path). Without a spec the full
	// registry minus the disallow layers is handed to the teammate.
	var spec SubAgentSpec
	if subagentType != "" {
		if t.Loader != nil {
			if def := t.Loader.Get(subagentType); def != nil {
				spec = def.ToSpec()
			}
		} else if s, ok := BuiltinSpecs[subagentType]; ok {
			spec = s
		}
	}

	// Build a teammate-scoped tool registry (TS agent-tool.ts:449-473): the
	// parent registry minus the subagent and teammate disallow layers, then
	// the named SendMessage and the shared team task-board tools (overriding
	// the inherited personal versions so teammates share one task list).
	teammateDisallowed := append(append([]string{}, spec.DisallowedTools...), TeammateDisallowedTools...)
	subRegistry := FilterToolsForAgent(t.Registry, spec.Tools, teammateDisallowed, false)
	subRegistry.Register(&teams.SendMessageTool{TeamMgr: t.TeamMgr, SenderName: memberName})
	subRegistry.Register(&teams.TaskCreateTool{TeamMgr: t.TeamMgr, TeamName: teamName, AgentName: memberName})
	subRegistry.Register(&teams.TaskGetTool{TeamMgr: t.TeamMgr, TeamName: teamName})
	subRegistry.Register(&teams.TaskListTool{TeamMgr: t.TeamMgr, TeamName: teamName})
	subRegistry.Register(&teams.TaskUpdateTool{TeamMgr: t.TeamMgr, TeamName: teamName})

	// Worktree isolation: the teammate works on its own branch; changes are NOT
	// merged automatically — the worktree path is recorded in member metadata
	// (SetMemberMeta below) for the Lead/user to merge manually.
	teammatePrompt := prompt
	memberWorkDir := t.WorkDir
	worktreePath := ""
	if isolation == "worktree" {
		wt, err := worktree.CreateAgentWorktree(ctx, t.WorkDir, generateAgentSlug(description))
		if err != nil {
			return tools.ToolResult{
				Output:  fmt.Sprintf("Error creating teammate worktree: %s", err),
				IsError: true,
			}
		}
		memberWorkDir = wt.WorktreePath
		worktreePath = wt.WorktreePath
		parentCwd := t.WorkDir
		if parentCwd == "" {
			parentCwd, _ = os.Getwd()
		}
		teammatePrompt = worktree.BuildWorktreeNotice(parentCwd, wt.WorktreePath) + "\n\n" + prompt
	}

	// TS spawn.ts client selection: a definition system_prompt or model
	// override produces a fresh client carrying the override as its system
	// prompt; otherwise the parent client is reused.
	client, _ := t.selectClient(spec.Model, modelOverride, spec.SystemPromptOverride, memberWorkDir)

	// The plan-mode teammate requires the checker to be created here: after
	// team-level approval passes, the mode must be switched back to default in
	// place (TS agent-tool.ts:497-499 — a fresh PermissionChecker rooted at
	// the member's effective workDir, never derived from the parent).
	var checker *permissions.Checker
	if planModeRequired {
		checker = permissions.NewChecker(
			permissions.NewPathSandbox(memberWorkDir),
			permissions.NewRuleEngine(memberWorkDir),
			permissions.ModePlan,
		)
	}

	runAgent := t.teammateRunAgent(client, subRegistry, checker, memberWorkDir)
	team.SpawnTeammate(ctx, memberName, teammatePrompt, runAgent, checker, "")
	meta := teams.MemberMeta{AgentType: subagentType, Model: modelOverride}
	if worktreePath != "" {
		meta.WorktreePath = memberWorkDir
	}
	team.SetMemberMeta(memberName, meta)

	out := fmt.Sprintf("Teammate '%s' spawned in team '%s' (mode: %s)", memberName, teamName, team.Mode)
	if planModeRequired {
		out += ", starting in plan mode"
	}
	return tools.ToolResult{Output: out}
}

// teammateRunAgent mirrors the TS teamRunAgentFactory: it produces the
// RunAgent callback that drives a teammate's turns through spawnSubagent with
// the general-purpose definition (TS agent-tool.ts setTeamManager +
// print-mode/remote wiring).
func (t *AgentTool) teammateRunAgent(client llm.Client, registry *tools.Registry, teamChecker *permissions.Checker, workDir string) teams.RunAgent {
	return func(ctx context.Context, task string, onEvent teams.AgentEventCallback) (string, error) {
		return t.runTeammateTurn(ctx, task, client, registry, teamChecker, workDir, onEvent)
	}
}

// runTeammateTurn runs one teammate turn the way TS spawnSubagent does for the
// in-process teammate path: BUILTIN_AGENTS[0] definition, a fresh conversation
// per turn, background tasks disabled (options.backgroundTasks=false), and the
// team-held checker so plan approval can switch the mode in place.
func (t *AgentTool) runTeammateTurn(
	ctx context.Context,
	task string,
	client llm.Client,
	registry *tools.Registry,
	teamChecker *permissions.Checker,
	workDir string,
	onEvent teams.AgentEventCallback,
) (string, error) {
	spec := BuiltinSpecs[GeneralPurposeAgentType]

	conv := conversation.NewManager()
	conv.AddSystemReminder(promptbuild.BuildSubagentInstructions(spec.Name, spec.Description, ""))
	conv.AddUserMessage(task)

	subAgent := agent.New(client, registry, t.Protocol)
	subAgent.WorkDir = workDir
	subAgent.FileStateCache = tools.NewFileStateCache()
	if teamChecker != nil {
		subAgent.Checker = teamChecker
	} else {
		// TS: teammate turns go through spawnSubagent without a checker
		// override, which creates a fresh acceptEdits checker per turn.
		subAgent.Checker = permissions.NewChecker(
			permissions.NewPathSandbox(workDir),
			permissions.NewRuleEngine(workDir),
			permissions.ModeAcceptEdits,
		)
	}
	// TS teamRunAgentFactory passes no onPermissionRequest: teammate turns are
	// handler-less, so asks settle with the no-handler message.
	subAgent.PermissionsHeadless = true
	subAgent.MaxIterations = 200
	t.applyBudgets(subAgent)
	subAgent.Instructions = memory.LoadInstructions(workDir)
	// TS spawn.ts backgroundTasks:false → taskManager null: a teammate loop is
	// one run per task turn, so a turn-end stopAll would immediately kill
	// anything backgrounded; teammates stay purely foreground.
	subAgent.BackgroundTasksDisabled = true

	var output strings.Builder
	interrupted := false
	ch := subAgent.Run(ctx, conv)
	for ev := range ch {
		switch e := ev.(type) {
		case agent.StreamText:
			output.WriteString(e.Text)
		case agent.ToolUseEvent:
			if onEvent != nil {
				onEvent(teams.ProgressEvent{Type: teams.ProgressToolUse, ToolID: e.ToolID, ToolName: e.ToolName, Args: e.Args})
			}
		case agent.ToolResultEvent:
			if onEvent != nil {
				onEvent(teams.ProgressEvent{Type: teams.ProgressToolResult, ToolID: e.ToolID})
			}
		case agent.UsageEvent:
			if onEvent != nil {
				onEvent(teams.ProgressEvent{Type: teams.ProgressUsage, InputTokens: e.InputTokens, OutputTokens: e.OutputTokens})
			}
		case agent.TurnComplete:
			if onEvent != nil {
				onEvent(teams.ProgressEvent{Type: teams.ProgressTurnComplete})
			}
		case agent.ErrorEvent:
			// TS spawn.ts: `case "error": throw event.error` — the team loop's
			// catch turns it into the failed idle notification.
			return "", errors.New(e.Message)
		case agent.LoopComplete:
			if e.StopReason == "interrupted" {
				interrupted = true
			}
		}
	}

	if interrupted {
		out := output.String()
		if out != "" {
			out += "\n\n"
		}
		return out + SubagentInterruptedMarker, nil
	}
	if output.Len() == 0 {
		return "[No output]", nil
	}
	return output.String(), nil
}

// SpawnTeamMember launches a teammate from the SpawnTeammate tool, which only
// carries team/name/task (TS: SpawnTeammateTool's runAgent callback). It reuses
// the Agent team_name path's defaults: the task doubles as the description and
// no model override, subagent type or isolation is applied.
func (t *AgentTool) SpawnTeamMember(team *teams.Team, name, task string) error {
	if team == nil {
		return errors.New("team is required")
	}
	if t.TeamMgr == nil {
		return errors.New("team manager unavailable")
	}
	result := t.runAsTeammate(context.Background(), team.Name, name, task, task, "", "", "", false)
	if result.IsError {
		return errors.New(strings.TrimPrefix(result.Output, "Error: "))
	}
	return nil
}

// generateAgentSlug produces a slug matching ^agent-a[0-9a-f]{7}$ for
// sub-agent worktrees (TS newAgentSlug: random bytes, not the task
// description — spaces and non-ASCII characters in descriptions cannot be
// used directly as branch names).
func generateAgentSlug(description string) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return "agent-a" + hex.EncodeToString(b)[:7]
}
