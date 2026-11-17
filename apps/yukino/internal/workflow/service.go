package workflow

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/yukino-js/yukino/yukino/internal/logger"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

var serviceLog = logger.CreateChildLogger("workflow")

type serviceLogger struct{}

func (serviceLogger) Warn(message string) { serviceLog.Warn(nil, message) }

// WorkflowServiceOptions wires the service into a host registry.
type WorkflowServiceOptions struct {
	WorkflowBackendOptions
	Cwd         string
	TaskManager *subagent.TaskManager
}

type activeRun struct {
	controller context.CancelFunc
	runCtx     context.Context
	mu         sync.Mutex
	agents     map[int]context.CancelFunc
	taskID     string
}

func (r *activeRun) setAgent(id int, cancel context.CancelFunc) {
	r.mu.Lock()
	r.agents[id] = cancel
	r.mu.Unlock()
}

func (r *activeRun) deleteAgent(id int) {
	r.mu.Lock()
	delete(r.agents, id)
	r.mu.Unlock()
}

// WorkflowService launches and manages workflow runs, mirroring
// WorkflowService.
type WorkflowService struct {
	Store       *WorkflowProgressStore
	Persistence *WorkflowPersistence
	options     WorkflowServiceOptions

	mu     sync.Mutex
	closed bool
	active map[string]*activeRun
}

func NewWorkflowService(options WorkflowServiceOptions) *WorkflowService {
	return &WorkflowService{
		Store:       NewWorkflowProgressStore(),
		Persistence: NewWorkflowPersistence(options.Cwd),
		options:     options,
		active:      map[string]*activeRun{},
	}
}

// Launch starts a workflow run in the background and returns its handle.
func (s *WorkflowService) Launch(raw map[string]any, toolCtx context.Context) (*WorkflowLaunch, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, errors.New("Workflow service is closed")
	}
	s.mu.Unlock()

	input, err := ParseWorkflowInput(raw)
	if err != nil {
		return nil, err
	}
	if err := toolCtx.Err(); err != nil {
		return nil, err
	}
	runID := input.ResumeFromRunID
	if runID == "" {
		runID = uuid.NewString()
	}
	s.mu.Lock()
	if _, exists := s.active[runID]; exists {
		s.mu.Unlock()
		return nil, errors.New(WorkflowRunningError)
	}
	runCtx, controller := context.WithCancel(context.Background())
	active := &activeRun{controller: controller, runCtx: runCtx, agents: map[int]context.CancelFunc{}}
	s.active[runID] = active
	s.mu.Unlock()

	launch := func() (*WorkflowLaunch, error) {
		var previous *SavedWorkflow
		if input.ResumeFromRunID != "" {
			previous, err = s.Persistence.ReadRequest(runID)
			if err != nil {
				return nil, err
			}
		}
		source, err := s.resolveSource(input)
		if err != nil {
			return nil, err
		}
		parsed, err := ParseScript(source)
		if err != nil {
			return nil, err
		}
		workflowName := input.Name
		if workflowName == "" {
			workflowName = input.Title
		}
		if workflowName == "" && parsed.Meta != nil && parsed.Meta.Name != "" {
			workflowName = parsed.Meta.Name
		}
		if workflowName == "" && previous != nil {
			workflowName = previous.WorkflowName
		}
		if workflowName == "" {
			workflowName = "workflow"
		}
		var args any
		if input.HasArgs {
			args = input.Args
		} else if previous != nil {
			args = previous.Args
		}
		maxConcurrency := input.MaxConcurrency
		if maxConcurrency == nil && previous != nil {
			maxConcurrency = previous.MaxConcurrency
		}
		scriptPath, err := s.Persistence.SaveRequest(runID, source, &SavedWorkflow{
			WorkflowName:   workflowName,
			Args:           args,
			MaxConcurrency: maxConcurrency,
		})
		if err != nil {
			return nil, err
		}
		if err := toolCtx.Err(); err != nil {
			return nil, err
		}
		if err := runCtx.Err(); err != nil {
			return nil, err
		}

		description := input.Description
		if description == "" {
			description = workflowName
		}
		ready := make(chan struct{})
		execution, _ := tools.RuntimeContext(toolCtx)
		taskID, err := s.options.TaskManager.Create(description, func(string) (string, error) {
			<-ready
			return s.runTask(runID, source, args, workflowName, maxConcurrency, active, toolCtx)
		}, func() {
			controller()
		}, tools.TaskOptions{IDPrefix: "workflow", Kind: "workflow", OriginToolCallID: execution.ToolCallID})
		if err != nil {
			return nil, err
		}
		active.mu.Lock()
		active.taskID = taskID
		active.mu.Unlock()
		startedAt := time.Now().UnixMilli()
		s.Store.Set(&WorkflowRun{
			RunID:        runID,
			TaskID:       taskID,
			WorkflowName: workflowName,
			ScriptPath:   scriptPath,
			Status:       "running",
			StartedAt:    startedAt,
			UpdatedAt:    startedAt,
			Phases:       []WorkflowRunPhase{},
			Agents:       []WorkflowRunAgent{},
			Logs:         []string{},
		})
		close(ready)
		return &WorkflowLaunch{RunID: runID, TaskID: taskID, WorkflowName: workflowName, ScriptPath: scriptPath}, nil
	}
	result, err := launch()
	if err != nil {
		s.mu.Lock()
		delete(s.active, runID)
		s.mu.Unlock()
		controller()
		return nil, err
	}
	return result, nil
}

