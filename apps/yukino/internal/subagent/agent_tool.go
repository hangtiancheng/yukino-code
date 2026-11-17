package subagent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/logger"
	"github.com/yukino-js/yukino/yukino/internal/memory"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/prompt"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/teams"
	"github.com/yukino-js/yukino/yukino/internal/tools"
	"github.com/yukino-js/yukino/yukino/internal/worktree"
)

var whitespaceRun = regexp.MustCompile(`\s+`)

type SubAgentProgress struct {
	ToolCallID string
	Role       string
	Background bool
	Event      agent.AgentEvent
	Status     string
	Output     string
}

const GeneralPurposeAgentType = "general-purpose"

type AgentTool struct {
	clientMu      sync.RWMutex
	Client        llm.Client
	Provider      *config.ProviderConfig
	MemoryContent string
	Registry      *tools.Registry
	Protocol      string
	TaskMgr       *TaskManager
	OnProgress    func(SubAgentProgress)
	Loader        *AgentLoader
	Conversation  *conversation.Manager
	TeamMgr       *teams.TeamManager
	ParentChecker *permissions.Checker
}

func (t *AgentTool) SetClient(client llm.Client, provider *config.ProviderConfig) {
	t.clientMu.Lock()
	defer t.clientMu.Unlock()
	t.Client, t.Provider, t.Protocol = client, provider, provider.Protocol
}

func (t *AgentTool) clientSnapshot() (llm.Client, *config.ProviderConfig, string) {
	t.clientMu.RLock()
	defer t.clientMu.RUnlock()
	var provider *config.ProviderConfig
	if t.Provider != nil {
		copy := *t.Provider
		provider = &copy
	}
	return t.Client, provider, t.Protocol
}

func (t *AgentTool) Name() string                          { return "Agent" }
func (t *AgentTool) Category() tools.ToolCategory          { return tools.CategoryCommand }
func (t *AgentTool) IsConcurrencySafe(map[string]any) bool { return true }
func (t *AgentTool) Description() string                   { return AgentToolDescription }
func (t *AgentTool) definitions() []SubAgentSpec {
	var result []SubAgentSpec
	if t.Loader != nil {
		for _, name := range t.Loader.ListNames() {
			result = append(result, t.Loader.Get(name).ToSpec())
		}
		return result
	}
	for _, name := range []string{"general-purpose", "plan", "explore", "review"} {
		result = append(result, BuiltinSpecs[name])
	}
	return result
}
func (t *AgentTool) Schema() map[string]any {
	var names []string
	definitions := t.definitions()
	for _, def := range definitions {
		names = append(names, def.Name)
	}
	return map[string]any{"name": t.Name(), "description": buildAgentToolDescription(definitions), "input_schema": map[string]any{
		"type": "object", "properties": map[string]any{
			"description":       map[string]any{"type": "string", "description": DescriptionParameterDescription},
			"prompt":            map[string]any{"type": "string", "description": PromptParameterDescription},
			"kind":              map[string]any{"type": "string", "enum": []string{"subagent", "teammate"}, "default": "teammate", "description": AgentKindDescription},
			"team_name":         map[string]any{"type": "string", "description": "Target team name returned by TeamCreate or TeamList. Required when multiple teams match; omitted when only one team matches. Teammates are restricted to their own team."},
			"subagent_type":     map[string]any{"type": "string", "enum": names, "default": GeneralPurposeAgentType, "description": SubagentTypeDescription},
			"fork":              map[string]any{"type": "boolean", "default": true, "description": ForkParameterDescription},
			"model":             map[string]any{"type": "string", "description": AgentModelDescription},
			"run_in_background": map[string]any{"type": "boolean", "default": false, "description": AgentBackgroundDescription},
			"worktree":          map[string]any{"type": "boolean", "description": AgentWorktreeDescription},
		}, "required": []string{"description", "prompt"},
	}}
}
func (t *AgentTool) selectClient(spec SubAgentSpec, overrideModel, cwd string) (llm.Client, error) {
	client, provider, _ := t.clientSnapshot()
	return selectClientFor(client, provider, spec, overrideModel, cwd)
}

