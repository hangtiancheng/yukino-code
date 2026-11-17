package telemetry

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// LlmMetadata is the model/protocol pair registered for an LLM client.
type LlmMetadata struct {
	Model    string
	Protocol string
}

// AgentTelemetry tracks one agent run observation.
type AgentTelemetry struct {
	Observation TelemetryObservation
	Protocol    string
	startedAt   time.Time
}

// AgentOutcome is one of "completed", "interrupted" or "error".
type AgentOutcome = string

// Usage mirrors llm.UsageInfo without importing the llm package (which
// imports telemetry for client registration).
type Usage struct {
	InputTokens         int
	OutputTokens        int
	CacheReadTokens     int
	CacheCreationTokens int
}

// StreamEndEvent is implemented by the provider stream completion event so the
// observation wrapper can read usage and stop reason without importing llm.
type StreamEndEvent interface {
	TelemetryStreamEnd() (Usage, string)
}

var llmMetadata sync.Map // client (comparable) -> LlmMetadata

func elapsedMilliseconds(startedAt time.Time) float64 {
	return float64(time.Since(startedAt).Microseconds()) / 1000.0
}

func sessionHash(sessionID string) string {
	if sessionID == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(sessionID))
	return hex.EncodeToString(sum[:])[:16]
}

func metadataFor(client any) LlmMetadata {
	if v, ok := llmMetadata.Load(client); ok {
		return v.(LlmMetadata)
	}
	return LlmMetadata{Model: "unknown", Protocol: "unknown"}
}

// errorTypeName mirrors `error.name` in the reference: the concrete error
// type's base name, with fmt.Errorf("%w") wrappers unwrapped and plain
// errors reported as "Error".
func errorTypeName(err error) string {
	if err == nil {
		return "unknown"
	}
	for {
		name := fmt.Sprintf("%T", err)
		if name == "*fmt.wrapError" {
			if inner := errors.Unwrap(err); inner != nil {
				err = inner
				continue
			}
		}
		name = strings.TrimPrefix(name, "*")
		if idx := strings.LastIndex(name, "."); idx >= 0 {
			name = name[idx+1:]
		}
		if name == "errorString" {
			return "Error"
		}
		return name
	}
}

func mergeAttributes(base TelemetryAttributes, extra TelemetryAttributes) TelemetryAttributes {
	merged := make(TelemetryAttributes, len(base)+len(extra))
	for k, v := range base {
		merged[k] = v
	}
	for k, v := range extra {
		merged[k] = v
	}
	return merged
}

func recordUsage(usage Usage, attributes TelemetryAttributes) {
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
		if entry.value > 0 {
			runtime.RecordMetric(MetricLlmTokens, MetricKindCounter, float64(entry.value),
				mergeAttributes(attributes, TelemetryAttributes{AttributeTokenType: entry.tokenType}))
		}
	}
}

// RegisterLlmClient records the model/protocol metadata for an LLM client.
func RegisterLlmClient[T any](client T, metadata LlmMetadata) T {
	llmMetadata.Store(client, metadata)
	return client
}

func StartAgentTelemetry(sessionID string, client any) *AgentTelemetry {
	runtime := GetTelemetryRuntime()
	metadata := metadataFor(client)
	hashedSessionID := sessionHash(sessionID)
	attributes := TelemetryAttributes{"protocol": metadata.Protocol}
	if hashedSessionID != "" {
		attributes[AttributeSessionHash] = hashedSessionID
	}
	runtime.RecordMetric(MetricAgentRuns, MetricKindCounter, 1, TelemetryAttributes{"protocol": metadata.Protocol})
	return &AgentTelemetry{
		Observation: runtime.StartObservation(ObservationKindAgent, ObservationAgentRun, attributes),
		Protocol:    metadata.Protocol,
		startedAt:   time.Now(),
	}
}

func EndAgentTelemetry(telemetry *AgentTelemetry, outcome AgentOutcome) {
	runtime := GetTelemetryRuntime()
	update := TelemetryObservationUpdate{Metadata: map[string]any{"outcome": outcome}}
	if outcome == "error" {
		update.Level = ObservationLevelError
	}
	telemetry.Observation.Update(update)
	telemetry.Observation.End()
	runtime.RecordMetric(MetricAgentDuration, MetricKindHistogram, elapsedMilliseconds(telemetry.startedAt),
		TelemetryAttributes{"outcome": outcome, "protocol": telemetry.Protocol})
}

