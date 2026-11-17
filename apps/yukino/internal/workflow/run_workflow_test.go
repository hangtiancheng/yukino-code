package workflow

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeAdapter struct {
	mu       sync.Mutex
	calls    []string
	outputs  map[string]any
	failWith error
	dead     *AgentRunResult
	delay    time.Duration
	usage    int
}

func (a *fakeAdapter) ID() string { return "fake" }
func (a *fakeAdapter) Capabilities() AgentAdapterCapabilities {
	return AgentAdapterCapabilities{StructuredOutput: true}
}
func (a *fakeAdapter) Initialize() error { return nil }
func (a *fakeAdapter) Dispose() error    { return nil }

func (a *fakeAdapter) Run(params *AgentRunParams, ctx *AgentAdapterContext) (AgentRunResult, error) {
	a.mu.Lock()
	a.calls = append(a.calls, params.Prompt)
	a.mu.Unlock()
	if a.delay > 0 {
		select {
		case <-time.After(a.delay):
		case <-ctx.Ctx.Done():
			return AgentRunResult{}, ctx.Ctx.Err()
		}
	}
	if ctx.Ctx.Err() != nil {
		return AgentRunResult{}, ctx.Ctx.Err()
	}
	if a.failWith != nil {
		return AgentRunResult{}, a.failWith
	}
	if a.dead != nil {
		return *a.dead, nil
	}
	output := any("result-" + params.Prompt)
	if a.outputs != nil {
		if value, ok := a.outputs[params.Prompt]; ok {
			output = value
		}
	}
	usage := a.usage
	if usage == 0 {
		usage = 5
	}
	return OkResult(output, usage, usage+2, 1, "fake-model"), nil
}

func (a *fakeAdapter) callCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.calls)
}

type recordingEmitter struct {
	mu     sync.Mutex
	events []ProgressEvent
}

func (e *recordingEmitter) Emit(event ProgressEvent) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.events = append(e.events, event)
}

func (e *recordingEmitter) of(types ...string) []ProgressEvent {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []ProgressEvent
	for _, event := range e.events {
		for _, t := range types {
			if event.Type == t {
				out = append(out, event)
				break
			}
		}
	}
	return out
}

type recordingLogger struct {
	mu       sync.Mutex
	messages []string
}

func (l *recordingLogger) Warn(message string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.messages = append(l.messages, message)
}

func newTestPorts(adapter AgentAdapter, emitter *recordingEmitter, runsDir string, log *recordingLogger) WorkflowPorts {
	registry := NewAgentAdapterRegistry().Register(adapter).Default(adapter.ID())
	return WorkflowPorts{
		AgentAdapterRegistry: registry,
		ProgressEmitter:      emitter,
		JournalStore:         CreateFileJournalStore(runsDir),
		Logger:               log,
		AgentControllers:     map[int]context.CancelFunc{},
	}
}

func TestRunWorkflowCompleted(t *testing.T) {
	runsDir := t.TempDir()
	adapter := &fakeAdapter{}
	emitter := &recordingEmitter{}
	log := &recordingLogger{}
	ports := newTestPorts(adapter, emitter, runsDir, log)

	script := `
export const meta = { name: 'test-flow', description: 'A test', phases: [{ title: 'Work' }] }
phase('Work')
log('starting')
const first = await agent('first task', { label: 'a' })
const rest = await parallel([
  () => agent('second', { label: 'b' }),
  () => agent('third', { label: 'c' }),
])
return { first: first, rest: rest }
`
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := RunWorkflow(RunWorkflowOptions{
		Script: script, RunID: "run-1", Ports: ports,
		Host: CreateHostHandle(nil), Signal: ctx, Cwd: t.TempDir(),
	})
	if result.Status != "completed" {
		t.Fatalf("status = %s, error = %s", result.Status, result.Error)
	}
	value, ok := result.ReturnValue.(map[string]any)
	if !ok {
		t.Fatalf("returnValue = %#v", result.ReturnValue)
	}
	if value["first"] != "result-first task" {
		t.Errorf("first = %#v", value["first"])
	}
	rest, ok := value["rest"].([]any)
	if !ok || len(rest) != 2 || rest[0] != "result-second" || rest[1] != "result-third" {
		t.Errorf("rest = %#v", value["rest"])
	}
	if adapter.callCount() != 3 {
		t.Errorf("adapter calls = %d, want 3", adapter.callCount())
	}

	started := emitter.of("run_started")
	if len(started) != 1 || started[0].WorkflowName != "test-flow" || started[0].Meta == nil {
		t.Fatalf("run_started = %#v", started)
	}
	phases := emitter.of("phase_started", "phase_done")
	if len(phases) != 2 || phases[0].Phase != "Work" || phases[1].Type != "phase_done" {
		t.Errorf("phase events = %#v", phases)
	}
	logs := emitter.of("log")
	if len(logs) != 1 || logs[0].Message != "starting" {
		t.Errorf("log events = %#v", logs)
	}
	agentStarted := emitter.of("agent_started")
	agentDone := emitter.of("agent_done")
	if len(agentStarted) != 3 || len(agentDone) != 3 {
		t.Errorf("agent events = %d started, %d done", len(agentStarted), len(agentDone))
	}
	doneEvents := emitter.of("run_done")
	if len(doneEvents) != 1 || doneEvents[0].Status != "completed" {
		t.Errorf("run_done = %#v", doneEvents)
	}

	// Journal persisted with three entries.
	journal, err := ports.JournalStore.Read("run-1")
	if err != nil || len(journal) != 3 {
		t.Fatalf("journal = %v (err %v)", journal, err)
	}
	for i, entry := range journal {
		if entry.Seq != i || entry.Result.Kind != "ok" {
			t.Errorf("journal[%d] = %+v", i, entry)
		}
	}
}

