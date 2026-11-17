package workflow

import (
	"context"
	"fmt"
	"math"

	"github.com/dop251/goja"
)

// SubWorkflowRunner executes a nested workflow() call.
type SubWorkflowRunner func(opts SubWorkflowOptions) (any, error)

// SubWorkflowOptions identifies a sub-workflow launch.
type SubWorkflowOptions struct {
	Name       string
	ScriptPath string
	Args       any
	Depth      int
}

// Hooks binds the engine context to one script VM. All goja access happens
// on the VM loop goroutine; agent workers post resolutions through post.
type Hooks struct {
	ctx            *EngineContext
	vm             *goja.Runtime
	post           func(task func(vm *goja.Runtime))
	runSubWorkflow SubWorkflowRunner
	depth          int
}

// MakeHooks builds the injected primitives, mirroring makeHooks.
func MakeHooks(ctx *EngineContext, vm *goja.Runtime, post func(func(*goja.Runtime)), runSubWorkflow SubWorkflowRunner, depth int) *ScriptHookValues {
	h := &Hooks{ctx: ctx, vm: vm, post: post, runSubWorkflow: runSubWorkflow, depth: depth}
	return &ScriptHookValues{
		Agent:    vm.ToValue(h.agent),
		Phase:    vm.ToValue(h.phase),
		Log:      vm.ToValue(h.log),
		Workflow: vm.ToValue(h.workflow),
		Warn: vm.ToValue(func(call goja.FunctionCall) goja.Value {
			if len(call.Arguments) > 0 {
				ctx.Ports.Logger.Warn(call.Arguments[0].String())
			}
			return goja.Undefined()
		}),
	}
}

func (h *Hooks) emit(event ProgressEvent) {
	h.ctx.Ports.ProgressEmitter.Emit(event)
}

// jsError builds a JS Error with the given name, mirroring the reference
// error classes.
func jsError(vm *goja.Runtime, name, message string) goja.Value {
	constructor, ok := goja.AssertConstructor(vm.GlobalObject().Get("Error"))
	if !ok {
		return vm.ToValue(message)
	}
	value, err := constructor(nil, vm.ToValue(message))
	if err != nil {
		return vm.ToValue(message)
	}
	_ = value.Set("name", name)
	return value
}

func (h *Hooks) rejectedPromise(reason goja.Value) goja.Value {
	promise, _, reject := h.vm.NewPromise()
	_ = reject(reason)
	return h.vm.ToValue(promise)
}

func (h *Hooks) resolvedPromise(value any) goja.Value {
	promise, resolve, _ := h.vm.NewPromise()
	_ = resolve(value)
	return h.vm.ToValue(promise)
}

// agent implements the injected agent() primitive, mirroring callAgent:
// journal replay, semaphore, budget, retry-once adapter execution, journal
// append.
func (h *Hooks) agent(call goja.FunctionCall) goja.Value {
	ctx := h.ctx
	if ctx.Ctx.Err() != nil {
		return h.rejectedPromise(jsError(h.vm, "WorkflowAbortedError", "workflow has been aborted"))
	}

	ctx.Mu.Lock()
	agentID := ctx.Resources.AgentIDSeq
	ctx.Resources.AgentIDSeq++
	ctx.Mu.Unlock()
	if agentID >= MaxTotalAgents {
		return h.rejectedPromise(jsError(h.vm, "WorkflowError", fmt.Sprintf("workflow exceeds total agent cap (%d)", MaxTotalAgents)))
	}

	prompt := ""
	if len(call.Arguments) > 0 && !goja.IsUndefined(call.Arguments[0]) && !goja.IsNull(call.Arguments[0]) {
		prompt = call.Arguments[0].String()
	}
	opts := map[string]any{}
	schemaRaw := ""
	if len(call.Arguments) > 1 {
		if obj, ok := call.Arguments[1].(*goja.Object); ok {
			if exported, ok := obj.Export().(map[string]any); ok {
				opts = exported
			}
			if schemaValue := obj.Get("schema"); schemaValue != nil && !goja.IsUndefined(schemaValue) && !goja.IsNull(schemaValue) {
				schemaRaw = jsonStringify(h.vm, schemaValue)
			}
		}
	}
	params, err := ParseAgentRunParams(prompt, opts)
	if err != nil {
		return h.rejectedPromise(jsError(h.vm, "Error", err.Error()))
	}
	params.SchemaRaw = schemaRaw
	if params.Schema != nil {
		if err := AssertValidJsonSchema(params.Schema); err != nil {
			return h.rejectedPromise(jsError(h.vm, "Error", err.Error()))
		}
	}
	key := AgentCallKey(prompt, params)
	label := params.Label
	phase := params.Phase
	if phase == "" {
		ctx.Mu.Lock()
		phase = ctx.CurrentPhase
		ctx.Mu.Unlock()
	}
	done := func(result AgentRunResult) {
		h.emit(ProgressEvent{Type: "agent_done", RunID: ctx.RunID, AgentID: agentID, Label: label, Phase: phase, Result: &result})
	}

	// Journal replay: a matching completed entry short-circuits the call;
	// divergence invalidates the replay prefix and checkpoints it.
	ctx.Mu.Lock()
	if !ctx.JournalInvalidated && len(ctx.Journal) > 0 {
		var entry *JournalEntry
		for i := range ctx.Journal {
			if ctx.Journal[i].Seq == agentID {
				entry = &ctx.Journal[i]
				break
			}
		}
		if entry != nil && entry.Key == key && entry.Result.Kind == "ok" && validateStructuredResult(entry.Result, params.Schema).Kind == "ok" {
			result := entry.Result
			ctx.Mu.Unlock()
			done(result)
			return h.resolvedPromise(result.Output)
		}
		// Keep the replayed prefix and the saved source when execution diverges.
		ctx.JournalInvalidated = true
		var prefix []JournalEntry
		for _, item := range ctx.Journal {
			if item.Seq < agentID {
				prefix = append(prefix, item)
			}
		}
		ctx.Mu.Unlock()
		if err := ctx.Ports.JournalStore.Replace(ctx.RunID, prefix); err != nil {
			return h.rejectedPromise(jsError(h.vm, "Error", err.Error()))
		}
	} else {
		ctx.Mu.Unlock()
	}

	promise, resolve, reject := h.vm.NewPromise()
	ctx.InFlight.Add()
	go h.runAgent(agentID, key, params, label, phase, resolve, reject)
	return h.vm.ToValue(promise)
}

