package telemetry

import (
	"errors"
	"testing"
	"time"
)

type fakeClient struct{ protocol string }

type fakeEvent struct{ name string }

type fakeStreamEnd struct {
	usage      Usage
	stopReason string
}

func (e fakeStreamEnd) TelemetryStreamEnd() (Usage, string) { return e.usage, e.stopReason }

func TestRegisterLlmClientAndMetadata(t *testing.T) {
	client := &fakeClient{protocol: "anthropic"}
	returned := RegisterLlmClient(client, LlmMetadata{Model: "claude-x", Protocol: "anthropic"})
	if returned != client {
		t.Error("RegisterLlmClient must return the same client")
	}
	meta := metadataFor(client)
	if meta.Model != "claude-x" || meta.Protocol != "anthropic" {
		t.Errorf("metadataFor = %+v", meta)
	}
	unknown := metadataFor(&fakeClient{})
	if unknown.Model != "unknown" || unknown.Protocol != "unknown" {
		t.Errorf("unregistered client metadata = %+v, want unknown/unknown", unknown)
	}
}

func TestStartEndAgentTelemetry(t *testing.T) {
	fake := &fakeRuntime{}
	withRuntime(t, fake)
	client := RegisterLlmClient(&fakeClient{}, LlmMetadata{Model: "m", Protocol: "openai"})

	agentTelemetry := StartAgentTelemetry("session-1", client)
	if agentTelemetry.Protocol != "openai" {
		t.Errorf("protocol = %q", agentTelemetry.Protocol)
	}
	if len(fake.metrics) != 1 {
		t.Fatalf("metrics = %d, want 1", len(fake.metrics))
	}
	run := fake.metrics[0]
	if run.name != MetricAgentRuns || run.kind != MetricKindCounter || run.value != 1 {
		t.Errorf("agent runs metric = %+v", run)
	}
	if run.attrs["protocol"] != "openai" {
		t.Errorf("agent runs attrs = %+v", run.attrs)
	}
	if len(fake.rootNames) != 1 || fake.rootNames[0] != ObservationAgentRun {
		t.Errorf("root observations = %v", fake.rootNames)
	}
	root := fake.observations[0]
	if root.kind != ObservationKindAgent {
		t.Errorf("root kind = %q", root.kind)
	}
	if root.attrs[AttributeSessionHash] != "84097828fc31a8c8" {
		t.Errorf("session hash attr = %v", root.attrs[AttributeSessionHash])
	}

	EndAgentTelemetry(agentTelemetry, "completed")
	if !root.ended {
		t.Error("observation must be ended")
	}
	if len(root.updates) != 1 || root.updates[0].Metadata["outcome"] != "completed" || root.updates[0].Level != "" {
		t.Errorf("end updates = %+v", root.updates)
	}
	duration := fake.metrics[1]
	if duration.name != MetricAgentDuration || duration.kind != MetricKindHistogram {
		t.Errorf("duration metric = %+v", duration)
	}
	if duration.attrs["outcome"] != "completed" || duration.attrs["protocol"] != "openai" {
		t.Errorf("duration attrs = %+v", duration.attrs)
	}

	// Error outcome sets the ERROR level.
	agentTelemetry2 := StartAgentTelemetry("", client)
	root2 := fake.observations[len(fake.observations)-1]
	if _, ok := root2.attrs[AttributeSessionHash]; ok {
		t.Error("empty session id must not set the session hash attribute")
	}
	EndAgentTelemetry(agentTelemetry2, "error")
	if root2.updates[0].Level != ObservationLevelError {
		t.Errorf("error outcome level = %q", root2.updates[0].Level)
	}
}