func selectClientFor(parentClient llm.Client, parentProvider *config.ProviderConfig, spec SubAgentSpec, overrideModel, cwd string) (llm.Client, error) {
	model := overrideModel
	if model == "" {
		model = spec.Model
	}
	if model == "" && spec.SystemPromptOverride == "" {
		return parentClient, nil
	}
	if parentProvider == nil {
		return nil, fmt.Errorf("Agent provider configuration is unavailable.")
	}
	provider := *parentProvider
	if model != "" {
		provider.Model = model
	}
	if control, ok := parentClient.(llm.ThinkingLevelControl); ok {
		provider.Thinking = control.GetThinkingLevel()
	}
	system := spec.SystemPromptOverride
	if system == "" {
		env := prompt.DetectEnvironment(cwd)
		env.Model = provider.Model
		system = prompt.BuildSystemPrompt(env)
	}
	return llm.NewClient(&provider, system)
}
func (t *AgentTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	fail := func(s string) tools.ToolResult { return tools.ToolResult{Output: s, IsError: true} }
	if ctx.Err() != nil {
		return fail(tools.OperationInterruptedError)
	}
	description, _ := args["description"].(string)
	prompt, _ := args["prompt"].(string)
	if description == "" || prompt == "" {
		return fail("Error: description and prompt are required")
	}
	kind := "teammate"
	if value, exists := args["kind"]; exists {
		k, ok := value.(string)
		if !ok || (k != "teammate" && k != "subagent") {
			return fail("Error: kind must be subagent or teammate")
		}
		kind = k
	}
	for _, key := range []string{"worktree", "fork", "run_in_background"} {
		if value, exists := args[key]; exists {
			if _, ok := value.(bool); !ok {
				return fail("Error: " + key + " must be a boolean")
			}
		}
	}
	role, _ := args["subagent_type"].(string)
	if role == "" {
		role = GeneralPurposeAgentType
	}
	var spec *SubAgentSpec
	for _, def := range t.definitions() {
		if def.Name == role {
			copy := def
			spec = &copy
			break
		}
	}
	if spec == nil {
		var names []string
		for _, def := range t.definitions() {
			names = append(names, def.Name)
		}
		return fail(fmt.Sprintf("Error: unknown agent type '%s'. Available: %s", role, strings.Join(names, ", ")))
	}
	fork := true
	if value, exists := args["fork"]; exists {
		fork = value.(bool)
	}
	worktreeIsolation := spec.Worktree
	if value, exists := args["worktree"]; exists {
		worktreeIsolation = value.(bool)
	}
	background := spec.Background
	if value, exists := args["run_in_background"]; exists {
		background = value.(bool)
	}
	model, _ := args["model"].(string)
	if kind == "teammate" {
		name, _ := args["team_name"].(string)
		return t.runAsTeammate(ctx, name, description, prompt, model, *spec, fork, worktreeIsolation)
	}
	return t.runDefinition(ctx, *spec, description, prompt, model, fork, background, worktreeIsolation)
}
func forkConversation(parent *conversation.Manager) (*conversation.Manager, error) {
	if parent == nil {
		return nil, fmt.Errorf("%s", ForkContextRequiredError)
	}
	forked := parent.Fork()
	messages := forked.GetMessages()
	pending := map[string]bool{}
	var order []string
	for _, message := range messages {
		for _, tool := range message.ToolUses {
			if !pending[tool.ToolUseID] {
				order = append(order, tool.ToolUseID)
			}
			pending[tool.ToolUseID] = true
		}
		for _, result := range message.ToolResults {
			delete(pending, result.ToolUseID)
		}
	}
	var results []conversation.ToolResultBlock
	for _, id := range order {
		if pending[id] {
			results = append(results, conversation.ToolResultBlock{ToolUseID: id, Content: InheritedToolResult})
		}
	}
	if len(results) > 0 {
		forked.AddToolResultsMessage(results)
	}
	return forked, nil
}
func (t *AgentTool) RunBuiltin(ctx context.Context, name, prompt string) tools.ToolResult {
	spec, ok := BuiltinSpecs[name]
	if !ok {
		return tools.ToolResult{Output: "Unknown built-in agent: " + name, IsError: true}
	}
	return t.runDefinition(ctx, spec, name, prompt, "", true, false, false)
}
func (t *AgentTool) runDefinition(ctx context.Context, spec SubAgentSpec, description, prompt, model string, fork, background, isolate bool) tools.ToolResult {
	var snapshot *conversation.Manager
	var err error
	if fork {
		snapshot, err = forkConversation(t.Conversation)
		if err != nil {
			return tools.ToolResult{Output: err.Error(), IsError: true}
		}
	}
	checker := t.ParentChecker
	if runtime, ok := tools.RuntimeContext(ctx); ok && runtime.Plan != nil {
		if scoped, ok := runtime.Plan.Owner.(*permissions.Checker); ok {
			checker = scoped
		}
	}
	cwd := ""
	if runtime, ok := tools.RuntimeContext(ctx); ok {
		cwd = runtime.WorkDir
	}
	if cwd == "" && checker != nil {
		cwd = checker.Cwd()
	}
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	if checker == nil {
		checker = permissions.NewChecker(permissions.NewPathSandbox(cwd, true), permissions.NewRuleEngine(cwd), permissions.ModeDefault)
	}
	if isolate {
		wt, err := worktree.CreateAgentWorktree(ctx, generateAgentSlug(description), "", cwd)
		if err != nil {
			return tools.ToolResult{Output: "Error creating agent worktree: " + err.Error(), IsError: true}
		}
		checker, err = checker.ForWorktree(ctx, *wt)
		if err != nil {
			return tools.ToolResult{Output: "Error creating agent worktree: " + err.Error(), IsError: true}
		}
		prompt = worktree.BuildWorktreeNotice(cwd, wt.WorktreePath) + "\n\n" + prompt
		cwd = wt.WorktreePath
	}
	sessionID := session.NewID()
	transcriptPath, _ := storage.SessionPath(sessionID, "transcript.jsonl")
	run := func(runCtx context.Context) tools.ToolResult {
		result := t.runChild(runCtx, spec, description, prompt, model, cwd, snapshot, background, sessionID, transcriptPath, checker)
		if isolate {
			result.Output += "\n\nWorktree retained at: " + cwd
		}
		return result
	}
	if !background {
		return run(ctx)
	}
	manager := t.TaskMgr
	if runtime, ok := tools.RuntimeContext(ctx); ok && runtime.TaskManager != nil {
		if scoped, ok := runtime.TaskManager.(*TaskManager); ok {
			manager = scoped
		}
	}
	if manager == nil {
		return tools.ToolResult{Output: "Background task manager is unavailable.", IsError: true}
	}
	runCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	id, err := manager.Create(description, func(string) (string, error) {
		result := run(runCtx)
		if result.IsError {
			return "", &tools.TaskFailure{Output: result.Output}
		}
		return result.Output, nil
	}, cancel, tools.TaskOptions{OriginToolCallID: originToolCallID(ctx), TranscriptPath: transcriptPath})
	if err != nil {
		cancel()
		return tools.ToolResult{Output: err.Error(), IsError: true}
	}
	return tools.ToolResult{Output: fmt.Sprintf("Background agent '%s' started (task_id: %s). Its result will arrive as a task notification.", description, id)}
}
func (t *AgentTool) runChild(ctx context.Context, spec SubAgentSpec, description, prompt, model, cwd string, snapshot *conversation.Manager, background bool, sessionID, transcriptPath string, checker *permissions.Checker) tools.ToolResult {
	registry := FilterToolsForAgent(t.Registry, spec.Tools, spec.DisallowedTools, background, spec.PermissionMode)
	defer registry.Dispose()
	parentClient, parentProvider, protocol := t.clientSnapshot()
	client, err := selectClientFor(parentClient, parentProvider, spec, model, cwd)
	if err != nil {
		return tools.ToolResult{Output: "Agent error: " + err.Error(), IsError: true}
	}
	child := agent.New(client, registry, protocol)
	child.AgentName = spec.Name
	child.SessionID = sessionID
	child.TranscriptPath = transcriptPath
	child.MemoryContent = t.MemoryContent
	if parentProvider != nil {
		provider := *parentProvider
		if model != "" {
			provider.Model = model
		} else if spec.Model != "" {
			provider.Model = spec.Model
		}
		child.ContextWindow = config.GetContextWindow(&provider)
		child.MaxOutputTokens = config.GetMaxOutputTokens(&provider)
	}
	child.WorkDir = cwd
	child.MaxIterations = spec.MaxTurns
	child.Checker = checker.ForSubagent(cwd, permissions.PermissionMode(spec.PermissionMode))
	child.Checker.ReadOnly = spec.ReadOnly || checker.ReadOnly
	child.Instructions = memory.LoadInstructions(cwd)
	tasks := configureBackgroundRuntime(child)
	defer tasks.StopAll(context.Background())
	if err := tasks.UseSession(sessionID); err != nil {
		return tools.ToolResult{Output: err.Error(), IsError: true}
	}
	conv := snapshot
	if conv == nil {
		conv = conversation.NewManager()
	}
	conv.AddSystemReminder(buildSubagentInstructions(spec))
	conv.AddUserMessage(prompt)
	for _, message := range conv.GetMessages() {
		session.SaveTranscriptMessage(transcriptPath, session.FromConversation(message))
	}
	var output strings.Builder
	submitted := ""
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var runError string
	t.reportProgress(SubAgentProgress{ToolCallID: originToolCallID(ctx), Role: spec.Name, Background: background, Status: "running"})
	for event := range child.Run(runCtx, conv) {
		t.reportProgress(SubAgentProgress{ToolCallID: originToolCallID(ctx), Role: spec.Name, Background: background, Event: event})
		switch e := event.(type) {
		case agent.StreamText:
			output.WriteString(e.Text)
		case agent.PermissionRequestEvent:
			reply := agent.PermissionReply{Response: agent.PermDeny}
			if runtime, ok := tools.RuntimeContext(ctx); ok && runtime.RequestPermission != nil {
				response := runtime.RequestPermission(ctx, tools.PermissionRequest{ToolName: e.ToolName, Desc: e.Desc, AgentName: e.AgentName, Cwd: e.Cwd, ToolCallID: e.ToolID, Args: e.Args, RememberPatterns: e.Decision.RememberPatterns})
				reply = agent.PermissionReply{Response: agent.PermissionResponse(response)}
			}
			e.ResponseCh <- reply
		case agent.ToolResultEvent:
			if e.ToolName == "ExitPlanMode" && !e.IsError {
				submitted = e.Output
			}
		case agent.ErrorEvent:
			runError = e.Message
			cancel()
		}
	}
	status := "completed"
	if runError != "" {
		status = "failed"
	}
	if ctx.Err() != nil {
		status = "stopped"
	}
	finalOutput := output.String()
	if runError != "" {
		finalOutput = "Agent error: " + runError
	}
	t.reportProgress(SubAgentProgress{ToolCallID: originToolCallID(ctx), Role: spec.Name, Background: background, Status: status, Output: finalOutput})
	result := output.String()
	if runError != "" {
		session.SaveTranscriptMessage(transcriptPath, session.Message{Role: "system", Type: "subagent_error", Content: runError, Timestamp: time.Now().Unix()})
		if result != "" {
			runError += "\n\nPartial output:\n" + result
		}
		return tools.ToolResult{Output: "Agent error: " + runError + "\n\nTranscript: " + transcriptPath, IsError: true}
	}
	if submitted != "" {
		if result != "" {
			result += "\n\n"
		}
		result += submitted
	}
	if ctx.Err() != nil {
		if result != "" {
			result += "\n\n"
		}
		return tools.ToolResult{Output: result + "[Interrupted]", IsError: true}
	}
	if result == "" {
		result = "[No output]"
	}
	return tools.ToolResult{Output: result}
}
func deriveSubAgentChecker(parent *permissions.Checker, mode string) *permissions.Checker {
	if parent == nil {
		return nil
	}
	return parent.ForSubagent(parent.Cwd(), permissions.PermissionMode(mode))
}