func (h *Hooks) runAgent(agentID int, key string, params *AgentRunParams, label, phase string, resolve, reject func(any) error) {
	ctx := h.ctx
	defer ctx.InFlight.Done()

	release, err := ctx.Resources.Semaphore.Acquire(ctx.Ctx)
	if err != nil {
		h.post(func(vm *goja.Runtime) {
			_ = reject(jsError(vm, "WorkflowAbortedError", "workflow has been aborted"))
		})
		return
	}
	defer release()

	agentCtx, agentCancel := context.WithCancel(ctx.Ctx)
	defer agentCancel()

	ctx.Mu.Lock()
	if ctx.Ctx.Err() != nil {
		ctx.Mu.Unlock()
		h.post(func(vm *goja.Runtime) {
			_ = reject(jsError(vm, "WorkflowAbortedError", "workflow has been aborted"))
		})
		return
	}
	if err := ctx.Resources.Budget.AssertCanSpend(); err != nil {
		ctx.Mu.Unlock()
		h.post(func(vm *goja.Runtime) {
			_ = reject(jsError(vm, "BudgetExhaustedError", err.Error()))
		})
		return
	}
	ctx.Ports.AgentControllers[agentID] = agentCancel
	ctx.Mu.Unlock()
	defer func() {
		ctx.Mu.Lock()
		delete(ctx.Ports.AgentControllers, agentID)
		ctx.Mu.Unlock()
	}()

	h.emit(ProgressEvent{Type: "agent_started", RunID: ctx.RunID, AgentID: agentID, Label: label, Phase: phase})

	adapter, err := ctx.Ports.AgentAdapterRegistry.Resolve(params)
	if err != nil {
		message := err.Error()
		h.post(func(vm *goja.Runtime) {
			_ = reject(jsError(vm, "AdapterNotFoundError", message))
		})
		return
	}

	result := DeadResult("unknown", "")
	for attempt := 0; attempt < 2; attempt++ {
		runResult, runErr := runAdapterSafely(adapter, params, &AgentAdapterContext{
			Host:    ctx.Host,
			Ctx:     agentCtx,
			RunID:   ctx.RunID,
			AgentID: agentID,
			OnProgress: func(update AgentProgressUpdate) {
				h.emit(ProgressEvent{
					Type: "agent_progress", RunID: ctx.RunID, AgentID: agentID, Label: label, Phase: phase,
					TokenCount: update.TokenCount, ToolCount: update.ToolCount,
				})
			},
		})
		if runErr != nil {
			if ctx.Ctx.Err() != nil {
				h.post(func(vm *goja.Runtime) {
					_ = reject(jsError(vm, "WorkflowAbortedError", "workflow has been aborted"))
				})
				return
			}
			if agentCtx.Err() != nil {
				result = SkippedResult()
			} else {
				result = DeadResult("run-agent-threw", ErrorString(runErr))
			}
		} else {
			result = validateStructuredResult(runResult, params.Schema)
		}
		if ctx.Ctx.Err() != nil {
			h.post(func(vm *goja.Runtime) {
				_ = reject(jsError(vm, "WorkflowAbortedError", "workflow has been aborted"))
			})
			return
		}
		if agentCtx.Err() != nil {
			result = SkippedResult()
		}
		if result.Kind != "dead" {
			break
		}
		detail := result.Detail
		if detail == "" {
			detail = result.Reason
		}
		ctx.Ports.Logger.Warn(fmt.Sprintf("workflow agent %d: %s", agentID, detail))
	}

	if result.Kind == "ok" && result.Usage != nil {
		ctx.Resources.Budget.AddOutputTokens(result.Usage.OutputTokens)
	}
	doneResult := result
	h.emit(ProgressEvent{Type: "agent_done", RunID: ctx.RunID, AgentID: agentID, Label: label, Phase: phase, Result: &doneResult})

	if err := ctx.Ports.JournalStore.Append(ctx.RunID, JournalEntry{Key: key, Seq: agentID, Result: result}); err != nil {
		message := err.Error()
		h.post(func(vm *goja.Runtime) {
			_ = reject(jsError(vm, "Error", message))
		})
		return
	}

	var output any
	if result.Kind == "ok" {
		output = result.Output
	}
	h.post(func(vm *goja.Runtime) {
		_ = resolve(output)
	})
}