func TestObserveLlmStreamCompleted(t *testing.T) {
	fake := &fakeRuntime{}
	withRuntime(t, fake)
	client := RegisterLlmClient(&fakeClient{}, LlmMetadata{Model: "m1", Protocol: "anthropic"})
	parent := StartAgentTelemetry("s", client)

	events := make(chan any, 3)
	errs := make(chan error, 1)
	events <- fakeEvent{name: "text"}
	events <- fakeStreamEnd{usage: Usage{InputTokens: 10, OutputTokens: 5, CacheReadTokens: 2}, stopReason: "end_turn"}
	close(events)
	close(errs)

	outEvents, outErrs := ObserveLlmStream(client, events, errs, parent)
	var received []any
	for event := range outEvents {
		received = append(received, event)
	}
	for range outErrs {
	}
	if len(received) != 2 {
		t.Fatalf("received %d events, want 2", len(received))
	}

	root := fake.observations[0]
	if root.kind != ObservationKindAgent {
		t.Fatalf("expected the agent root observation, got %q", root.kind)
	}
	if len(root.children) != 1 {
		t.Fatalf("children = %d, want 1", len(root.children))
	}
	generation := root.children[0]
	if generation.kind != ObservationKindGeneration || generation.name != ObservationLlmGenerate {
		t.Errorf("child = %q %q", generation.kind, generation.name)
	}
	if generation.attrs["model"] != "m1" || generation.attrs["protocol"] != "anthropic" {
		t.Errorf("child attrs = %+v", generation.attrs)
	}
	if !generation.ended {
		t.Error("generation must be ended")
	}
	if len(generation.updates) != 1 {
		t.Fatalf("generation updates = %+v", generation.updates)
	}
	update := generation.updates[0]
	if update.Model != "m1" || update.Metadata["outcome"] != "completed" || update.Metadata["stopReason"] != "end_turn" {
		t.Errorf("update = %+v", update)
	}
	if update.CompletionStartTime == nil {
		t.Error("completionStartTime must be set")
	}
	if update.UsageDetails["input"] != 10 || update.UsageDetails["output"] != 5 ||
		update.UsageDetails["cacheReadInput"] != 2 || update.UsageDetails["cacheCreationInput"] != 0 {
		t.Errorf("usageDetails = %+v", update.UsageDetails)
	}

	byName := map[string][]metricCall{}
	for _, m := range fake.metrics {
		byName[m.name] = append(byName[m.name], m)
	}
	if len(byName[MetricLlmRequests]) != 1 || byName[MetricLlmRequests][0].value != 1 {
		t.Errorf("llm requests = %+v", byName[MetricLlmRequests])
	}
	if len(byName[MetricLlmTimeToFirstToken]) != 1 {
		t.Errorf("time to first token = %+v", byName[MetricLlmTimeToFirstToken])
	}
	if len(byName[MetricLlmDuration]) != 1 || byName[MetricLlmDuration][0].attrs["outcome"] != "completed" {
		t.Errorf("llm duration = %+v", byName[MetricLlmDuration])
	}
	// Token metrics: cache_read, input, output (cache_creation is zero).
	tokens := byName[MetricLlmTokens]
	if len(tokens) != 3 {
		t.Fatalf("token metrics = %+v", tokens)
	}
	want := []struct {
		tokenType string
		value     float64
	}{{"cache_read", 2}, {"input", 10}, {"output", 5}}
	for i, w := range want {
		if tokens[i].attrs[AttributeTokenType] != w.tokenType || tokens[i].value != w.value {
			t.Errorf("token metric %d = %+v, want %s=%v", i, tokens[i], w.tokenType, w.value)
		}
	}
	if len(fake.logs) != 0 {
		t.Errorf("unexpected logs: %+v", fake.logs)
	}
}

func TestObserveLlmStreamError(t *testing.T) {
	fake := &fakeRuntime{}
	withRuntime(t, fake)
	client := RegisterLlmClient(&fakeClient{}, LlmMetadata{Model: "m1", Protocol: "openai"})
	parent := StartAgentTelemetry("s", client)

	events := make(chan any)
	errs := make(chan error, 1)
	close(events)
	streamErr := errors.New("provider failed")
	errs <- streamErr
	close(errs)

	outEvents, outErrs := ObserveLlmStream(client, events, errs, parent)
	// Consume both channels concurrently, like the agent run loop.
	done := make(chan struct{})
	var received []error
	go func() {
		defer close(done)
		for err := range outErrs {
			received = append(received, err)
		}
	}()
	for range outEvents {
	}
	<-done
	if len(received) != 1 || received[0] != streamErr {
		t.Fatalf("received errors = %v", received)
	}

	generation := fake.observations[0].children[0]
	if !generation.ended {
		t.Error("generation must be ended even on error")
	}
	if len(generation.errors) != 1 || generation.errors[0] != streamErr {
		t.Errorf("recorded exceptions = %v", generation.errors)
	}
	if len(generation.updates) != 1 || generation.updates[0].Metadata["outcome"] != "error" {
		t.Errorf("updates = %+v", generation.updates)
	}
	if len(fake.logs) != 1 || fake.logs[0].name != LogLlmError || fake.logs[0].severity != SeverityError {
		t.Fatalf("logs = %+v", fake.logs)
	}
	if fake.logs[0].attrs[AttributeErrorType] != "Error" {
		t.Errorf("error type attr = %v", fake.logs[0].attrs[AttributeErrorType])
	}
	var duration *metricCall
	for i, m := range fake.metrics {
		if m.name == MetricLlmDuration {
			duration = &fake.metrics[i]
		}
	}
	if duration == nil || duration.attrs["outcome"] != "error" {
		t.Errorf("duration metric = %+v", duration)
	}
}

