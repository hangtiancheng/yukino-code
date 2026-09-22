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

package telemetry

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/config"
	"github.com/hangtiancheng/yukino-code/yukino/conversation"
	"github.com/hangtiancheng/yukino-code/yukino/llm"
)

// --- Recording fakes ---

type recordedMetric struct {
	name  string
	kind  MetricKind
	value float64
	attrs Attributes
}

type recordedLog struct {
	name     string
	severity LogSeverity
	attrs    Attributes
}

type recordedObservation struct {
	kind       ObservationKind
	name       string
	attrs      Attributes
	updates    []ObservationUpdate
	exceptions []error
	ended      bool
	children   []*recordedObservation
}

func (o *recordedObservation) End() { o.ended = true }

func (o *recordedObservation) RecordException(err error) {
	o.exceptions = append(o.exceptions, err)
}

func (o *recordedObservation) StartChild(kind ObservationKind, name string, attrs Attributes) Observation {
	child := &recordedObservation{kind: kind, name: name, attrs: attrs}
	o.children = append(o.children, child)
	return child
}

func (o *recordedObservation) Update(update ObservationUpdate) {
	o.updates = append(o.updates, update)
}

type recordingRuntime struct {
	mu           sync.Mutex
	metrics      []recordedMetric
	logs         []recordedLog
	observations []*recordedObservation
}

func (r *recordingRuntime) CaptureError(error, string) {}

func (r *recordingRuntime) EmitLog(name string, severity LogSeverity, attrs Attributes) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.logs = append(r.logs, recordedLog{name: name, severity: severity, attrs: attrs})
}

func (r *recordingRuntime) Flush(context.Context) error    { return nil }
func (r *recordingRuntime) SetMode(Mode)                   {}
func (r *recordingRuntime) Shutdown(context.Context) error { return nil }

func (r *recordingRuntime) RecordMetric(name string, kind MetricKind, value float64, attrs Attributes) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.metrics = append(r.metrics, recordedMetric{name: name, kind: kind, value: value, attrs: attrs})
}

func (r *recordingRuntime) StartObservation(kind ObservationKind, name string, attrs Attributes) Observation {
	obs := &recordedObservation{kind: kind, name: name, attrs: attrs}
	r.mu.Lock()
	r.observations = append(r.observations, obs)
	r.mu.Unlock()
	return obs
}

func (r *recordingRuntime) metricsNamed(name string) []recordedMetric {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []recordedMetric
	for _, m := range r.metrics {
		if m.name == name {
			out = append(out, m)
		}
	}
	return out
}

// installRecordingRuntime swaps the global runtime for a recorder and restores
// the pristine noop state afterwards.
func installRecordingRuntime(t *testing.T) *recordingRuntime {
	t.Helper()
	resetGlobals()
	runtime := &recordingRuntime{}
	mu.Lock()
	activeRuntime = runtime
	mu.Unlock()
	t.Cleanup(resetGlobals)
	return runtime
}

// fakeClient is a minimal llm.Client stand-in; each test uses a fresh instance
// so the metadata registry never collides across tests. The blank byte gives
// the struct a non-zero size: Go may reuse one address for multiple live
// zero-size allocations, which would collapse distinct instances into one
// metadata-map key.
type fakeClient struct{ _ byte }

func (fakeClient) Stream(context.Context, *conversation.Manager, []map[string]any) (<-chan llm.StreamEvent, <-chan error) {
	return nil, nil
}
func (fakeClient) SetSystemPrompt(string)                                       {}
func (fakeClient) Protocol() string                                             { return "" }
func (fakeClient) GetThinkingLevel() config.ThinkingLevel                       { return config.ThinkingOff }
func (fakeClient) SetThinkingLevel(l config.ThinkingLevel) config.ThinkingLevel { return l }
func (fakeClient) GetSupportedThinkingLevels() []config.ThinkingLevel           { return nil }

// --- Tests ---

