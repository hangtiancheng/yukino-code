package telemetry

import (
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type TelemetryMode string

const (
	ModeA2A      TelemetryMode = "a2a"
	ModePrint    TelemetryMode = "print"
	ModeRemote   TelemetryMode = "remote"
	ModeTerminal TelemetryMode = "terminal"
	ModeUnknown  TelemetryMode = "unknown"
)

type TelemetryMetricKind string

const (
	MetricKindCounter   TelemetryMetricKind = "counter"
	MetricKindHistogram TelemetryMetricKind = "histogram"
)

type Severity string

const (
	SeverityError Severity = "error"
	SeverityInfo  Severity = "info"
	SeverityWarn  Severity = "warn"
)

// TelemetryAttributes mirrors Record<string, string | number | boolean>.
type TelemetryAttributes map[string]any

type TelemetryObservationUpdate struct {
	CompletionStartTime *time.Time
	Level               string
	Metadata            map[string]any
	Model               string
	StatusMessage       string
	UsageDetails        map[string]float64
}

type TelemetryObservation interface {
	End()
	RecordException(err error)
	StartChild(kind TelemetryObservationKind, name string, attributes TelemetryAttributes) TelemetryObservation
	Update(update TelemetryObservationUpdate)
}

type TelemetryRuntime interface {
	CaptureError(err error, context string)
	EmitLog(name string, severity Severity, attributes TelemetryAttributes)
	Flush()
	RecordMetric(name string, kind TelemetryMetricKind, value float64, attributes TelemetryAttributes)
	SetMode(mode TelemetryMode)
	Shutdown()
	StartObservation(kind TelemetryObservationKind, name string, attributes TelemetryAttributes) TelemetryObservation
}

type noopObservation struct{}

func (noopObservation) End()                  {}
func (noopObservation) RecordException(error) {}
func (n noopObservation) StartChild(kind TelemetryObservationKind, name string, attributes TelemetryAttributes) TelemetryObservation {
	return n
}
func (noopObservation) Update(TelemetryObservationUpdate) {}

type noopRuntime struct{}

func (noopRuntime) CaptureError(error, string)                                             {}
func (noopRuntime) EmitLog(string, Severity, TelemetryAttributes)                          {}
func (noopRuntime) Flush()                                                                 {}
func (noopRuntime) RecordMetric(string, TelemetryMetricKind, float64, TelemetryAttributes) {}
func (noopRuntime) SetMode(TelemetryMode)                                                  {}
func (noopRuntime) Shutdown()                                                              {}
func (noopRuntime) StartObservation(kind TelemetryObservationKind, name string, attributes TelemetryAttributes) TelemetryObservation {
	return noopObservation{}
}

var (
	runtimeMu sync.Mutex
	runtime   TelemetryRuntime = noopRuntime{}
	mode      TelemetryMode    = ModeUnknown

	initialized  bool
	shutdownDone bool

	remoteSignalHandlersInstalled atomic.Bool
	remoteSignalFired             atomic.Bool
)

func hasExporter(value string) bool {
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item != "" && item != ExporterNone {
			return true
		}
	}
	return false
}

func shouldInitialize() bool {
	otelEnabled := !strings.EqualFold(os.Getenv("OTEL_SDK_DISABLED"), "true")
	hasOtelExporter := hasExporter(os.Getenv("OTEL_TRACES_EXPORTER")) ||
		hasExporter(os.Getenv("OTEL_LOGS_EXPORTER")) ||
		hasExporter(os.Getenv("OTEL_METRICS_EXPORTER"))
	hasLangfuse := os.Getenv("LANGFUSE_PUBLIC_KEY") != "" && os.Getenv("LANGFUSE_SECRET_KEY") != ""
	return os.Getenv("SENTRY_DSN") != "" || (otelEnabled && (hasOtelExporter || hasLangfuse))
}

func GetTelemetryRuntime() TelemetryRuntime {
	runtimeMu.Lock()
	defer runtimeMu.Unlock()
	return runtime
}

// InitializeTelemetry builds the provider runtime once when the environment
// requests telemetry. Langfuse has no official Go SDK, so the Langfuse keys
// only keep the OTel path enabled (see shouldInitialize); the Langfuse span
// processor itself is not ported.
func InitializeTelemetry() {
	runtimeMu.Lock()
	if initialized {
		runtimeMu.Unlock()
		return
	}
	if !shouldInitialize() {
		runtimeMu.Unlock()
		return
	}
	rt := createTelemetryRuntime()
	runtime = rt
	currentMode := mode
	initialized = true
	runtimeMu.Unlock()

	rt.SetMode(currentMode)
}

func SetTelemetryMode(nextMode TelemetryMode) {
	runtimeMu.Lock()
	mode = nextMode
	rt := runtime
	runtimeMu.Unlock()
	rt.SetMode(nextMode)
}

func CaptureTelemetryError(err error, context string) {
	GetTelemetryRuntime().CaptureError(err, context)
}

func FlushTelemetry() {
	GetTelemetryRuntime().Flush()
}

func ShutdownTelemetry() {
	runtimeMu.Lock()
	if shutdownDone {
		runtimeMu.Unlock()
		return
	}
	shutdownDone = true
	rt := runtime
	runtime = noopRuntime{}
	runtimeMu.Unlock()
	rt.Shutdown()
}

// RemoteSignalFired reports whether a remote-mode shutdown signal was
// received; the signal handler then owns the exit (telemetry flush + the
// signal's exit code), so the main goroutine must not exit on its own.
func RemoteSignalFired() bool {
	return remoteSignalFired.Load()
}

// RemoteSignalHandlersInstalled reports whether
// InstallRemoteTelemetrySignalHandlers has taken ownership of SIGINT/SIGTERM.
func RemoteSignalHandlersInstalled() bool {
	return remoteSignalHandlersInstalled.Load()
}

// InstallRemoteTelemetrySignalHandlers installs SIGINT/SIGTERM handlers for the
// remote server. When onShutdown is provided it runs first (server teardown:
// background tasks, teammates, MCP children) and receives the exit code so it
// can persist the real one; the telemetry flush and process exit follow once
// it settles.
func InstallRemoteTelemetrySignalHandlers(onShutdown func(exitCode int)) {
	if !remoteSignalHandlersInstalled.CompareAndSwap(false, true) {
		return
	}
	install := func(sig os.Signal, exitCode int) {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, sig)
		go func() {
			<-ch
			signal.Stop(ch)
			remoteSignalFired.Store(true)
			if onShutdown != nil {
				onShutdown(exitCode)
			}
			ShutdownTelemetry()
			os.Exit(exitCode)
		}()
	}
	install(syscall.SIGINT, 130)
	install(syscall.SIGTERM, 143)
}
