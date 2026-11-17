package telemetry

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeRuntime records every runtime call for assertion.
type fakeRuntime struct {
	mu           sync.Mutex
	mode         TelemetryMode
	metrics      []metricCall
	logs         []logCall
	errors       []errorCall
	observations []*fakeObservation
	rootNames    []string
	flushed      int
	shutdowns    int
}

type metricCall struct {
	name  string
	kind  TelemetryMetricKind
	value float64
	attrs TelemetryAttributes
}

type logCall struct {
	name     string
	severity Severity
	attrs    TelemetryAttributes
}

type errorCall struct {
	err     error
	context string
}

func (f *fakeRuntime) CaptureError(err error, context string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.errors = append(f.errors, errorCall{err, context})
}

func (f *fakeRuntime) EmitLog(name string, severity Severity, attributes TelemetryAttributes) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logs = append(f.logs, logCall{name, severity, attributes})
}

func (f *fakeRuntime) Flush() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.flushed++
}

func (f *fakeRuntime) RecordMetric(name string, kind TelemetryMetricKind, value float64, attributes TelemetryAttributes) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.metrics = append(f.metrics, metricCall{name, kind, value, attributes})
}

func (f *fakeRuntime) SetMode(mode TelemetryMode) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mode = mode
}

func (f *fakeRuntime) Shutdown() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.shutdowns++
}

func (f *fakeRuntime) StartObservation(kind TelemetryObservationKind, name string, attributes TelemetryAttributes) TelemetryObservation {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rootNames = append(f.rootNames, name)
	obs := &fakeObservation{runtime: f, kind: kind, name: name, attrs: attributes}
	f.observations = append(f.observations, obs)
	return obs
}

type fakeObservation struct {
	runtime  *fakeRuntime
	kind     TelemetryObservationKind
	name     string
	attrs    TelemetryAttributes
	ended    bool
	updates  []TelemetryObservationUpdate
	children []*fakeObservation
	errors   []error
}

func (o *fakeObservation) End() { o.ended = true }

func (o *fakeObservation) RecordException(err error) { o.errors = append(o.errors, err) }

func (o *fakeObservation) StartChild(kind TelemetryObservationKind, name string, attributes TelemetryAttributes) TelemetryObservation {
	child := &fakeObservation{runtime: o.runtime, kind: kind, name: name, attrs: attributes}
	o.children = append(o.children, child)
	return child
}

func (o *fakeObservation) Update(update TelemetryObservationUpdate) {
	o.updates = append(o.updates, update)
}

// withRuntime swaps the package runtime for the duration of a test.
func withRuntime(t *testing.T, rt TelemetryRuntime) {
	t.Helper()
	runtimeMu.Lock()
	previous := runtime
	previousMode := mode
	previousInit := initialized
	previousShutdown := shutdownDone
	runtime = rt
	runtimeMu.Unlock()
	t.Cleanup(func() {
		runtimeMu.Lock()
		runtime = previous
		mode = previousMode
		initialized = previousInit
		shutdownDone = previousShutdown
		runtimeMu.Unlock()
	})
}

func TestHasExporter(t *testing.T) {
	cases := map[string]bool{
		"":             false,
		"none":         false,
		" none , ":     false,
		"console":      true,
		"otlp,console": true,
		"none,otlp":    true,
	}
	for value, want := range cases {
		if got := hasExporter(value); got != want {
			t.Errorf("hasExporter(%q) = %v, want %v", value, got, want)
		}
	}
}