// ObserveLlmStream wraps a provider event stream with a generation
// observation, mirroring the reference async-generator wrapper: the first
// non-completion event records time-to-first-token, the completion event
// records usage, and a stream error is recorded on the observation and
// forwarded to the consumer.
func ObserveLlmStream[E any](client any, events <-chan E, errs <-chan error, parent *AgentTelemetry) (<-chan E, <-chan error) {
	runtime := GetTelemetryRuntime()
	metadata := metadataFor(client)
	attributes := TelemetryAttributes{"model": metadata.Model, "protocol": metadata.Protocol}
	observation := parent.Observation.StartChild(ObservationKindGeneration, ObservationLlmGenerate, attributes)
	startedAt := time.Now()
	var completionStartTime *time.Time
	outcome := "incomplete"

	runtime.RecordMetric(MetricLlmRequests, MetricKindCounter, 1, attributes)

	outEvents := make(chan E)
	outErrs := make(chan error, 1)
	go func() {
		defer close(outEvents)
		defer close(outErrs)
		defer func() {
			observation.End()
			runtime.RecordMetric(MetricLlmDuration, MetricKindHistogram, elapsedMilliseconds(startedAt),
				mergeAttributes(attributes, TelemetryAttributes{"outcome": outcome}))
		}()
		errorRecorded := false
		for events != nil || errs != nil {
			select {
			case event, ok := <-events:
				if !ok {
					events = nil
					continue
				}
				end, isEnd := any(event).(StreamEndEvent)
				if completionStartTime == nil && !isEnd {
					now := time.Now()
					completionStartTime = &now
					runtime.RecordMetric(MetricLlmTimeToFirstToken, MetricKindHistogram, elapsedMilliseconds(startedAt), attributes)
				}
				if isEnd {
					outcome = "completed"
					usage, stopReason := end.TelemetryStreamEnd()
					observation.Update(TelemetryObservationUpdate{
						CompletionStartTime: completionStartTime,
						Metadata: map[string]any{
							"outcome":    outcome,
							"protocol":   metadata.Protocol,
							"stopReason": stopReason,
						},
						Model: metadata.Model,
						UsageDetails: map[string]float64{
							"cacheCreationInput": float64(usage.CacheCreationTokens),
							"cacheReadInput":     float64(usage.CacheReadTokens),
							"input":              float64(usage.InputTokens),
							"output":             float64(usage.OutputTokens),
						},
					})
					recordUsage(usage, attributes)
				}
				outEvents <- event
			case err, ok := <-errs:
				if !ok {
					errs = nil
					continue
				}
				if err == nil {
					continue
				}
				if !errorRecorded {
					errorRecorded = true
					outcome = "error"
					observation.RecordException(err)
					observation.Update(TelemetryObservationUpdate{Metadata: map[string]any{"outcome": outcome, "protocol": metadata.Protocol}})
					runtime.EmitLog(LogLlmError, SeverityError,
						mergeAttributes(attributes, TelemetryAttributes{AttributeErrorType: errorTypeName(err)}))
				}
				outErrs <- err
			}
		}
	}()
	return outEvents, outErrs
}

// ObserveToolExecution wraps a single tool execution with a tool observation.
func ObserveToolExecution[T any](toolName string, operation func() T, isError func(T) bool, parent *AgentTelemetry) (result T) {
	runtime := GetTelemetryRuntime()
	attributes := TelemetryAttributes{"tool": toolName}
	observation := parent.Observation.StartChild(ObservationKindTool, ObservationToolExecute, attributes)
	startedAt := time.Now()
	outcome := "error"

	runtime.RecordMetric(MetricToolCalls, MetricKindCounter, 1, attributes)

	defer func() {
		if r := recover(); r != nil {
			err := fmt.Errorf("%v", r)
			observation.RecordException(err)
			runtime.EmitLog(LogToolError, SeverityError, TelemetryAttributes{AttributeErrorType: errorTypeName(err), "tool": toolName})
			observation.End()
			runtime.RecordMetric(MetricToolDuration, MetricKindHistogram, elapsedMilliseconds(startedAt),
				TelemetryAttributes{"outcome": outcome, "tool": toolName})
			panic(r)
		}
		observation.End()
		runtime.RecordMetric(MetricToolDuration, MetricKindHistogram, elapsedMilliseconds(startedAt),
			TelemetryAttributes{"outcome": outcome, "tool": toolName})
	}()

	result = operation()
	if isError(result) {
		observation.Update(TelemetryObservationUpdate{
			Level:         ObservationLevelError,
			Metadata:      map[string]any{"outcome": outcome, "tool": toolName},
			StatusMessage: ToolErrorStatusMessage,
		})
	} else {
		outcome = "completed"
		observation.Update(TelemetryObservationUpdate{
			Level:    ObservationLevelDefault,
			Metadata: map[string]any{"outcome": outcome, "tool": toolName},
		})
	}
	return result
}
