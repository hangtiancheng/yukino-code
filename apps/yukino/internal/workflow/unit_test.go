package workflow

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/dop251/goja"
)

func newTestVM() *goja.Runtime { return goja.New() }

func TestContainsPath(t *testing.T) {
	if !ContainsPath("/base", "/base/x") || !ContainsPath("/base", "/base") {
		t.Error("expected containment")
	}
	if ContainsPath("/base", "/basement/x") || ContainsPath("/base", "/other") {
		t.Error("expected rejection")
	}
	if !ContainsPath("/base", "x/y") {
		t.Error("relative target must resolve against base")
	}
	if ContainsPath("/base", "../escape") {
		t.Error("escape must be rejected")
	}
}

func TestSanitizeWorkflowName(t *testing.T) {
	if SanitizeWorkflowName("ok-name") != "ok-name" {
		t.Error("valid name rejected")
	}
	for _, invalid := range []string{"", "a/b", "a\\b", ".", "..", "a\x00b"} {
		if SanitizeWorkflowName(invalid) != "" {
			t.Errorf("%q must be rejected", invalid)
		}
	}
}

func TestClampMaxConcurrency(t *testing.T) {
	if got := ClampMaxConcurrency(nil); got != DefaultMaxConcurrency {
		t.Errorf("nil = %d", got)
	}
	ten := 10
	if got := ClampMaxConcurrency(&ten); got != 10 {
		t.Errorf("10 = %d", got)
	}
	zero := 0
	if got := ClampMaxConcurrency(&zero); got != 1 {
		t.Errorf("0 = %d", got)
	}
	huge := 100
	if got := ClampMaxConcurrency(&huge); got != MaxConcurrencyCap {
		t.Errorf("100 = %d", got)
	}
}

func TestSemaphoreAbort(t *testing.T) {
	sem := NewSemaphore(1)
	release, err := sem.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	acquired := make(chan struct{})
	go func() {
		_, err := sem.Acquire(ctx)
		if err == nil {
			t.Error("expected abort error")
		}
		close(acquired)
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case <-acquired:
	case <-time.After(2 * time.Second):
		t.Fatal("acquire did not abort")
	}
	release()
	// Permit transfers directly to waiters.
	second, err := sem.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second()
}

func TestBudget(t *testing.T) {
	unlimited := NewBudget(nil)
	if r := unlimited.Remaining(); r != r+r/2 { // +Inf check
		t.Errorf("unlimited remaining = %v", r)
	}
	unlimited.AddOutputTokens(100)
	if unlimited.Spent() != 100 {
		t.Errorf("spent = %d", unlimited.Spent())
	}
	if err := unlimited.AssertCanSpend(); err != nil {
		t.Error("unlimited budget must never exhaust")
	}
	total := 10
	limited := NewBudget(&total)
	limited.AddOutputTokens(10)
	if err := limited.AssertCanSpend(); err == nil {
		t.Error("expected exhaustion")
	}
	if limited.Remaining() != 0 {
		t.Errorf("remaining = %v", limited.Remaining())
	}
	limited.AddOutputTokens(-5)
	if limited.Spent() != 10 {
		t.Error("negative additions must be ignored")
	}
}

func TestAgentCallKey(t *testing.T) {
	base := &AgentRunParams{Prompt: "p", Model: "m"}
	withLabel := &AgentRunParams{Prompt: "p", Model: "m", Label: "x", Phase: "y"}
	if AgentCallKey("p", base) != AgentCallKey("p", withLabel) {
		t.Error("label/phase must not affect the key")
	}
	other := &AgentRunParams{Prompt: "p", Model: "m2"}
	if AgentCallKey("p", base) == AgentCallKey("p", other) {
		t.Error("different params must produce different keys")
	}
	if AgentCallKey("p", base) == AgentCallKey("p2", base) {
		t.Error("different prompts must produce different keys")
	}
	// Key order in schema maps must not matter.
	a := &AgentRunParams{Prompt: "p", Schema: map[string]any{"type": "object", "title": "x"}}
	b := &AgentRunParams{Prompt: "p", Schema: map[string]any{"title": "x", "type": "object"}}
	if AgentCallKey("p", a) != AgentCallKey("p", b) {
		t.Error("canonicalization must sort keys")
	}
}

func TestExtractStructuredOutput(t *testing.T) {
	value, err := ExtractStructuredOutput(`{"a": 1}`)
	if err != nil || value.(map[string]any)["a"].(float64) != 1 {
		t.Errorf("direct = %v %v", value, err)
	}
	value, err = ExtractStructuredOutput("Here you go:\n```json\n{\"b\": 2}\n```\nDone.")
	if err != nil || value.(map[string]any)["b"].(float64) != 2 {
		t.Errorf("fenced = %v %v", value, err)
	}
	value, err = ExtractStructuredOutput(`The answer is {"c": [1, {"d": "x}"}]} thanks`)
	if err != nil {
		t.Fatalf("embedded err = %v", err)
	}
	if value.(map[string]any)["c"] == nil {
		t.Errorf("embedded = %v", value)
	}
	// The last candidate wins.
	value, err = ExtractStructuredOutput(`{"first": 1} and {"second": 2}`)
	if err != nil || value.(map[string]any)["second"] == nil {
		t.Errorf("last candidate = %v %v", value, err)
	}
	if _, err := ExtractStructuredOutput("no json here"); err == nil ||
		!strings.Contains(err.Error(), "no valid JSON output") {
		t.Errorf("missing JSON err = %v", err)
	}
}