func TestSessionHash(t *testing.T) {
	if got := sessionHash(""); got != "" {
		t.Errorf("sessionHash(\"\") = %q, want empty", got)
	}
	first := sessionHash("session-1")
	second := sessionHash("session-1")
	if first != second {
		t.Errorf("sessionHash must be deterministic: %q vs %q", first, second)
	}
	if len(first) != 16 {
		t.Errorf("sessionHash length = %d, want 16 (TS slices the hex digest to 16)", len(first))
	}
	if first == sessionHash("session-2") {
		t.Errorf("distinct session ids must hash differently")
	}
}

func TestRegisterLlmClientAndMetadataFor(t *testing.T) {
	client := &fakeClient{}
	returned := RegisterLlmClient(client, LlmMetadata{Model: "claude-x", Protocol: "anthropic"})
	if returned != llm.Client(client) {
		t.Errorf("RegisterLlmClient must return the same client (TS returns it for chaining)")
	}
	got := metadataFor(client)
	if got.Model != "claude-x" || got.Protocol != "anthropic" {
		t.Errorf("metadataFor = %+v, want the registered metadata", got)
	}
	// An unregistered client falls back to unknown/unknown (TS instrumentation.ts:55-62).
	fallback := metadataFor(&fakeClient{})
	if fallback.Model != "unknown" || fallback.Protocol != "unknown" {
		t.Errorf("metadataFor fallback = %+v, want unknown/unknown", fallback)
	}
}

func TestInstrumentationNoopRuntimeZeroCost(t *testing.T) {
	resetGlobals()
	t.Cleanup(resetGlobals)

	client := &fakeClient{}
	if telemetryHandle := StartAgentTelemetry("session", client); telemetryHandle != nil {
		t.Fatalf("StartAgentTelemetry must return nil under the noop runtime, got %+v", telemetryHandle)
	}
	// Nil handle: End is a no-op, Observe passes the original channels through.
	EndAgentTelemetry(nil, AgentOutcomeCompleted)

	events := make(chan llm.StreamEvent)
	errs := make(chan error)
	gotEvents, gotErrs := ObserveLlmStream(context.Background(), client, events, errs, nil)
	if gotEvents != (<-chan llm.StreamEvent)(events) || gotErrs != (<-chan error)(errs) {
		t.Errorf("ObserveLlmStream must return the original channels when telemetry is off")
	}
}

func TestStartEndAgentTelemetry(t *testing.T) {
	runtime := installRecordingRuntime(t)
	client := &fakeClient{}
	RegisterLlmClient(client, LlmMetadata{Model: "gpt-test", Protocol: "openai"})

	handle := StartAgentTelemetry("session-42", client)
	if handle == nil {
		t.Fatalf("StartAgentTelemetry must return a handle under a real runtime")
	}
	if handle.Protocol != "openai" {
		t.Errorf("handle.Protocol = %q, want openai", handle.Protocol)
	}

	runs := runtime.metricsNamed("yukino.agent.runs")
	if len(runs) != 1 || runs[0].kind != MetricCounter || runs[0].value != 1 {
		t.Fatalf("yukino.agent.runs metrics = %+v, want a single counter increment of 1", runs)
	}
	if runs[0].attrs["protocol"] != "openai" {
		t.Errorf("yukino.agent.runs attrs = %+v, want protocol=openai", runs[0].attrs)
	}

	if len(runtime.observations) != 1 {
		t.Fatalf("observations = %d, want 1", len(runtime.observations))
	}
	root := runtime.observations[0]
	if root.kind != ObservationAgent || root.name != "yukino.agent.run" {
		t.Errorf("root observation = (%q, %q), want (agent, yukino.agent.run)", root.kind, root.name)
	}
	if root.attrs["protocol"] != "openai" || root.attrs["session.hash"] != sessionHash("session-42") {
		t.Errorf("root observation attrs = %+v, want protocol + session.hash", root.attrs)
	}

	EndAgentTelemetry(handle, AgentOutcomeInterrupted)

	if !root.ended {
		t.Errorf("root observation must be ended by EndAgentTelemetry")
	}
	if len(root.updates) != 1 || root.updates[0].Metadata["outcome"] != "interrupted" {
		t.Errorf("root updates = %+v, want a single outcome=interrupted metadata update", root.updates)
	}
	durations := runtime.metricsNamed("yukino.agent.duration")
	if len(durations) != 1 || durations[0].kind != MetricHistogram {
		t.Fatalf("yukino.agent.duration metrics = %+v, want a single histogram sample", durations)
	}
	if durations[0].attrs["outcome"] != "interrupted" || durations[0].attrs["protocol"] != "openai" {
		t.Errorf("yukino.agent.duration attrs = %+v, want outcome+protocol", durations[0].attrs)
	}
	if durations[0].value < 0 {
		t.Errorf("yukino.agent.duration value = %v, want a non-negative elapsed ms", durations[0].value)
	}
}

