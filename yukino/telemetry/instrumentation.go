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

// This file is the Go port of the TypeScript library's
// src/telemetry/instrumentation.ts: the agent-run and LLM-stream observation
// helpers plus the client metadata registry. Everything is emitted through the
// Runtime interface (StartObservation/RecordMetric/EmitLog) — never through
// the OTel SDK directly — so a noop runtime makes every entry point a
// zero-cost passthrough.
//
// Semantic differences from the TS original:
//
//   - The TS llmMetadata WeakMap becomes a mutex-guarded map keyed by the
//     llm.Client interface value. Go has no weak references, so entries live
//     as long as the process; they are tiny (two strings per client) and
//     clients are created once per session. Non-comparable client values are
//     silently skipped instead of panicking on the map write.
//   - TS createClient registers the metadata inside llm/client.ts. The Go llm
//     package cannot import telemetry (telemetry imports llm for the stream
//     types), so it exposes a registrar hook that this package installs at
//     init (llm.SetClientRegistrar); llm.NewClient then registers every
//     client exactly like TS createClient. An unregistered client falls back
//     to {"unknown", client.Protocol()} — the same shape as the TS fallback.
//   - observeLlmStream is an async generator in TS: breaking out of the
//     for-await loop runs its finally block via generator.return(). The Go
//     port wraps the (<-chan llm.StreamEvent, <-chan error) pair returned by
//     llm.Client.Stream and therefore takes a context: when the consumer
//     stops early (the agent breaks out on ctx cancellation) the wrapper
//     drains the source channels so the producer goroutine can finish, then
//     runs the same end/duration bookkeeping as the TS finally.
//   - A stream error arriving while ctx is already cancelled is treated as
//     the interruption itself (outcome stays "incomplete", matching TS where
//     an aborted consumer never sees the throw) instead of the error branch.
//   - observeToolExecution wraps the tool execution inside
//     Agent.executeSingleTool; a panicking tool records the exception and
//     re-panics so the agent's own recovery still observes it.
//   - StartAgentTelemetry returns nil under the noop runtime (TS always
//     returns an object wrapping the noop observation); EndAgentTelemetry and
//     ObserveLlmStream accept nil and degrade to no-ops / passthroughs.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"reflect"
	"sync"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/llm"
	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

// LlmMetadata mirrors the TS LlmMetadata interface.
type LlmMetadata struct {
	Model    string
	Protocol string
}

// AgentOutcome mirrors the TS endAgentTelemetry outcome union
// ("completed" | "interrupted").
type AgentOutcome string

const (
	AgentOutcomeCompleted   AgentOutcome = "completed"
	AgentOutcomeInterrupted AgentOutcome = "interrupted"
)

// AgentTelemetry mirrors the TS AgentTelemetry interface. startedAt is a
// monotonic time.Now reading; elapsed time is computed with time.Since.
type AgentTelemetry struct {
	Observation Observation
	Protocol    string
	startedAt   time.Time
}

var (
	llmMetadataMu sync.RWMutex
	llmMetadata   = map[llm.Client]LlmMetadata{}
)

// comparableClient reports whether client can safely be used as a map key
// (the TS WeakMap accepts any object; a Go map write panics on non-comparable
// dynamic types such as structs holding maps or slices).
func comparableClient(client llm.Client) bool {
	if client == nil {
		return false
	}
	t := reflect.TypeOf(client)
	return t.Comparable()
}

// RegisterLlmClient mirrors the TS registerLlmClient: attach telemetry
// metadata to a client and return it. TS calls it inside createClient; the Go
// llm package cannot import telemetry (the dependency runs the other way), so
// the init hook below installs this into llm.SetClientRegistrar and
// llm.NewClient calls it at construction. Clients with a non-comparable
// dynamic type are returned unregistered; metadataFor then uses the fallback.
func RegisterLlmClient(client llm.Client, metadata LlmMetadata) llm.Client {
	if !comparableClient(client) {
		return client
	}
	llmMetadataMu.Lock()
	llmMetadata[client] = metadata
	llmMetadataMu.Unlock()
	return client
}