// runTask is the background task body: it executes the workflow script and
// reports the terminal state through the task result.
func (s *WorkflowService) runTask(runID, source string, args any, workflowName string, maxConcurrency *int, active *activeRun, toolCtx context.Context) (string, error) {
	defer func() {
		s.mu.Lock()
		delete(s.active, runID)
		s.mu.Unlock()
	}()

	run, err := s.requireRun(runID)
	if err != nil {
		return "", &tools.TaskFailure{Output: err.Error()}
	}
	_ = s.Persistence.WriteState(run)

	agentControllers := map[int]context.CancelFunc{}
	ports := WorkflowPorts{
		AgentAdapterRegistry: NewAgentAdapterRegistry().Register(CreateYukinoBackend(s.options.WorkflowBackendOptions)).Default("yukino"),
		ProgressEmitter: EmitterFunc(func(event ProgressEvent) {
			s.Store.Apply(event)
		}),
		JournalStore:     CreateFileJournalStore(s.Persistence.Directory),
		Logger:           serviceLogger{},
		AgentControllers: agentControllers,
	}
	// Mirror controllers into the active run for killAgent.
	go func() {
		seen := map[int]bool{}
		for {
			select {
			case <-active.runCtx.Done():
				return
			case <-time.After(20 * time.Millisecond):
			}
			for id, cancel := range agentControllers {
				if !seen[id] {
					seen[id] = true
					active.setAgent(id, cancel)
				}
			}
		}
	}()

	RunWorkflow(RunWorkflowOptions{
		Script:         source,
		Args:           args,
		RunID:          runID,
		WorkflowName:   workflowName,
		Ports:          ports,
		Host:           CreateHostHandle(&YukinoWorkflowHost{Context: toolCtx}),
		Signal:         active.runCtx,
		Cwd:            s.options.Cwd,
		BudgetTotal:    nil,
		MaxConcurrency: maxConcurrency,
		Resume:         false,
	})

	final, err := s.requireRun(runID)
	if err != nil {
		return "", &tools.TaskFailure{Output: err.Error()}
	}
	output := FormatWorkflowResult(final)
	_ = s.Persistence.WriteState(final)
	if final.Status == "failed" {
		return "", &tools.TaskFailure{Output: output}
	}
	return output, nil
}

func (s *WorkflowService) requireRun(runID string) (*WorkflowRun, error) {
	run := s.Store.Get(runID)
	if run == nil {
		return nil, fmt.Errorf("Workflow run %s not found", runID)
	}
	return run, nil
}