// startObservedStream builds a registered client plus an AgentTelemetry handle
// for the ObserveLlmStream tests.
func startObservedStream(t *testing.T, runtime *recordingRuntime) (*AgentTelemetry, llm.Client) {
	t.Helper()
	client := &fakeClient{}
	RegisterLlmClient(client, LlmMetadata{Model: "claude-x", Protocol: "anthropic"})
	handle := StartAgentTelemetry("s", client)
	if handle == nil {
		t.Fatalf("expected a telemetry handle")
	}
	if len(runtime.observations) != 1 {
		t.Fatalf("expected the agent root observation")
	}
	return handle, client
}

func generationChild(t *testing.T, runtime *recordingRuntime) *recordedObservation {
	t.Helper()
	root := runtime.observations[0]
	if len(root.children) != 1 {
		t.Fatalf("generation children = %d, want 1", len(root.children))
	}
	child := root.children[0]
	if child.kind != ObservationGeneration || child.name != "yukino.llm.generate" {
		t.Errorf("child observation = (%q, %q), want (generation, yukino.llm.generate)", child.kind, child.name)
	}
	if child.attrs["model"] != "claude-x" || child.attrs["protocol"] != "anthropic" {
		t.Errorf("child attrs = %+v, want model+protocol", child.attrs)
	}
	return child
}