func TestRunWorkflowResumeReplaysJournal(t *testing.T) {
	runsDir := t.TempDir()
	script := `
const a = await agent('task-one')
const b = await agent('task-two')
return a + '/' + b
`
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	first := &fakeAdapter{}
	emitter := &recordingEmitter{}
	ports := newTestPorts(first, emitter, runsDir, &recordingLogger{})
	result := RunWorkflow(RunWorkflowOptions{Script: script, RunID: "run-r", Ports: ports, Signal: ctx, Cwd: t.TempDir()})
	if result.Status != "completed" || result.ReturnValue != "result-task-one/result-task-two" {
		t.Fatalf("first run = %#v", result)
	}

	// Resume with the identical script: both calls replay from the journal.
	second := &fakeAdapter{}
	emitter2 := &recordingEmitter{}
	ports2 := newTestPorts(second, emitter2, runsDir, &recordingLogger{})
	result = RunWorkflow(RunWorkflowOptions{Script: script, RunID: "run-r", Ports: ports2, Signal: ctx, Cwd: t.TempDir(), Resume: true})
	if result.Status != "completed" || result.ReturnValue != "result-task-one/result-task-two" {
		t.Fatalf("resume = %#v", result)
	}
	if second.callCount() != 0 {
		t.Errorf("resume must replay the journal without adapter calls, got %d", second.callCount())
	}
	if done := emitter2.of("agent_done"); len(done) != 2 {
		t.Errorf("replayed agent_done events = %d, want 2", len(done))
	}
}

func TestRunWorkflowResumeDivergenceInvalidatesJournal(t *testing.T) {
	runsDir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	first := &fakeAdapter{}
	ports := newTestPorts(first, &recordingEmitter{}, runsDir, &recordingLogger{})
	result := RunWorkflow(RunWorkflowOptions{
		Script: "const a = await agent('task-one')\nconst b = await agent('task-two')\nreturn a + '/' + b",
		RunID:  "run-d", Ports: ports, Signal: ctx, Cwd: t.TempDir(),
	})
	if result.Status != "completed" {
		t.Fatalf("first run = %#v", result)
	}

	// Diverge at the first call: the journal prefix is dropped and every
	// call runs again.
	second := &fakeAdapter{}
	ports2 := newTestPorts(second, &recordingEmitter{}, runsDir, &recordingLogger{})
	result = RunWorkflow(RunWorkflowOptions{
		Script: "const a = await agent('changed')\nconst b = await agent('task-two')\nreturn a + '/' + b",
		RunID:  "run-d", Ports: ports2, Signal: ctx, Cwd: t.TempDir(), Resume: true,
	})
	if result.Status != "completed" || result.ReturnValue != "result-changed/result-task-two" {
		t.Fatalf("diverged resume = %#v", result)
	}
	if second.callCount() != 2 {
		t.Errorf("diverged resume adapter calls = %d, want 2", second.callCount())
	}
}