func init() {
	// TS: createClient wraps every constructed client in registerLlmClient
	// with the provider's model and protocol.
	llm.SetClientRegistrar(func(client llm.Client, model, protocol string) {
		RegisterLlmClient(client, LlmMetadata{Model: model, Protocol: protocol})
	})
}

// metadataFor mirrors the TS metadataFor: registered metadata, else the
// fallback reading the client's own protocol (TS: client.protocol ??
// "unknown") with an unknown model.
func metadataFor(client llm.Client) LlmMetadata {
	if comparableClient(client) {
		llmMetadataMu.RLock()
		metadata, ok := llmMetadata[client]
		llmMetadataMu.RUnlock()
		if ok {
			return metadata
		}
	}
	protocol := "unknown"
	if client != nil {
		if p := client.Protocol(); p != "" {
			protocol = p
		}
	}
	return LlmMetadata{Model: "unknown", Protocol: protocol}
}

// elapsedMilliseconds mirrors the TS elapsedMilliseconds (performance.now
// delta); time.Since uses the monotonic clock reading captured with startedAt.
func elapsedMilliseconds(startedAt time.Time) float64 {
	return float64(time.Since(startedAt)) / float64(time.Millisecond)
}

// sessionHash mirrors the TS sessionHash: first 16 hex chars of the SHA-256
// digest, empty for an empty session id (TS undefined).
func sessionHash(sessionID string) string {
	if sessionID == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(sessionID))
	return hex.EncodeToString(sum[:])[:16]
}

// isNoopRuntime reports whether the active runtime is the package noop, the
// signal every instrumentation entry point uses to stay zero-cost.
func isNoopRuntime(runtime Runtime) bool {
	_, ok := runtime.(noopRuntime)
	return ok
}

// recordUsage mirrors the TS recordUsage: one yukino.llm.tokens counter
// increment per positive token bucket, each tagged with token.type.
func recordUsage(usage llm.UsageInfo, attributes Attributes) {
	runtime := GetTelemetryRuntime()
	values := []struct {
		tokenType string
		value     int
	}{
		{"cache_creation", usage.CacheCreationTokens},
		{"cache_read", usage.CacheReadTokens},
		{"input", usage.InputTokens},
		{"output", usage.OutputTokens},
	}
	for _, entry := range values {
		if entry.value <= 0 {
			continue
		}
		attrs := make(Attributes, len(attributes)+1)
		for key, value := range attributes {
			attrs[key] = value
		}
		attrs["token.type"] = entry.tokenType
		runtime.RecordMetric("yukino.llm.tokens", MetricCounter, float64(entry.value), attrs)
	}
}

// StartAgentTelemetry mirrors the TS startAgentTelemetry: count the run, open
// the "agent" root observation and return the handle the stream/tool helpers
// attach children to. Returns nil under the noop runtime so the whole
// instrumentation chain costs nothing when telemetry is disabled;
// EndAgentTelemetry and ObserveLlmStream accept the nil handle.
func StartAgentTelemetry(sessionID string, client llm.Client) *AgentTelemetry {
	runtime := GetTelemetryRuntime()
	if isNoopRuntime(runtime) {
		return nil
	}
	metadata := metadataFor(client)
	attributes := Attributes{"protocol": metadata.Protocol}
	if hashed := sessionHash(sessionID); hashed != "" {
		attributes["session.hash"] = hashed
	}
	runtime.RecordMetric("yukino.agent.runs", MetricCounter, 1, Attributes{
		"protocol": metadata.Protocol,
	})
	return &AgentTelemetry{
		Observation: runtime.StartObservation(ObservationAgent, "yukino.agent.run", attributes),
		Protocol:    metadata.Protocol,
		startedAt:   time.Now(),
	}
}