func TestObserveLlmStreamHappyPath(t *testing.T) {
	runtime := installRecordingRuntime(t)
	handle, client := startObservedStream(t, runtime)

	sourceEvents := make(chan llm.StreamEvent, 4)
	sourceErrs := make(chan error, 1)
	sourceEvents <- llm.TextDelta{Text: "hello"}
	sourceEvents <- llm.StreamEnd{
		StopReason: "end_turn",
		Usage: llm.UsageInfo{
			InputTokens:         10,
			OutputTokens:        5,
			CacheReadTokens:     3,
			CacheCreationTokens: 2,
		},
	}
	close(sourceEvents)
	close(sourceErrs)

	events, errs := ObserveLlmStream(context.Background(), client, sourceEvents, sourceErrs, handle)

	var got []llm.StreamEvent
	for ev := range events {
		got = append(got, ev)
	}
	if len(got) != 2 {
		t.Fatalf("forwarded %d events, want 2 (passthrough)", len(got))
	}
	if _, ok := got[0].(llm.TextDelta); !ok {
		t.Errorf("first forwarded event = %T, want llm.TextDelta", got[0])
	}
	if _, ok := got[1].(llm.StreamEnd); !ok {
		t.Fatalf("second forwarded event = %T, want llm.StreamEnd", got[1])
	}
	select {
	case err, open := <-errs:
		if open && err != nil {
			t.Errorf("unexpected forwarded error %v", err)
		}
	default:
	}

	if requests := runtime.metricsNamed("yukino.llm.requests"); len(requests) != 1 || requests[0].value != 1 {
		t.Errorf("yukino.llm.requests = %+v, want a single counter increment", requests)
	}
	ttft := runtime.metricsNamed("yukino.llm.time_to_first_token")
	if len(ttft) != 1 || ttft[0].kind != MetricHistogram {
		t.Fatalf("time_to_first_token = %+v, want exactly one histogram sample", ttft)
	}
	if ttft[0].attrs["model"] != "claude-x" || ttft[0].attrs["protocol"] != "anthropic" {
		t.Errorf("time_to_first_token attrs = %+v, want model+protocol", ttft[0].attrs)
	}

	// One yukino.llm.tokens increment per positive bucket (TS recordUsage).
	tokens := runtime.metricsNamed("yukino.llm.tokens")
	byType := map[string]float64{}
	for _, m := range tokens {
		if m.kind != MetricCounter {
			t.Errorf("yukino.llm.tokens kind = %q, want counter", m.kind)
		}
		tokenType, _ := m.attrs["token.type"].(string)
		byType[tokenType] = m.value
		if m.attrs["model"] != "claude-x" {
			t.Errorf("yukino.llm.tokens attrs = %+v, want the stream attributes merged in", m.attrs)
		}
	}
	want := map[string]float64{"cache_creation": 2, "cache_read": 3, "input": 10, "output": 5}
	for tokenType, value := range want {
		if byType[tokenType] != value {
			t.Errorf("yukino.llm.tokens[%s] = %v, want %v", tokenType, byType[tokenType], value)
		}
	}
	if len(byType) != len(want) {
		t.Errorf("yukino.llm.tokens buckets = %+v, want exactly %v", byType, want)
	}

	child := generationChild(t, runtime)
	if !child.ended {
		t.Errorf("generation observation must be ended (TS finally)")
	}
	if len(child.updates) != 1 {
		t.Fatalf("generation updates = %+v, want the single stream_end update", child.updates)
	}
	update := child.updates[0]
	if update.Metadata["outcome"] != "completed" || update.Metadata["stopReason"] != "end_turn" || update.Metadata["protocol"] != "anthropic" {
		t.Errorf("generation metadata = %+v, want outcome/stopReason/protocol", update.Metadata)
	}
	if update.Model != "claude-x" || update.CompletionStartTime == nil {
		t.Errorf("generation update = %+v, want model + completionStartTime", update)
	}
	wantUsage := map[string]float64{"cacheCreationInput": 2, "cacheReadInput": 3, "input": 10, "output": 5}
	for key, value := range wantUsage {
		if update.UsageDetails[key] != value {
			t.Errorf("usageDetails[%s] = %v, want %v", key, update.UsageDetails[key], value)
		}
	}

	durations := runtime.metricsNamed("yukino.llm.duration")
	if len(durations) != 1 || durations[0].attrs["outcome"] != "completed" {
		t.Errorf("yukino.llm.duration = %+v, want one sample with outcome=completed", durations)
	}
}

func TestObserveLlmStreamEndOnlyHasNoFirstToken(t *testing.T) {
	runtime := installRecordingRuntime(t)
	handle, client := startObservedStream(t, runtime)

	sourceEvents := make(chan llm.StreamEvent, 1)
	sourceErrs := make(chan error, 1)
	sourceEvents <- llm.StreamEnd{StopReason: "end_turn"}
	close(sourceEvents)
	close(sourceErrs)

	events, _ := ObserveLlmStream(context.Background(), client, sourceEvents, sourceErrs, handle)
	for range events {
	}

	// TS instrumentation.ts:157 — stream_end alone must not count as a first token.
	if ttft := runtime.metricsNamed("yukino.llm.time_to_first_token"); len(ttft) != 0 {
		t.Errorf("time_to_first_token = %+v, want none for a stream_end-only stream", ttft)
	}
}