func (s *WorkflowService) resolveSource(input *WorkflowInput) (string, error) {
	if input.Script != "" {
		return input.Script, nil
	}
	if input.Name != "" {
		_, content, ok := ResolveNamedWorkflow(filepath.Join(s.options.Cwd, WorkflowDirName), input.Name)
		if !ok {
			return "", fmt.Errorf("Named workflow %q not found in %s", input.Name, WorkflowDirName)
		}
		return content, nil
	}
	if input.ScriptPath != "" {
		base, err := filepath.EvalSymlinks(s.options.Cwd)
		if err != nil {
			base = s.options.Cwd
		}
		path, err := filepath.EvalSymlinks(filepath.Join(s.options.Cwd, input.ScriptPath))
		if err != nil {
			return "", err
		}
		storageBase, err := filepath.EvalSymlinks(s.Persistence.Directory)
		if err != nil {
			storageBase = s.Persistence.Directory
		}
		if !ContainsPath(base, path) && !ContainsPath(storageBase, path) {
			return "", errors.New("Workflow scriptPath is outside the project and workflow storage")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		return string(data), nil
	}
	if input.ResumeFromRunID == "" {
		return "", errors.New("Workflow source is required")
	}
	scriptPath, err := s.Persistence.Path(input.ResumeFromRunID, ScriptFilename)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(scriptPath)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// Kill stops a running workflow via its background task.
// Kill stops the run's background task. Like the reference kill(), a task
// persistence failure propagates to the caller.
func (s *WorkflowService) Kill(runID string) (bool, error) {
	s.mu.Lock()
	active := s.active[runID]
	s.mu.Unlock()
	if active == nil {
		return false, nil
	}
	active.mu.Lock()
	taskID := active.taskID
	active.mu.Unlock()
	if taskID == "" {
		return false, nil
	}
	return s.options.TaskManager.Stop(taskID)
}

// KillAgent aborts one agent within a run.
func (s *WorkflowService) KillAgent(runID string, agentID int) bool {
	s.mu.Lock()
	active := s.active[runID]
	s.mu.Unlock()
	if active == nil {
		return false
	}
	active.mu.Lock()
	cancel, ok := active.agents[agentID]
	active.mu.Unlock()
	if !ok {
		return false
	}
	cancel()
	return true
}

// Shutdown stops the service and every active run.
func (s *WorkflowService) Shutdown() error {
	s.mu.Lock()
	s.closed = true
	active := make([]*activeRun, 0, len(s.active))
	for _, run := range s.active {
		active = append(active, run)
	}
	s.mu.Unlock()
	for _, run := range active {
		run.mu.Lock()
		taskID := run.taskID
		run.mu.Unlock()
		if taskID != "" {
			_, _ = s.options.TaskManager.StopAndWait(context.Background(), taskID)
		} else {
			run.controller()
		}
	}
	return nil
}

// LoadPersistedRuns loads saved run states into the store, marking
// interrupted runs as killed.
func (s *WorkflowService) LoadPersistedRuns() error {
	runs, err := s.Persistence.List()
	if err != nil {
		return err
	}
	for _, run := range runs {
		if s.Store.Get(run.RunID) != nil {
			continue
		}
		if run.Status == "running" {
			clone := *run
			clone.Status = "killed"
			clone.Error = "Workflow interrupted before shutdown"
			agents := make([]WorkflowRunAgent, len(run.Agents))
			for i, agent := range run.Agents {
				agents[i] = agent
				if agents[i].Status == "running" {
					agents[i].Status = "cancelled"
				}
			}
			clone.Agents = agents
			s.Store.Set(&clone)
			continue
		}
		s.Store.Set(run)
	}
	return nil
}

// CommandRegistrar is the command-registry surface the service needs; the
// commands package implements it (workflow must not import commands: the
// default command registry imports workflow constants).
type CommandRegistrar interface {
	Has(name string) bool
	RegisterPromptCommand(name, description string, handler func(args string) string)
}

// RegisterNamedCommands registers named workflows as slash commands.
func (s *WorkflowService) RegisterNamedCommands(registry CommandRegistrar) error {
	names := ListNamedWorkflows(filepath.Join(s.options.Cwd, WorkflowDirName))
	for _, name := range names {
		if registry.Has(name) {
			continue
		}
		commandName := name
		registry.RegisterPromptCommand(commandName, "Run workflow: "+commandName, func(args string) string {
			return BuildNamedWorkflowPrompt(commandName, args)
		})
	}
	return nil
}

// Command implements the /workflows command actions.
func (s *WorkflowService) Command(args string, toolCtx context.Context) (string, error) {
	fields := strings.Fields(strings.TrimSpace(args))
	action := ""
	runID := ""
	if len(fields) > 0 {
		action = fields[0]
	}
	if len(fields) > 1 {
		runID = fields[1]
	}
	if action == "stop" && runID != "" {
		stopped, err := s.Kill(runID)
		if err != nil {
			return "", err
		}
		if stopped {
			return fmt.Sprintf("Workflow %s stopped", runID), nil
		}
		return fmt.Sprintf("Workflow %s is not running", runID), nil
	}
	if action == "resume" && runID != "" {
		launch, err := s.Launch(map[string]any{"resumeFromRunId": runID}, toolCtx)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("Workflow resumed: run_id=%s task_id=%s", launch.RunID, launch.TaskID), nil
	}
	if err := s.LoadPersistedRuns(); err != nil {
		return "", err
	}
	runs := s.Store.GetSnapshot()
	if action != "" && action != "list" {
		run := s.Store.Get(action)
		if run == nil {
			return "", fmt.Errorf("Workflow run %s not found", action)
		}
		return FormatWorkflowResult(run), nil
	}
	if len(runs) == 0 {
		return "No workflow runs", nil
	}
	var lines []string
	for _, run := range runs {
		lines = append(lines, fmt.Sprintf("%s | %s | %s | %d agents | task_id=%s",
			run.RunID, run.WorkflowName, run.Status, len(run.Agents), run.TaskID))
	}
	return strings.Join(lines, "\n"), nil
}
