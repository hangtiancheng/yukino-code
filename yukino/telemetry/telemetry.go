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

// Package telemetry is the Go port of the TypeScript library's src/telemetry
// module: runtime/observation interfaces, a noop implementation, the global
// runtime variable, the environment-variable gate that decides whether a real
// telemetry stack is loaded, and the real OpenTelemetry providers (see
// providers.go).
//
// Like the TS initializeTelemetry dynamically importing ./providers.js,
// InitializeTelemetry installs the provider-backed runtime when the gate
// passes. The Sentry integration is ported via sentry-go and the
// instrumentation.ts helpers live in instrumentation.go. See the file comment
// in providers.go for the full list of semantic differences.
package telemetry

import (
	"context"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Mode mirrors the TS TelemetryMode union.
type Mode string

const (
	ModePrint    Mode = "print"
	ModeRemote   Mode = "remote"
	ModeTeammate Mode = "teammate"
	ModeTerminal Mode = "terminal"
	ModeUnknown  Mode = "unknown"
)

// ObservationKind mirrors the TS TelemetryObservationKind union.
type ObservationKind string

const (
	ObservationAgent      ObservationKind = "agent"
	ObservationGeneration ObservationKind = "generation"
	ObservationTool       ObservationKind = "tool"
)

// MetricKind mirrors the TS TelemetryMetricKind union.
type MetricKind string

const (
	MetricCounter   MetricKind = "counter"
	MetricHistogram MetricKind = "histogram"
)

// LogSeverity mirrors the TS emitLog severity union ("error" | "info" | "warn").
type LogSeverity string

const (
	LogSeverityError LogSeverity = "error"
	LogSeverityInfo  LogSeverity = "info"
	LogSeverityWarn  LogSeverity = "warn"
)

// ObservationLevel mirrors the TS update level union.
type ObservationLevel string

const (
	ObservationLevelDefault ObservationLevel = "DEFAULT"
	ObservationLevelError   ObservationLevel = "ERROR"
	ObservationLevelWarning ObservationLevel = "WARNING"
)

// Attributes mirrors the TS TelemetryAttributes record
// (Record<string, string | number | boolean>); values are string, numeric or
// bool.
type Attributes map[string]any

// ObservationUpdate mirrors the TS TelemetryObservationUpdate interface. All
// fields are optional in TS; the Go zero value means "not set".
type ObservationUpdate struct {
	CompletionStartTime *time.Time
	Level               ObservationLevel
	Metadata            map[string]any
	Model               string
	StatusMessage       string
	UsageDetails        map[string]float64
}

// Observation mirrors the TS TelemetryObservation interface.
type Observation interface {
	End()
	RecordException(err error)
	StartChild(kind ObservationKind, name string, attrs Attributes) Observation
	Update(update ObservationUpdate)
}

// Runtime mirrors the TS TelemetryRuntime interface. The TS flush/shutdown
// return Promise<void>; the Go equivalents take a context and return error.
type Runtime interface {
	CaptureError(err error, context string)
	EmitLog(name string, severity LogSeverity, attrs Attributes)
	Flush(ctx context.Context) error
	RecordMetric(name string, kind MetricKind, value float64, attrs Attributes)
	SetMode(mode Mode)
	Shutdown(ctx context.Context) error
	StartObservation(kind ObservationKind, name string, attrs Attributes) Observation
}

// noopObservation mirrors the TS noopObservation object.
type noopObservation struct{}

func (noopObservation) End()                     {}
func (noopObservation) RecordException(error)    {}
func (noopObservation) Update(ObservationUpdate) {}
func (n noopObservation) StartChild(ObservationKind, string, Attributes) Observation {
	return n
}

// noopRuntime mirrors the TS noopRuntime object.
type noopRuntime struct{}

func (noopRuntime) CaptureError(error, string)                           {}
func (noopRuntime) EmitLog(string, LogSeverity, Attributes)              {}
func (noopRuntime) Flush(context.Context) error                          { return nil }
func (noopRuntime) RecordMetric(string, MetricKind, float64, Attributes) {}
func (noopRuntime) SetMode(Mode)                                         {}
func (noopRuntime) Shutdown(context.Context) error                       { return nil }
func (noopRuntime) StartObservation(ObservationKind, string, Attributes) Observation {
	return noopObservation{}
}

var (
	mu            sync.Mutex
	activeRuntime Runtime = noopRuntime{}
	activeMode    Mode    = ModeUnknown
	// initialized mirrors the TS `initialization` promise being non-null:
	// once the gate passed, later InitializeTelemetry calls are no-ops.
	initialized bool
	// shutdownDone mirrors the TS `shutdown` promise being non-null.
	shutdownDone bool
	// remoteSignalHandlersInstalled mirrors the TS flag of the same name.
	remoteSignalHandlersInstalled bool
)

// hasExporter mirrors the TS helper: the value is a comma-separated list; it
// counts as an exporter when at least one trimmed item is non-empty and not
// "none".
func hasExporter(value string) bool {
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item != "" && item != "none" {
			return true
		}
	}
	return false
}