func TestObserveLlmStreamError(t *testing.T) {
	runtime := installRecordingRuntime(t)
	handle, client := startObservedStream(t, runtime)

	streamErr := errors.New("boom")
	sourceEvents := make(chan llm.StreamEvent, 1)
	sourceErrs := make(chan error, 1)
	close(sourceEvents)
	sourceErrs <- streamErr
	close(sourceErrs)

	events, errs := ObserveLlmStream(context.Background(), client, sourceEvents, sourceErrs, handle)
	for range events {
	}

	var forwarded []error
	for err := range errs {
		forwarded = append(forwarded, err)
	}
	if len(forwarded) != 1 || !errors.Is(forwarded[0], streamErr) {
		t.Fatalf("forwarded errors = %v, want the original error untouched", forwarded)
	}

	child := generationChild(t, runtime)
	if !child.ended {
		t.Errorf("generation observation must be ended even on error (TS finally)")
	}
	if len(child.exceptions) != 1 || !errors.Is(child.exceptions[0], streamErr) {
		t.Errorf("recorded exceptions = %v, want the stream error", child.exceptions)
	}
	foundErrorOutcome := false
	for _, update := range child.updates {
		if update.Metadata["outcome"] == "error" {
			foundErrorOutcome = true
		}
	}
	if !foundErrorOutcome {
		t.Errorf("generation updates = %+v, want an outcome=error metadata update", child.updates)
	}

	var errorLogs []recordedLog
	runtime.mu.Lock()
	for _, entry := range runtime.logs {
		if entry.name == "yukino.llm.error" {
			errorLogs = append(errorLogs, entry)
		}
	}
	runtime.mu.Unlock()
	if len(errorLogs) != 1 || errorLogs[0].severity != LogSeverityError {
		t.Fatalf("yukino.llm.error logs = %+v, want one error-severity log", errorLogs)
	}
	if errorLogs[0].attrs["model"] != "claude-x" || errorLogs[0].attrs["error.type"] == nil {
		t.Errorf("yukino.llm.error attrs = %+v, want error.type + stream attributes", errorLogs[0].attrs)
	}

	durations := runtime.metricsNamed("yukino.llm.duration")
	if len(durations) != 1 || durations[0].attrs["outcome"] != "error" {
		t.Errorf("yukino.llm.duration = %+v, want one sample with outcome=error", durations)
	}
}

func TestObserveLlmStreamInterruptedDrainsAndFinishes(t *testing.T) {
	runtime := installRecordingRuntime(t)
	handle, client := startObservedStream(t, runtime)

	ctx, cancel := context.WithCancel(context.Background())
	sourceEvents := make(chan llm.StreamEvent)
	sourceErrs := make(chan error, 1)

	// Producer mirroring the llm clients: plain sends, exits on ctx and closes
	// both channels.
	go func() {
		defer close(sourceEvents)
		defer close(sourceErrs)
		for i := 0; ; i++ {
			select {
			case <-ctx.Done():
				sourceErrs <- errors.New("context cancelled")
				return
			case sourceEvents <- llm.TextDelta{Text: "chunk"}:
			}
		}
	}()

	events, _ := ObserveLlmStream(ctx, client, sourceEvents, sourceErrs, handle)

	// Consume one event, then interrupt and stop consuming — the agent's
	// mid-stream break (agent.go: ctx.Err() check inside the event loop).
	if _, ok := <-events; !ok {
		t.Fatalf("expected the first forwarded event")
	}
	cancel()

	// The wrapper must drain the producer and close its channels even though
	// nobody reads them anymore (TS generator finally-on-return).
	deadline := time.After(5 * time.Second)
	closed := false
	for !closed {
		select {
		case _, ok := <-events:
			closed = !ok
		case <-deadline:
			t.Fatalf("wrapped events channel was never closed after interruption")
		}
	}

	durations := runtime.metricsNamed("yukino.llm.duration")
	if len(durations) != 1 {
		t.Fatalf("yukino.llm.duration = %+v, want exactly one sample", durations)
	}
	if durations[0].attrs["outcome"] != "incomplete" {
		t.Errorf("yukino.llm.duration outcome = %v, want incomplete (TS interrupted stream)", durations[0].attrs["outcome"])
	}
	// The cancellation error must not drive the TS catch branch.
	child := generationChild(t, runtime)
	if len(child.exceptions) != 0 {
		t.Errorf("exceptions = %v, want none for an interruption", child.exceptions)
	}
	if logs := runtime.metricsNamed("yukino.llm.error"); len(logs) != 0 {
		t.Errorf("unexpected yukino.llm.error metrics %+v", logs)
	}
}