// runAdapterSafely converts adapter panics into errors, mirroring the
// reference try/catch around adapter.run.
func runAdapterSafely(adapter AgentAdapter, params *AgentRunParams, ctx *AgentAdapterContext) (result AgentRunResult, err error) {
	defer func() {
		if r := recover(); r != nil {
			result = AgentRunResult{}
			err = fmt.Errorf("%v", r)
		}
	}()
	return adapter.Run(params, ctx)
}

func (h *Hooks) phase(call goja.FunctionCall) goja.Value {
	title := ""
	if len(call.Arguments) > 0 {
		title = call.Arguments[0].String()
	}
	ctx := h.ctx
	ctx.Mu.Lock()
	previous := ctx.CurrentPhase
	ctx.CurrentPhase = title
	ctx.Mu.Unlock()
	if previous != "" {
		h.emit(ProgressEvent{Type: "phase_done", RunID: ctx.RunID, Phase: previous})
	}
	h.emit(ProgressEvent{Type: "phase_started", RunID: ctx.RunID, Phase: title})
	return goja.Undefined()
}

func (h *Hooks) log(call goja.FunctionCall) goja.Value {
	message := ""
	if len(call.Arguments) > 0 {
		message = call.Arguments[0].String()
	}
	h.emit(ProgressEvent{Type: "log", RunID: h.ctx.RunID, Message: message})
	return goja.Undefined()
}

func (h *Hooks) workflow(call goja.FunctionCall) goja.Value {
	if h.depth >= 1 {
		return h.rejectedPromise(jsError(h.vm, "WorkflowError", "workflow() nesting allows only one level"))
	}
	opts := SubWorkflowOptions{Depth: h.depth + 1}
	if len(call.Arguments) > 0 {
		switch value := call.Arguments[0].Export().(type) {
		case string:
			opts.Name = value
		case map[string]any:
			if scriptPath, ok := value["scriptPath"].(string); ok {
				opts.ScriptPath = scriptPath
			}
		}
	}
	if len(call.Arguments) > 1 && !goja.IsUndefined(call.Arguments[1]) {
		opts.Args = call.Arguments[1].Export()
	}
	promise, resolve, reject := h.vm.NewPromise()
	h.ctx.InFlight.Add()
	go func() {
		defer h.ctx.InFlight.Done()
		result, err := h.runSubWorkflow(opts)
		h.post(func(vm *goja.Runtime) {
			if err != nil {
				name := "WorkflowError"
				if IsWorkflowAborted(err) {
					name = "WorkflowAbortedError"
				}
				_ = reject(jsError(vm, name, err.Error()))
				return
			}
			_ = resolve(result)
		})
	}()
	return h.vm.ToValue(promise)
}

// validateStructuredResult mirrors validateStructuredResult.
func validateStructuredResult(result AgentRunResult, schema map[string]any) AgentRunResult {
	if schema == nil || result.Kind != "ok" {
		return result
	}
	valid, errors := ValidateAgainstSchema(result.Output, schema)
	if valid {
		return result
	}
	detail := ""
	for i, message := range errors {
		if i > 0 {
			detail += "; "
		}
		detail += message
	}
	return DeadResult("invalid-structured-output", detail)
}

// jsonStringify renders a goja value as JSON text via the VM's JSON.stringify
// so author key order survives.
func jsonStringify(vm *goja.Runtime, value goja.Value) string {
	jsonObject := vm.GlobalObject().Get("JSON")
	if jsonObject == nil {
		return ""
	}
	stringify, ok := goja.AssertFunction(jsonObject.(*goja.Object).Get("stringify"))
	if !ok {
		return ""
	}
	result, err := stringify(jsonObject, value)
	if err != nil {
		return ""
	}
	return result.String()
}

// BudgetValue exposes the Budget to scripts, mirroring budget.total/spent()/
// remaining().
func BudgetValue(vm *goja.Runtime, budget *Budget) goja.Value {
	object := vm.NewObject()
	if budget.Total != nil {
		_ = object.Set("total", *budget.Total)
	} else {
		_ = object.Set("total", nil)
	}
	_ = object.Set("spent", vm.ToValue(func(goja.FunctionCall) goja.Value {
		return vm.ToValue(budget.Spent())
	}))
	_ = object.Set("remaining", vm.ToValue(func(goja.FunctionCall) goja.Value {
		remaining := budget.Remaining()
		if math.IsInf(remaining, 1) {
			return vm.ToValue(math.Inf(1))
		}
		return vm.ToValue(remaining)
	}))
	return object
}