func TestObserveLlmStreamIncomplete(t *testing.T) {
	fake := &fakeRuntime{}
	withRuntime(t, fake)
	client := RegisterLlmClient(&fakeClient{}, LlmMetadata{Model: "m1", Protocol: "openai"})
	parent := StartAgentTelemetry("s", client)

	events := make(chan any)
	errs := make(chan error)
	close(events)
	close(errs)
	outEvents, outErrs := ObserveLlmStream(client, events, errs, parent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for range outErrs {
		}
	}()
	for range outEvents {
	}
	<-done
	var duration *metricCall
	for i, m := range fake.metrics {
		if m.name == MetricLlmDuration {
			duration = &fake.metrics[i]
		}
	}
	if duration == nil || duration.attrs["outcome"] != "incomplete" {
		t.Errorf("duration metric = %+v, want outcome=incomplete", duration)
	}
}

type fakeToolResult struct{ isError bool }

func TestObserveToolExecutionCompleted(t *testing.T) {
	fake := &fakeRuntime{}
	withRuntime(t, fake)
	client := RegisterLlmClient(&fakeClient{}, LlmMetadata{Model: "m", Protocol: "p"})
	parent := StartAgentTelemetry("s", client)

	result := ObserveToolExecution("Bash", func() fakeToolResult {
		time.Sleep(2 * time.Millisecond)
		return fakeToolResult{isError: false}
	}, func(r fakeToolResult) bool { return r.isError }, parent)
	if result.isError {
		t.Error("result must pass through")
	}

	tool := fake.observations[0].children[0]
	if tool.kind != ObservationKindTool || tool.name != ObservationToolExecute || tool.attrs["tool"] != "Bash" {
		t.Errorf("tool observation = %q %q %+v", tool.kind, tool.name, tool.attrs)
	}
	if !tool.ended {
		t.Error("tool observation must be ended")
	}
	if len(tool.updates) != 1 {
		t.Fatalf("updates = %+v", tool.updates)
	}
	if tool.updates[0].Level != ObservationLevelDefault || tool.updates[0].Metadata["outcome"] != "completed" ||
		tool.updates[0].Metadata["tool"] != "Bash" || tool.updates[0].StatusMessage != "" {
		t.Errorf("update = %+v", tool.updates[0])
	}
	calls := 0
	durations := 0
	for _, m := range fake.metrics {
		if m.name == MetricToolCalls && m.kind == MetricKindCounter && m.value == 1 && m.attrs["tool"] == "Bash" {
			calls++
		}
		if m.name == MetricToolDuration && m.kind == MetricKindHistogram && m.attrs["outcome"] == "completed" {
			durations++
		}
	}
	if calls != 1 || durations != 1 {
		t.Errorf("calls = %d, durations = %d", calls, durations)
	}
}

func TestObserveToolExecutionError(t *testing.T) {
	fake := &fakeRuntime{}
	withRuntime(t, fake)
	client := RegisterLlmClient(&fakeClient{}, LlmMetadata{Model: "m", Protocol: "p"})
	parent := StartAgentTelemetry("s", client)

	ObserveToolExecution("Bash", func() fakeToolResult {
		return fakeToolResult{isError: true}
	}, func(r fakeToolResult) bool { return r.isError }, parent)

	tool := fake.observations[0].children[0]
	if tool.updates[0].Level != ObservationLevelError || tool.updates[0].StatusMessage != ToolErrorStatusMessage ||
		tool.updates[0].Metadata["outcome"] != "error" {
		t.Errorf("update = %+v", tool.updates[0])
	}
	if !tool.ended {
		t.Error("tool observation must be ended")
	}
}

func TestObserveToolExecutionPanic(t *testing.T) {
	fake := &fakeRuntime{}
	withRuntime(t, fake)
	client := RegisterLlmClient(&fakeClient{}, LlmMetadata{Model: "m", Protocol: "p"})
	parent := StartAgentTelemetry("s", client)

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("panic must propagate")
		}
		tool := fake.observations[0].children[0]
		if !tool.ended {
			t.Error("tool observation must be ended after a panic")
		}
		if len(tool.errors) != 1 {
			t.Errorf("recorded exceptions = %v", tool.errors)
		}
		if len(fake.logs) != 1 || fake.logs[0].name != LogToolError {
			t.Errorf("logs = %+v", fake.logs)
		}
	}()
	ObserveToolExecution("Bash", func() fakeToolResult {
		panic("boom")
	}, func(r fakeToolResult) bool { return r.isError }, parent)
}
