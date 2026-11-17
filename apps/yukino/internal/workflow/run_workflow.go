package workflow

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dop251/goja"
)

// RunWorkflowOptions starts one workflow execution.
type RunWorkflowOptions struct {
	Script         string
	Args           any
	RunID          string
	WorkflowName   string
	Ports          WorkflowPorts
	Host           *HostHandle
	Signal         context.Context
	Cwd            string
	BudgetTotal    *int
	MaxConcurrency *int
	Resume         bool
}

// scriptLoop owns one goja runtime and serializes all access to it through
// posted tasks; goja drains the microtask queue whenever a top-level call
// returns, so each posted resolve/reject advances the script.
type scriptLoop struct {
	vm    *goja.Runtime
	tasks chan func(vm *goja.Runtime)
}

func newScriptLoop(vm *goja.Runtime) *scriptLoop {
	return &scriptLoop{vm: vm, tasks: make(chan func(vm *goja.Runtime), 64)}
}

func (l *scriptLoop) post(task func(vm *goja.Runtime)) {
	l.tasks <- task
}

// RunWorkflow executes a workflow script to completion, mirroring
// runWorkflow: abort propagation, journal load for resume, run_started /
// phase_done / run_done progress events, and killed/failed classification.
func RunWorkflow(opts RunWorkflowOptions) WorkflowRunResult {
	controllerCtx, controllerCancel := context.WithCancel(context.Background())
	defer controllerCancel()
	go func() {
		select {
		case <-opts.Signal.Done():
			controllerCancel()
		case <-controllerCtx.Done():
		}
	}()

	var engineCtx *EngineContext
	var result WorkflowRunResult

	func() {
		parsed, err := ParseScript(opts.Script)
		if err != nil {
			result = WorkflowRunResult{Status: "failed", Error: ErrorString(err)}
			controllerCancel()
			return
		}
		var journal []JournalEntry
		if opts.Resume {
			journal, err = opts.Ports.JournalStore.Read(opts.RunID)
			if err != nil {
				result = WorkflowRunResult{Status: "failed", Error: ErrorString(err)}
				controllerCancel()
				return
			}
		}
		workflowName := opts.WorkflowName
		if workflowName == "" {
			if parsed.Meta != nil && parsed.Meta.Name != "" {
				workflowName = parsed.Meta.Name
			} else {
				workflowName = "workflow"
			}
		}
		engineCtx = CreateEngineContext(EngineContextOptions{
			Ports:          opts.Ports,
			Host:           opts.Host,
			Ctx:            controllerCtx,
			RunID:          opts.RunID,
			WorkflowName:   workflowName,
			Cwd:            opts.Cwd,
			BudgetTotal:    opts.BudgetTotal,
			MaxConcurrency: opts.MaxConcurrency,
			Journal:        journal,
		})
		opts.Ports.ProgressEmitter.Emit(ProgressEvent{
			Type: "run_started", RunID: opts.RunID, WorkflowName: workflowName, Meta: parsed.Meta,
		})
		if controllerCtx.Err() != nil {
			result = WorkflowRunResult{Status: "killed"}
			return
		}

		loop := newScriptLoop(parsed.VM())
		runSubWorkflow := func(sub SubWorkflowOptions) (any, error) {
			return runSubScript(engineCtx, loop, opts, sub)
		}
		hooks := MakeHooks(engineCtx, parsed.VM(), loop.post, runSubWorkflow, 0)
		topValue, err := parsed.Execute(hooks, parsed.VM().ToValue(opts.Args), BudgetValue(parsed.VM(), engineCtx.Resources.Budget))
		if err != nil {
			result = WorkflowRunResult{Status: "failed", Error: ErrorString(err)}
			controllerCancel()
			return
		}
		result = loop.drive(topValue, engineCtx, opts.Signal, true)
	}()

	if engineCtx != nil {
		engineCtx.Mu.Lock()
		currentPhase := engineCtx.CurrentPhase
		engineCtx.Mu.Unlock()
		if currentPhase != "" {
			opts.Ports.ProgressEmitter.Emit(ProgressEvent{Type: "phase_done", RunID: opts.RunID, Phase: currentPhase})
		}
	}
	opts.Ports.ProgressEmitter.Emit(ProgressEvent{
		Type: "run_done", RunID: opts.RunID,
		Status: result.Status, ReturnValue: result.ReturnValue, Error: result.Error,
	})
	return result
}