// ShouldInitialize mirrors the TS shouldInitialize gate:
//
//	SENTRY_DSN set, OR
//	OTEL_SDK_DISABLED != "true" (case-insensitive) AND
//	  (any OTEL_{TRACES,LOGS,METRICS}_EXPORTER lists a real exporter
//	   OR both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set)
func ShouldInitialize() bool {
	otelEnabled := strings.ToLower(os.Getenv("OTEL_SDK_DISABLED")) != "true"
	hasOtelExporter := hasExporter(os.Getenv("OTEL_TRACES_EXPORTER")) ||
		hasExporter(os.Getenv("OTEL_LOGS_EXPORTER")) ||
		hasExporter(os.Getenv("OTEL_METRICS_EXPORTER"))
	hasLangfuse := os.Getenv("LANGFUSE_PUBLIC_KEY") != "" && os.Getenv("LANGFUSE_SECRET_KEY") != ""
	return os.Getenv("SENTRY_DSN") != "" || (otelEnabled && (hasOtelExporter || hasLangfuse))
}

// GetTelemetryRuntime mirrors the TS getTelemetryRuntime accessor.
func GetTelemetryRuntime() Runtime {
	mu.Lock()
	defer mu.Unlock()
	return activeRuntime
}

// PrometheusExporterEnabled reports whether OTEL_METRICS_EXPORTER requests the
// prometheus exporter (and the OTel SDK is not disabled). The host uses this
// to expose /metrics; the exporter itself registers on the default Prometheus
// registerer during InitializeTelemetry, so without an endpoint the metrics
// would be collected but unreachable.
func PrometheusExporterEnabled() bool {
	if strings.ToLower(os.Getenv("OTEL_SDK_DISABLED")) == "true" {
		return false
	}
	for _, exporterType := range ParseExporterTypes(os.Getenv("OTEL_METRICS_EXPORTER")) {
		if exporterType == "prometheus" {
			return true
		}
	}
	return false
}

// InitializeTelemetry mirrors the TS initializeTelemetry. The TS version is
// idempotent via a cached promise and, when the gate passes, dynamically
// imports the real providers; this port calls CreateTelemetryRuntime directly
// and swaps the global runtime, keeping the noop runtime if creation fails.
// The TS beforeExit flush hook has no Go equivalent — callers should invoke
// FlushTelemetry/ShutdownTelemetry explicitly. When the gate does not pass,
// later calls re-evaluate the environment, matching the TS behavior of
// leaving `initialization` null.
func InitializeTelemetry() {
	mu.Lock()
	defer mu.Unlock()
	if initialized {
		return
	}
	if !ShouldInitialize() {
		return
	}
	initialized = true
	if runtime, err := CreateTelemetryRuntime(context.Background()); err == nil {
		activeRuntime = runtime
	}
	activeRuntime.SetMode(activeMode)
}

// SetTelemetryMode mirrors the TS setTelemetryMode: record the mode for future
// runtime installations and push it to the active runtime.
func SetTelemetryMode(nextMode Mode) {
	mu.Lock()
	activeMode = nextMode
	runtime := activeRuntime
	mu.Unlock()
	runtime.SetMode(nextMode)
}

// CaptureTelemetryError mirrors the TS captureTelemetryError.
func CaptureTelemetryError(err error, errContext string) {
	GetTelemetryRuntime().CaptureError(err, errContext)
}

// FlushTelemetry mirrors the TS flushTelemetry. The TS version awaits the
// initialization promise first; initialization is synchronous here, so the
// active runtime is flushed directly (noop when never initialized).
func FlushTelemetry(ctx context.Context) error {
	return GetTelemetryRuntime().Flush(ctx)
}

// ShutdownTelemetry mirrors the TS shutdownTelemetry: idempotent, waits for
// initialization (synchronous here), shuts the runtime down and resets the
// global to noop.
func ShutdownTelemetry(ctx context.Context) error {
	mu.Lock()
	if shutdownDone {
		mu.Unlock()
		return nil
	}
	shutdownDone = true
	runtime := activeRuntime
	mu.Unlock()

	err := runtime.Shutdown(ctx)

	mu.Lock()
	activeRuntime = noopRuntime{}
	mu.Unlock()
	return err
}

// InstallRemoteTelemetrySignalHandlers mirrors the TS function of the same
// name: on the first SIGINT/SIGTERM it shuts telemetry down and exits with
// 130/143 respectively. Idempotent; later signals are handled by the default
// disposition because the watcher stops itself, matching the TS handler
// removing itself via process.off.
func InstallRemoteTelemetrySignalHandlers() {
	mu.Lock()
	if remoteSignalHandlersInstalled {
		mu.Unlock()
		return
	}
	remoteSignalHandlersInstalled = true
	mu.Unlock()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		signal.Stop(sigCh)
		exitCode := 130
		if sig == syscall.SIGTERM {
			exitCode = 143
		}
		_ = ShutdownTelemetry(context.Background())
		os.Exit(exitCode)
	}()
}