// EndAgentTelemetry mirrors the TS endAgentTelemetry: stamp the outcome on
// the agent observation, end it and record the run duration. Nil-safe (noop
// runtime path).
func EndAgentTelemetry(telemetry *AgentTelemetry, outcome AgentOutcome) {
	if telemetry == nil {
		return
	}
	runtime := GetTelemetryRuntime()
	telemetry.Observation.Update(ObservationUpdate{
		Metadata: map[string]any{"outcome": string(outcome)},
	})
	telemetry.Observation.End()
	runtime.RecordMetric("yukino.agent.duration", MetricHistogram, elapsedMilliseconds(telemetry.startedAt), Attributes{
		"outcome":  string(outcome),
		"protocol": telemetry.Protocol,
	})
}

// ObserveLlmStream mirrors the TS observeLlmStream generator: it wraps the
// channel pair returned by llm.Client.Stream, opens a "generation" child
// observation on the agent run, records yukino.llm.requests,
// yukino.llm.time_to_first_token (first non-StreamEnd event), the
// yukino.llm.tokens buckets from StreamEnd.Usage and yukino.llm.duration on
// completion, and passes every event through unchanged.
//
// Stream errors surface on the errs channel in Go instead of being thrown:
// a non-nil error (while ctx is still live) drives the TS catch branch —
// recordException, outcome metadata and the yukino.llm.error log — before the
// error is forwarded untouched. When ctx is cancelled the consumer is gone
// (the agent breaks out of its event loop on interruption); the wrapper then
// drains the source channels so the producer can finish and closes the
// wrapped pair with outcome "incomplete", matching the TS finally-on-return.
//
// With a nil parent (noop runtime) or a noop runtime the original channels
// are returned as-is: zero goroutines, zero overhead, identical behavior.
func ObserveLlmStream(ctx context.Context, client llm.Client, events <-chan llm.StreamEvent, errs <-chan error, parent *AgentTelemetry) (<-chan llm.StreamEvent, <-chan error) {
	if parent == nil {
		return events, errs
	}
	runtime := GetTelemetryRuntime()
	if isNoopRuntime(runtime) {
		return events, errs
	}

	metadata := metadataFor(client)
	attributes := Attributes{
		"model":    metadata.Model,
		"protocol": metadata.Protocol,
	}
	observation := parent.Observation.StartChild(ObservationGeneration, "yukino.llm.generate", attributes)
	startedAt := time.Now()

	runtime.RecordMetric("yukino.llm.requests", MetricCounter, 1, attributes)

	// Buffer sizes mirror the llm clients' own channels (anthropic.go:
	// events 64, errs 1) so wrapping does not change backpressure.
	outEvents := make(chan llm.StreamEvent, 64)
	outErrs := make(chan error, 1)

	go func() {
		outcome := "incomplete"
		// LIFO: the observation end + duration metric (registered last) run
		// first, then the channels close — a consumer whose range over
		// outEvents completes therefore observes the finished generation,
		// matching the TS generator whose finally block runs before the
		// consumer's for-await sees the end of the stream. The close order
		// mirrors the llm producers (errs closed before events) so the
		// agent's non-blocking error check right after its event loop
		// behaves exactly as it does on the unwrapped channels.
		defer close(outEvents)
		defer close(outErrs)
		defer func() {
			observation.End()
			durationAttrs := make(Attributes, len(attributes)+1)
			for key, value := range attributes {
				durationAttrs[key] = value
			}
			durationAttrs["outcome"] = outcome
			runtime.RecordMetric("yukino.llm.duration", MetricHistogram, elapsedMilliseconds(startedAt), durationAttrs)
		}()

		var completionStartTime *time.Time
	forward:
		for {
			select {
			case <-ctx.Done():
				break forward
			case event, ok := <-events:
				if !ok {
					break forward
				}
				_, isEnd := event.(llm.StreamEnd)
				if completionStartTime == nil && !isEnd {
					now := time.Now()
					completionStartTime = &now
					runtime.RecordMetric("yukino.llm.time_to_first_token", MetricHistogram, elapsedMilliseconds(startedAt), attributes)
				}
				if isEnd {
					end := event.(llm.StreamEnd)
					outcome = "completed"
					observation.Update(ObservationUpdate{
						CompletionStartTime: completionStartTime,
						Metadata: map[string]any{
							"outcome":    outcome,
							"protocol":   metadata.Protocol,
							"stopReason": end.StopReason,
						},
						Model: metadata.Model,
						UsageDetails: map[string]float64{
							"cacheCreationInput": float64(end.Usage.CacheCreationTokens),
							"cacheReadInput":     float64(end.Usage.CacheReadTokens),
							"input":              float64(end.Usage.InputTokens),
							"output":             float64(end.Usage.OutputTokens),
						},
					})
					recordUsage(end.Usage, attributes)
				}
				select {
				case outEvents <- event:
				case <-ctx.Done():
					break forward
				}
			}
		}

		// The consumer stopped early (interruption): keep draining so the
		// producer's sends never block and it can observe ctx and finish —
		// the Go analogue of the TS generator finally-on-return. A no-op
		// when events is already closed.
		if ctx.Err() != nil {
			for range events {
			}
		}

		// Forward stream errors before closing outEvents so the agent's
		// non-blocking errs check right after its event loop still sees them
		// (the llm producers close errs before events, so this never waits).
		for err := range errs {
			if err != nil && ctx.Err() == nil {
				outcome = "error"
				observation.RecordException(err)
				observation.Update(ObservationUpdate{
					Metadata: map[string]any{"outcome": outcome, "protocol": metadata.Protocol},
				})
				runtime.EmitLog("yukino.llm.error", LogSeverityError, Attributes{
					"error.type": errorTypeName(err),
					"model":      metadata.Model,
					"protocol":   metadata.Protocol,
				})
			}
			outErrs <- err
		}
	}()

	return outEvents, outErrs
}