// drive advances the script until the top-level promise settles. When
// drainInFlight is set (top-level runs only) it then waits for outstanding
// agent work, mirroring `await parsed.execute(...)` +
// `await Promise.all(ctx.inFlight)`; nested workflow() calls skip the drain
// like the reference.
func (l *scriptLoop) drive(topValue goja.Value, ctx *EngineContext, outer context.Context, drainInFlight bool) WorkflowRunResult {
	promise, ok := topValue.Export().(*goja.Promise)
	if !ok {
		return WorkflowRunResult{Status: "completed", ReturnValue: topValue.Export()}
	}
	aborted := false
	for promise.State() == goja.PromiseStatePending {
		if aborted {
			// The run was aborted while the script awaits; keep draining
			// worker resolutions so the script can observe the abort.
			task := <-l.tasks
			task(l.vm)
			continue
		}
		select {
		case task := <-l.tasks:
			task(l.vm)
		case <-ctx.Ctx.Done():
			aborted = true
		}
	}
	if drainInFlight {
		for ctx.InFlight.Count() > 0 {
			select {
			case task := <-l.tasks:
				task(l.vm)
			case <-ctx.InFlight.Notify():
			}
		}
	}
	switch promise.State() {
	case goja.PromiseStateFulfilled:
		return WorkflowRunResult{Status: "completed", ReturnValue: promise.Result().Export()}
	case goja.PromiseStateRejected:
		reason := promise.Result()
		if IsWorkflowAbortedValue(reason) || outer.Err() != nil {
			return WorkflowRunResult{Status: "killed"}
		}
		return WorkflowRunResult{Status: "failed", Error: ExportErrorMessage(reason)}
	default:
		return WorkflowRunResult{Status: "failed", Error: "workflow script did not settle"}
	}
}

// IsWorkflowAbortedValue reports whether a JS rejection reason is a
// WorkflowAbortedError.
func IsWorkflowAbortedValue(value goja.Value) bool {
	if value == nil {
		return false
	}
	obj, ok := value.(*goja.Object)
	if !ok {
		return false
	}
	name := obj.Get("name")
	if name == nil {
		return false
	}
	return name.String() == "WorkflowAbortedError"
}

// runSubScript executes a workflow() composition on its own VM while sharing
// the parent engine context, mirroring the runSubWorkflow closure.
func runSubScript(engineCtx *EngineContext, parent *scriptLoop, opts RunWorkflowOptions, sub SubWorkflowOptions) (any, error) {
	var source string
	if sub.Name != "" {
		_, content, ok := ResolveNamedWorkflow(filepath.Join(opts.Cwd, WorkflowDirName), sub.Name)
		if !ok {
			return nil, NewWorkflowError(fmt.Sprintf("Sub-workflow %q not found", sub.Name))
		}
		source = content
	} else {
		base, err := filepath.EvalSymlinks(opts.Cwd)
		if err != nil {
			base = opts.Cwd
		}
		path, err := filepath.EvalSymlinks(filepath.Join(opts.Cwd, sub.ScriptPath))
		if err != nil {
			return nil, NewWorkflowError("Sub-workflow scriptPath is outside the project")
		}
		if !ContainsPath(base, path) {
			return nil, NewWorkflowError("Sub-workflow scriptPath is outside the project")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		source = string(data)
	}
	parsed, err := ParseScript(source)
	if err != nil {
		return nil, err
	}
	loop := newScriptLoop(parsed.VM())
	runNested := func(nested SubWorkflowOptions) (any, error) {
		return runSubScript(engineCtx, loop, opts, nested)
	}
	hooks := MakeHooks(engineCtx, parsed.VM(), loop.post, runNested, sub.Depth)
	topValue, err := parsed.Execute(hooks, parsed.VM().ToValue(sub.Args), BudgetValue(parsed.VM(), engineCtx.Resources.Budget))
	if err != nil {
		return nil, err
	}
	result := loop.drive(topValue, engineCtx, opts.Signal, false)
	switch result.Status {
	case "completed":
		return result.ReturnValue, nil
	case "killed":
		return nil, NewWorkflowAbortedError()
	default:
		return nil, errors.New(result.Error)
	}
}
