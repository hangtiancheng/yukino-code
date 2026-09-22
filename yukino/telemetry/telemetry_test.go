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
	"testing"
)

// resetGlobals restores the package-level state so each test observes the
// pristine noop runtime, mirroring a fresh TS module instance.
func resetGlobals() {
	mu.Lock()
	defer mu.Unlock()
	activeRuntime = noopRuntime{}
	activeMode = ModeUnknown
	initialized = false
	shutdownDone = false
	remoteSignalHandlersInstalled = false
}

// clearTelemetryEnv unsets every variable the gate reads; t.Setenv restores
// originals automatically.
func clearTelemetryEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"SENTRY_DSN",
		"OTEL_SDK_DISABLED",
		"OTEL_TRACES_EXPORTER",
		"OTEL_LOGS_EXPORTER",
		"OTEL_METRICS_EXPORTER",
		"LANGFUSE_PUBLIC_KEY",
		"LANGFUSE_SECRET_KEY",
	} {
		t.Setenv(key, "")
	}
}

func TestShouldInitialize(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want bool
	}{
		{name: "nothing set", env: nil, want: false},
		{name: "sentry dsn", env: map[string]string{"SENTRY_DSN": "https://key@ingest.sentry.io/1"}, want: true},
		{
			name: "sentry wins even when otel disabled",
			env:  map[string]string{"SENTRY_DSN": "https://key@ingest.sentry.io/1", "OTEL_SDK_DISABLED": "true"},
			want: true,
		},
		{name: "traces exporter", env: map[string]string{"OTEL_TRACES_EXPORTER": "otlp"}, want: true},
		{name: "logs exporter", env: map[string]string{"OTEL_LOGS_EXPORTER": "otlp"}, want: true},
		{name: "metrics exporter", env: map[string]string{"OTEL_METRICS_EXPORTER": "prometheus"}, want: true},
		{name: "exporter none", env: map[string]string{"OTEL_TRACES_EXPORTER": "none"}, want: false},
		{name: "exporter empty", env: map[string]string{"OTEL_TRACES_EXPORTER": ""}, want: false},
		{name: "exporter list with real item", env: map[string]string{"OTEL_TRACES_EXPORTER": "none, otlp"}, want: true},
		{name: "exporter list whitespace only", env: map[string]string{"OTEL_TRACES_EXPORTER": " , none ,"}, want: false},
		{
			name: "otel disabled blocks exporter",
			env:  map[string]string{"OTEL_SDK_DISABLED": "true", "OTEL_TRACES_EXPORTER": "otlp"},
			want: false,
		},
		{
			name: "otel disabled uppercase",
			env:  map[string]string{"OTEL_SDK_DISABLED": "TRUE", "OTEL_LOGS_EXPORTER": "otlp"},
			want: false,
		},
		{
			name: "otel disabled other value keeps exporter",
			env:  map[string]string{"OTEL_SDK_DISABLED": "false", "OTEL_METRICS_EXPORTER": "otlp"},
			want: true,
		},
		{
			name: "langfuse both keys",
			env:  map[string]string{"LANGFUSE_PUBLIC_KEY": "pk", "LANGFUSE_SECRET_KEY": "sk"},
			want: true,
		},
		{name: "langfuse public key only", env: map[string]string{"LANGFUSE_PUBLIC_KEY": "pk"}, want: false},
		{name: "langfuse secret key only", env: map[string]string{"LANGFUSE_SECRET_KEY": "sk"}, want: false},
		{
			name: "langfuse blocked by otel disabled",
			env:  map[string]string{"OTEL_SDK_DISABLED": "true", "LANGFUSE_PUBLIC_KEY": "pk", "LANGFUSE_SECRET_KEY": "sk"},
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clearTelemetryEnv(t)
			for k, v := range tt.env {
				t.Setenv(k, v)
			}
			if got := ShouldInitialize(); got != tt.want {
				t.Errorf("ShouldInitialize() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestInitializeTelemetryInstallsProviderRuntime(t *testing.T) {
	resetGlobals()
	clearTelemetryEnv(t)
	t.Setenv("SENTRY_DSN", "https://key@ingest.sentry.io/1")

	InitializeTelemetry()

	provider, ok := GetTelemetryRuntime().(*ProviderRuntime)
	if !ok {
		t.Fatalf("runtime should be the provider-backed runtime once the gate passes")
	}
	// Sentry is not ported and no OTEL exporter is configured, so every
	// subsystem stays nil and observations degrade to the noop chain.
	if provider.tracerProvider != nil || provider.loggerProvider != nil || provider.meterProvider != nil {
		t.Errorf("providers must stay nil without OTEL exporter configuration")
	}
	if _, ok := provider.StartObservation(ObservationAgent, "root", nil).(noopObservation); !ok {
		t.Errorf("observation should degrade to noop without a tracer provider")
	}

	mu.Lock()
	wasInitialized := initialized
	mu.Unlock()
	if !wasInitialized {
		t.Errorf("initialized flag should be set once the gate passes")
	}
}

func TestInitializeTelemetryGateClosedRechecks(t *testing.T) {
	resetGlobals()
	clearTelemetryEnv(t)

	InitializeTelemetry()
	mu.Lock()
	first := initialized
	mu.Unlock()
	if first {
		t.Fatalf("initialized flag must stay false when the gate is closed")
	}

	t.Setenv("OTEL_TRACES_EXPORTER", "otlp")
	InitializeTelemetry()
	mu.Lock()
	second := initialized
	mu.Unlock()
	if !second {
		t.Errorf("later calls must re-evaluate the environment like the TS null-promise path")
	}
}

func TestSetTelemetryModeAndLifecycle(t *testing.T) {
	resetGlobals()
	clearTelemetryEnv(t)

	SetTelemetryMode(ModeRemote)
	mu.Lock()
	got := activeMode
	mu.Unlock()
	if got != ModeRemote {
		t.Errorf("activeMode = %q, want %q", got, ModeRemote)
	}

	ctx := context.Background()
	if err := FlushTelemetry(ctx); err != nil {
		t.Errorf("FlushTelemetry() error = %v", err)
	}
	if err := ShutdownTelemetry(ctx); err != nil {
		t.Errorf("ShutdownTelemetry() error = %v", err)
	}
	if _, ok := GetTelemetryRuntime().(noopRuntime); !ok {
		t.Errorf("runtime must reset to noop after shutdown")
	}
	// Idempotent: a second shutdown is a no-op, matching the cached TS promise.
	if err := ShutdownTelemetry(ctx); err != nil {
		t.Errorf("second ShutdownTelemetry() error = %v", err)
	}
}

func TestNoopRuntimeAndObservation(t *testing.T) {
	resetGlobals()
	rt := GetTelemetryRuntime()
	obs := rt.StartObservation(ObservationAgent, "root", Attributes{"k": "v"})
	child := obs.StartChild(ObservationTool, "child", nil)
	child.Update(ObservationUpdate{Model: "m"})
	child.RecordException(context.Canceled)
	child.End()
	obs.End()
	rt.RecordMetric("m", MetricCounter, 1, nil)
	rt.EmitLog("log", LogSeverityInfo, nil)
	rt.CaptureError(context.Canceled, "test")
}