// asRecoveredError normalizes a recovered panic value into an error.
func asRecoveredError(v any) error {
	if err, ok := v.(error); ok {
		return err
	}
	return fmt.Errorf("%v", v)
}

// ObserveToolExecution wraps one tool execution in a tool observation (TS:
// observeToolExecution): a yukino.tool.execute child under the agent-run
// observation, the yukino.tool.calls counter, the yukino.tool.duration
// histogram and a yukino.tool.error log when the tool panics. A nil parent
// (noop telemetry) runs the tool directly, keeping the hot path zero-cost.
func ObserveToolExecution(toolName string, parent *AgentTelemetry, operation func() tools.ToolResult) (result tools.ToolResult) {
	if parent == nil || parent.Observation == nil {
		return operation()
	}
	runtime := GetTelemetryRuntime()
	attrs := Attributes{"tool": toolName}
	observation := parent.Observation.StartChild(ObservationTool, "yukino.tool.execute", attrs)
	startedAt := time.Now()
	outcome := "error"
	runtime.RecordMetric("yukino.tool.calls", MetricCounter, 1, attrs)
	defer func() {
		if err := recover(); err != nil {
			// TS catch branch: record the exception, emit the error log,
			// then re-throw so the caller's recovery still sees the panic.
			recoveredErr := asRecoveredError(err)
			observation.RecordException(recoveredErr)
			runtime.EmitLog("yukino.tool.error", LogSeverityError, Attributes{
				"error.type": errorTypeName(recoveredErr),
				"tool":       toolName,
			})
			observation.End()
			runtime.RecordMetric("yukino.tool.duration", MetricHistogram, elapsedMilliseconds(startedAt), Attributes{
				"outcome": outcome,
				"tool":    toolName,
			})
			panic(err)
		}
		// TS finally: end the observation and record the duration metric.
		observation.End()
		runtime.RecordMetric("yukino.tool.duration", MetricHistogram, elapsedMilliseconds(startedAt), Attributes{
			"outcome": outcome,
			"tool":    toolName,
		})
	}()
	result = operation()
	if result.IsError {
		outcome = "error"
		observation.Update(ObservationUpdate{
			Level:         ObservationLevelError,
			Metadata:      map[string]any{"outcome": outcome, "tool": toolName},
			StatusMessage: "Tool returned an error",
		})
	} else {
		outcome = "completed"
		observation.Update(ObservationUpdate{
			Level:    ObservationLevelDefault,
			Metadata: map[string]any{"outcome": outcome, "tool": toolName},
		})
	}
	return result
}