func (t *AgentTool) reportProgress(p SubAgentProgress) {
	if t.OnProgress != nil {
		t.OnProgress(p)
	}
}

func (t *AgentTool) runAsTeammate(ctx context.Context, targetTeam, description, prompt, model string, spec SubAgentSpec, fork, isolate bool) tools.ToolResult {
	if t.TeamMgr == nil {
		return tools.ToolResult{Output: "Error: teammate execution is unavailable; no team was created.", IsError: true}
	}
	var snapshot *conversation.Manager
	if fork {
		var err error
		snapshot, err = forkConversation(t.Conversation)
		if err != nil {
			return tools.ToolResult{Output: err.Error(), IsError: true}
		}
	}
	team, err := t.TeamMgr.ResolveTeam(targetTeam)
	if err != nil {
		return tools.ToolResult{Output: err.Error(), IsError: true}
	}
	if team == nil {
		team, err = t.TeamMgr.CreateTeam("", teams.LeadName, description)
		if err != nil {
			return tools.ToolResult{Output: err.Error(), IsError: true}
		}
	}
	base := logger.SanitizeNameSegment(strings.ToLower(whitespaceRun.ReplaceAllString(description, "-")))
	if len(base) > MaxTeammateNameChars {
		base = base[:MaxTeammateNameChars]
	}
	memberName := base
	for suffix := 2; memberName == teams.LeadName || team.HasMember(memberName); suffix++ {
		memberName = fmt.Sprintf("%s-%d", base, suffix)
	}
	if _, err := team.AddMember(memberName); err != nil {
		return tools.ToolResult{Output: err.Error(), IsError: true}
	}
	if spec.Name == PlanAgentName && (t.Loader == nil || t.Loader.Get(spec.Name).Source == "built-in") {
		spec = SubAgentSpec{Name: PlanAgentName, Description: PlanTeammateDescription, PermissionMode: "plan"}
	}
	teammatePermissionMode := spec.PermissionMode
	if spec.Name == PlanAgentName {
		teammatePermissionMode = "plan"
	}
	registry := FilterToolsForAgent(CloneRegistryForTeammate(t.Registry, teammatePermissionMode), spec.Tools, spec.DisallowedTools, false, teammatePermissionMode)
	if registry.Get("ExitPlanMode") != nil {
		registry.Register(&tools.ExitPlanModeTool{SubmitTeammatePlan: func(plan string) (string, error) { return team.SubmitPlan(memberName, plan) }, RequiresLeaderApproval: team.RequiresLeaderPlanApproval})
	}
	registry.Register(&teams.SendMessageTool{TeamMgr: t.TeamMgr, SenderName: memberName, TeamName: team.Name})
	registry.Register(&teams.TeamTodoWriteTool{TeamMgr: t.TeamMgr, TeamName: team.Name, AgentName: memberName})
	cwd := team.Cwd
	parent := t.ParentChecker
	if runtime, ok := tools.RuntimeContext(ctx); ok {
		if runtime.WorkDir != "" {
			cwd = runtime.WorkDir
		}
		if runtime.Plan != nil {
			if scoped, ok := runtime.Plan.Owner.(*permissions.Checker); ok {
				parent = scoped
			}
		}
	}
	if parent == nil {
		parent = permissions.NewChecker(permissions.NewPathSandbox(cwd, true), permissions.NewRuleEngine(cwd), permissions.ModeDefault)
	}
	inherited := parent
	if isolate {
		wt, err := worktree.CreateAgentWorktree(ctx, generateAgentSlug(description), "", cwd)
		if err == nil {
			inherited, err = parent.ForWorktree(ctx, *wt)
		}
		if err != nil {
			_ = team.RemoveMember(memberName)
			registry.Dispose()
			return tools.ToolResult{Output: "Error creating teammate worktree: " + err.Error(), IsError: true}
		}
		prompt = worktree.BuildWorktreeNotice(cwd, wt.WorktreePath) + "\n\n" + prompt
		cwd = wt.WorktreePath
	}
	t.TeamMgr.SetPermissionChecker(parent)
	checker := inherited.ForSubagent(cwd, permissions.PermissionMode(teammatePermissionMode))
	checker.Teammate = true
	checker.ReadOnly = spec.ReadOnly
	checker.RequiresLeaderPlanApproval = team.RequiresLeaderPlanApproval
	metaModel := model
	if metaModel == "" {
		metaModel = spec.Model
	}
	spawnErr := func() error {
		definition := specToDefinition(spec)
		// One conversation per spawn shared by every task turn, mirroring the
		// reference factory; SpawnSubagent appends the context snapshot and
		// the definition system reminder on the first turn only.
		teammateConversation := conversation.NewManager()
		backgroundTasks := false
		runAgent := func(runCtx context.Context, task string, onEvent func(teams.TeammateProgressEvent)) (string, error) {
			client, provider, _ := t.clientSnapshot()
			return SpawnSubagent(runCtx, definition, task, client, registry, provider, cwd, nil, func(event SubagentProgressEvent) {
				teammateEvent := teams.TeammateProgressEvent{Type: event.Type, ToolID: event.ToolID, ToolName: event.ToolName, Args: event.Args}
				if event.Usage != nil {
					teammateEvent.InputTokens = event.Usage.InputTokens
					teammateEvent.OutputTokens = event.Usage.OutputTokens
				}
				onEvent(teammateEvent)
			}, model, checker, SubagentRunOptions{Conversation: teammateConversation, ContextSnapshot: snapshot, BackgroundTasks: &backgroundTasks, AgentName: memberName})
		}
		return teams.SpawnTeammate(context.WithoutCancel(ctx), teams.TeammateSpawnConfig{Team: team, MemberName: memberName, Task: prompt, RunAgent: runAgent, Checker: checker, Workdir: cwd, PlanApprovalRequired: spec.Name == PlanAgentName, AgentType: spec.Name, Model: metaModel, OriginToolCallID: originToolCallID(ctx), Cleanup: func() { _ = registry.Dispose() }})
	}()
	if spawnErr != nil {
		if team.MemberActive(memberName) {
			team.StopMember(memberName)
		}
		_ = team.RemoveMember(memberName)
		registry.Dispose()
		output := "Error spawning teammate: " + spawnErr.Error()
		if cwd != team.Cwd {
			output += "\nWorktree retained at: " + cwd
		}
		return tools.ToolResult{Output: output, IsError: true}
	}
	output := fmt.Sprintf("Teammate '%s' spawned in team '%s' (in-process)", memberName, team.Name)
	if checker.Mode() == permissions.ModePlan {
		output += ", starting in plan mode"
	}
	return tools.ToolResult{Output: output}
}

func generateAgentSlug(description string) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return "agent-a" + hex.EncodeToString(b)[:7]
}

func originToolCallID(ctx context.Context) string {
	runtime, _ := tools.RuntimeContext(ctx)
	return runtime.ToolCallID
}