func TestShouldInitialize(t *testing.T) {
	clear := func(t *testing.T) {
		for _, key := range []string{"SENTRY_DSN", "OTEL_SDK_DISABLED", "OTEL_TRACES_EXPORTER", "OTEL_LOGS_EXPORTER", "OTEL_METRICS_EXPORTER", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"} {
			t.Setenv(key, "")
		}
	}
	t.Run("nothing configured", func(t *testing.T) {
		clear(t)
		if shouldInitialize() {
			t.Error("expected false with no configuration")
		}
	})
	t.Run("sentry dsn", func(t *testing.T) {
		clear(t)
		t.Setenv("SENTRY_DSN", "https://x@sentry.io/1")
		if !shouldInitialize() {
			t.Error("expected true with SENTRY_DSN")
		}
	})
	t.Run("otel exporter", func(t *testing.T) {
		clear(t)
		t.Setenv("OTEL_METRICS_EXPORTER", "console")
		if !shouldInitialize() {
			t.Error("expected true with an OTel exporter")
		}
	})
	t.Run("otel disabled", func(t *testing.T) {
		clear(t)
		t.Setenv("OTEL_METRICS_EXPORTER", "console")
		t.Setenv("OTEL_SDK_DISABLED", "true")
		if shouldInitialize() {
			t.Error("expected false when the OTel SDK is disabled")
		}
	})
	t.Run("sentry dsn wins over disabled otel", func(t *testing.T) {
		clear(t)
		t.Setenv("SENTRY_DSN", "https://x@sentry.io/1")
		t.Setenv("OTEL_SDK_DISABLED", "TRUE")
		if !shouldInitialize() {
			t.Error("expected true: SENTRY_DSN initializes regardless of OTEL_SDK_DISABLED")
		}
	})
	t.Run("langfuse keys", func(t *testing.T) {
		clear(t)
		t.Setenv("LANGFUSE_PUBLIC_KEY", "pk")
		t.Setenv("LANGFUSE_SECRET_KEY", "sk")
		if !shouldInitialize() {
			t.Error("expected true with Langfuse keys")
		}
	})
}

func TestSetTelemetryModeAndShutdown(t *testing.T) {
	fake := &fakeRuntime{}
	withRuntime(t, fake)
	SetTelemetryMode(ModeRemote)
	if fake.mode != ModeRemote {
		t.Errorf("runtime mode = %q, want remote", fake.mode)
	}
	runtimeMu.Lock()
	current := mode
	runtimeMu.Unlock()
	if current != ModeRemote {
		t.Errorf("package mode = %q, want remote", current)
	}

	ShutdownTelemetry()
	if fake.shutdowns != 1 {
		t.Fatalf("shutdowns = %d, want 1", fake.shutdowns)
	}
	ShutdownTelemetry()
	if fake.shutdowns != 1 {
		t.Errorf("shutdowns = %d, want 1 after repeat call", fake.shutdowns)
	}
	// After shutdown the runtime is the noop: no further calls are recorded.
	CaptureTelemetryError(errors.New("x"), "ctx")
	FlushTelemetry()
	if fake.flushed != 0 || len(fake.errors) != 0 {
		t.Error("noop runtime must not record calls after shutdown")
	}
}

func TestInitializeTelemetryNoopWithoutConfiguration(t *testing.T) {
	for _, key := range []string{"SENTRY_DSN", "OTEL_TRACES_EXPORTER", "OTEL_LOGS_EXPORTER", "OTEL_METRICS_EXPORTER", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "OTEL_SDK_DISABLED"} {
		t.Setenv(key, "")
	}
	runtimeMu.Lock()
	initialized = false
	shutdownDone = false
	runtime = noopRuntime{}
	runtimeMu.Unlock()
	InitializeTelemetry()
	if _, ok := GetTelemetryRuntime().(noopRuntime); !ok {
		t.Error("expected the noop runtime without any telemetry configuration")
	}
}

func TestSessionHash(t *testing.T) {
	// Values verified against node:crypto sha256.
	if got := sessionHash("session-1"); got != "84097828fc31a8c8" {
		t.Errorf("sessionHash(session-1) = %q", got)
	}
	if got := sessionHash("abc"); got != "ba7816bf8f01cfea" {
		t.Errorf("sessionHash(abc) = %q", got)
	}
	if got := sessionHash(""); got != "" {
		t.Errorf("sessionHash(\"\") = %q, want empty", got)
	}
}

func TestErrorTypeName(t *testing.T) {
	if got := errorTypeName(errors.New("boom")); got != "Error" {
		t.Errorf("plain error name = %q, want Error", got)
	}
	if got := errorTypeName(nil); got != "unknown" {
		t.Errorf("nil error name = %q, want unknown", got)
	}
}

func TestElapsedMilliseconds(t *testing.T) {
	start := time.Now().Add(-50 * time.Millisecond)
	if got := elapsedMilliseconds(start); got < 40 || got > 500 {
		t.Errorf("elapsedMilliseconds = %f, expected ~50", got)
	}
}