func TestValidateAgainstSchema(t *testing.T) {
	schema := map[string]any{
		"type":       "object",
		"properties": map[string]any{"value": map[string]any{"type": "number"}},
		"required":   []any{"value"},
	}
	if err := AssertValidJsonSchema(schema); err != nil {
		t.Fatal(err)
	}
	valid, errs := ValidateAgainstSchema(map[string]any{"value": 1}, schema)
	if !valid || len(errs) != 0 {
		t.Errorf("valid case = %v %v", valid, errs)
	}
	valid, errs = ValidateAgainstSchema(map[string]any{"value": "x"}, schema)
	if valid || len(errs) == 0 {
		t.Errorf("invalid case = %v %v", valid, errs)
	}
	valid, errs = ValidateAgainstSchema(map[string]any{}, schema)
	if valid || len(errs) == 0 {
		t.Errorf("missing required = %v %v", valid, errs)
	}
}

func TestProgressStoreApply(t *testing.T) {
	store := NewWorkflowProgressStore()
	store.Set(&WorkflowRun{
		RunID: "r1", TaskID: "t1", WorkflowName: "wf", ScriptPath: "/p",
		Status: "running", StartedAt: 1, UpdatedAt: 1,
		Phases: []WorkflowRunPhase{}, Agents: []WorkflowRunAgent{}, Logs: []string{},
	})
	store.Apply(ProgressEvent{Type: "run_started", RunID: "r1", WorkflowName: "wf", Meta: &WorkflowMeta{
		Description: "desc", Phases: []WorkflowPhase{{Title: "P1"}},
	}})
	store.Apply(ProgressEvent{Type: "phase_started", RunID: "r1", Phase: "P1"})
	store.Apply(ProgressEvent{Type: "agent_started", RunID: "r1", AgentID: 0, Label: "a"})
	store.Apply(ProgressEvent{Type: "agent_progress", RunID: "r1", AgentID: 0, TokenCount: 5, ToolCount: 2})
	result := OkResult("out", 7, 9, 3, "m")
	store.Apply(ProgressEvent{Type: "agent_done", RunID: "r1", AgentID: 0, Result: &result})
	store.Apply(ProgressEvent{Type: "log", RunID: "r1", Message: "hello"})
	store.Apply(ProgressEvent{Type: "run_done", RunID: "r1", Status: "completed", ReturnValue: "out"})

	run := store.Get("r1")
	if run.Description != "desc" || len(run.Phases) != 1 || run.Phases[0].Status != "running" {
		t.Errorf("phases = %#v", run.Phases)
	}
	if len(run.Agents) != 1 || run.Agents[0].Status != "done" || run.Agents[0].TokenCount != 9 || run.Agents[0].ToolCount != 3 || run.Agents[0].Model != "m" {
		t.Errorf("agents = %#v", run.Agents)
	}
	if len(run.Logs) != 1 || run.Logs[0] != "hello" {
		t.Errorf("logs = %#v", run.Logs)
	}
	if run.Status != "completed" || run.ReturnValue != "out" {
		t.Errorf("terminal = %#v", run)
	}
	snapshot := store.GetSnapshot()
	if len(snapshot) != 1 {
		t.Errorf("snapshot = %v", snapshot)
	}
	// Unknown runs are ignored.
	store.Apply(ProgressEvent{Type: "log", RunID: "nope", Message: "x"})
}

func TestExtractMetaAndParseScript(t *testing.T) {
	meta, body, err := ExtractMeta(newTestVM(), "export const meta = { name: 'n', description: 'd' };\nreturn 1")
	if err != nil {
		t.Fatal(err)
	}
	if meta.Name != "n" || meta.Description != "d" {
		t.Errorf("meta = %#v", meta)
	}
	if strings.Contains(body, "export") {
		t.Errorf("body still has export: %q", body)
	}
	if _, _, err := ExtractMeta(newTestVM(), "export const meta = notAnObject"); err == nil {
		t.Error("non-object meta must fail")
	}
	if _, _, err := ExtractMeta(newTestVM(), "export const meta = { name: 'x'"); err == nil {
		t.Error("unclosed meta must fail")
	}
	if _, _, err := ExtractMeta(newTestVM(), "export const meta = { name: undefinedVar, description: 'd' }"); err == nil {
		t.Error("non-literal meta must fail")
	}
	parsed, err := ParseScript("export const meta = { name: 'x', description: 'y', phases: [{ title: 'T' }] }\nreturn args.v * 2")
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Meta == nil || len(parsed.Meta.Phases) != 1 || parsed.Meta.Phases[0].Title != "T" {
		t.Errorf("parsed meta = %#v", parsed.Meta)
	}
	if _, err := ParseScript("return )"); err == nil || !strings.Contains(err.Error(), "Script syntax error") {
		t.Errorf("syntax error = %v", err)
	}
}