func TestRunWorkflowPipelineAndErrorNulls(t *testing.T) {
	runsDir := t.TempDir()
	adapter := &fakeAdapter{}
	emitter := &recordingEmitter{}
	ports := newTestPorts(adapter, emitter, runsDir, &recordingLogger{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	script := `
const reviewed = await pipeline(args.items,
  async (item) => await agent('review ' + item, { label: item }),
  async (previous, item) => previous + '!'
)
return reviewed
`
	result := RunWorkflow(RunWorkflowOptions{
		Script: script, Args: map[string]any{"items": []any{"x", "y"}},
		RunID: "run-p", Ports: ports, Signal: ctx, Cwd: t.TempDir(),
	})
	if result.Status != "completed" {
		t.Fatalf("status = %s error = %s", result.Status, result.Error)
	}
	items, ok := result.ReturnValue.([]any)
	if !ok || len(items) != 2 || items[0] != "result-review x!" || items[1] != "result-review y!" {
		t.Fatalf("pipeline result = %#v", result.ReturnValue)
	}
}

func TestRunWorkflowFailedScript(t *testing.T) {
	runsDir := t.TempDir()
	adapter := &fakeAdapter{}
	emitter := &recordingEmitter{}
	ports := newTestPorts(adapter, emitter, runsDir, &recordingLogger{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	result := RunWorkflow(RunWorkflowOptions{
		Script: "throw new Error('script blew up')", RunID: "run-f", Ports: ports, Signal: ctx, Cwd: t.TempDir(),
	})
	if result.Status != "failed" || !strings.Contains(result.Error, "script blew up") {
		t.Fatalf("result = %#v", result)
	}
	done := emitter.of("run_done")
	if len(done) != 1 || done[0].Status != "failed" {
		t.Errorf("run_done = %#v", done)
	}
}

func TestRunWorkflowKilledOnAbort(t *testing.T) {
	runsDir := t.TempDir()
	adapter := &fakeAdapter{delay: 2 * time.Second}
	emitter := &recordingEmitter{}
	ports := newTestPorts(adapter, emitter, runsDir, &recordingLogger{})
	ctx, cancel := context.WithCancel(context.Background())

	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	result := RunWorkflow(RunWorkflowOptions{
		Script: "const a = await agent('slow')\nreturn a", RunID: "run-k", Ports: ports, Signal: ctx, Cwd: t.TempDir(),
	})
	if result.Status != "killed" {
		t.Fatalf("result = %#v", result)
	}
	done := emitter.of("run_done")
	if len(done) != 1 || done[0].Status != "killed" {
		t.Errorf("run_done = %#v", done)
	}
}

func TestRunWorkflowBudgetExhausted(t *testing.T) {
	runsDir := t.TempDir()
	adapter := &fakeAdapter{usage: 20}
	emitter := &recordingEmitter{}
	ports := newTestPorts(adapter, emitter, runsDir, &recordingLogger{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	total := 10
	result := RunWorkflow(RunWorkflowOptions{
		Script: "const a = await agent('one')\nconst b = await agent('two')\nreturn a + b",
		RunID:  "run-b", Ports: ports, Signal: ctx, Cwd: t.TempDir(),
		BudgetTotal: &total,
	})
	if result.Status != "failed" || !strings.Contains(result.Error, "budget exhausted") {
		t.Fatalf("result = %#v", result)
	}
}

func TestRunWorkflowStructuredOutputValidation(t *testing.T) {
	runsDir := t.TempDir()
	adapter := &fakeAdapter{outputs: map[string]any{
		"json task": `{"value": 42}`,
	}}
	emitter := &recordingEmitter{}
	log := &recordingLogger{}
	ports := newTestPorts(adapter, emitter, runsDir, log)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	script := `
const good = await agent('json task', { schema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } })
return good
`
	result := RunWorkflow(RunWorkflowOptions{Script: script, RunID: "run-s", Ports: ports, Signal: ctx, Cwd: t.TempDir()})
	if result.Status != "completed" {
		t.Fatalf("status = %s error = %s", result.Status, result.Error)
	}
	// The raw adapter output is a JSON string; without extraction in the fake
	// the schema validation fails twice and agent() resolves null.
	if result.ReturnValue != nil {
		t.Logf("returnValue = %#v", result.ReturnValue)
	}
	log.mu.Lock()
	warned := len(log.messages) > 0
	log.mu.Unlock()
	if !warned {
		t.Error("expected a validation warning for the string output")
	}
}

func TestRunWorkflowRetryOnceThenNull(t *testing.T) {
	runsDir := t.TempDir()
	adapter := &fakeAdapter{failWith: fmt.Errorf("adapter exploded")}
	emitter := &recordingEmitter{}
	log := &recordingLogger{}
	ports := newTestPorts(adapter, emitter, runsDir, log)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	result := RunWorkflow(RunWorkflowOptions{
		Script: "const a = await agent('doomed')\nreturn a === null ? 'null-result' : 'unexpected'",
		RunID:  "run-r2", Ports: ports, Signal: ctx, Cwd: t.TempDir(),
	})
	if result.Status != "completed" || result.ReturnValue != "null-result" {
		t.Fatalf("result = %#v", result)
	}
	if adapter.callCount() != 2 {
		t.Errorf("adapter calls = %d, want 2 (retry once)", adapter.callCount())
	}
	log.mu.Lock()
	warnings := len(log.messages)
	log.mu.Unlock()
	// The reference warns once per dead attempt (two attempts).
	if warnings != 2 {
		t.Errorf("warnings = %d, want 2", warnings)
	}
	done := emitter.of("agent_done")
	if len(done) != 1 || done[0].Result == nil || done[0].Result.Kind != "dead" || done[0].Result.Reason != "run-agent-threw" {
		t.Errorf("agent_done = %#v", done)
	}
}

func TestRunWorkflowSandboxBlocksNondeterminism(t *testing.T) {
	runsDir := t.TempDir()
	adapter := &fakeAdapter{}
	ports := newTestPorts(adapter, &recordingEmitter{}, runsDir, &recordingLogger{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	for _, script := range []string{
		"return Date.now()",
		"return new Date().getTime()",
		"return Math.random()",
	} {
		result := RunWorkflow(RunWorkflowOptions{Script: script, RunID: "run-nd", Ports: ports, Signal: ctx, Cwd: t.TempDir()})
		if result.Status != "failed" || !strings.Contains(result.Error, "not available in workflow scripts") {
			t.Errorf("script %q result = %#v", script, result)
		}
	}
	// Deterministic Date usage with args stays allowed.
	result := RunWorkflow(RunWorkflowOptions{
		Script: "return new Date(1700000000000).getTime()", RunID: "run-d2", Ports: ports, Signal: ctx, Cwd: t.TempDir(),
	})
	if result.Status != "completed" {
		t.Errorf("new Date(ms) must work: %#v", result)
	}
}

func TestRunWorkflowScriptGuards(t *testing.T) {
	runsDir := t.TempDir()
	adapter := &fakeAdapter{}
	ports := newTestPorts(adapter, &recordingEmitter{}, runsDir, &recordingLogger{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cases := []struct{ script, want string }{
		{"import fs from 'fs'\nreturn 1", "import is not supported"},
		{"const m = import('fs')\nreturn 1", "dynamic import(...) is forbidden"},
		{"export const other = 1\nreturn 1", "only one export const meta"},
		{"export const meta = { name: 42 }\nreturn 1", "meta must include string name"},
		{"export const meta = { name: 'x', description: 'y' }.toString()\nreturn 1", ""},
	}
	for i, c := range cases {
		result := RunWorkflow(RunWorkflowOptions{Script: c.script, RunID: fmt.Sprintf("run-g%d", i), Ports: ports, Signal: ctx, Cwd: t.TempDir()})
		if c.want == "" {
			continue
		}
		if result.Status != "failed" || !strings.Contains(result.Error, c.want) {
			t.Errorf("case %d result = %#v, want error containing %q", i, result, c.want)
		}
	}
}

func TestRunWorkflowConcurrencyClamped(t *testing.T) {
	runsDir := t.TempDir()
	adapter := &fakeAdapter{delay: 30 * time.Millisecond}
	ports := newTestPorts(adapter, &recordingEmitter{}, runsDir, &recordingLogger{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	maxConcurrency := 2
	start := time.Now()
	result := RunWorkflow(RunWorkflowOptions{
		Script: "return await parallel([() => agent('a'), () => agent('b'), () => agent('c'), () => agent('d')])",
		RunID:  "run-c", Ports: ports, Signal: ctx, Cwd: t.TempDir(), MaxConcurrency: &maxConcurrency,
	})
	elapsed := time.Since(start)
	if result.Status != "completed" {
		t.Fatalf("result = %#v", result)
	}
	// 4 agents at concurrency 2 with 30ms each: >= 60ms.
	if elapsed < 55*time.Millisecond {
		t.Errorf("elapsed = %v, expected serialized batches", elapsed)
	}
	items := result.ReturnValue.([]any)
	if len(items) != 4 {
		t.Errorf("results = %#v", items)
	}
}

func TestRunWorkflowJournalFileFormat(t *testing.T) {
	runsDir := t.TempDir()
	adapter := &fakeAdapter{}
	ports := newTestPorts(adapter, &recordingEmitter{}, runsDir, &recordingLogger{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	RunWorkflow(RunWorkflowOptions{Script: "return await agent('journal check')", RunID: "run-j", Ports: ports, Signal: ctx, Cwd: t.TempDir()})
	raw, err := os.ReadFile(filepath.Join(runsDir, "run-j", JournalFilename))
	if err != nil {
		t.Fatal(err)
	}
	var entry map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(raw))), &entry); err != nil {
		t.Fatal(err)
	}
	if entry["seq"].(float64) != 0 || entry["result"].(map[string]any)["kind"] != "ok" {
		t.Errorf("journal entry = %v", entry)
	}
}
