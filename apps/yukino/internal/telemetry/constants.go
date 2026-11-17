// Package telemetry mirrors src/telemetry: OTel + Sentry observability with a
// noop default runtime.
package telemetry

import (
	"regexp"
	"time"
)

const (
	DefaultExportIntervalMs = 60_000
	ShutdownTimeoutMs       = 2_000

	ShutdownTimeout = ShutdownTimeoutMs * time.Millisecond
)

// ServiceName is the default OTLP resource service.name.
const ServiceName = "yukino"

// InstrumentationScopeName is the scope name for the OTel meter and logger.
const InstrumentationScopeName = "@yukino.js/yukino"

// Exporter tokens accepted in OTEL_{TRACES,LOGS,METRICS}_EXPORTER.
const (
	ExporterNone       = "none"
	ExporterConsole    = "console"
	ExporterOtlp       = "otlp"
	ExporterPrometheus = "prometheus"
)

const (
	OtlpProtocolGrpc         = "grpc"
	OtlpProtocolHTTPJSON     = "http/json"
	OtlpProtocolHTTPProtobuf = "http/protobuf"
	DefaultOtlpProtocol      = OtlpProtocolHTTPProtobuf
)

type TelemetryObservationKind string

const (
	ObservationKindAgent      TelemetryObservationKind = "agent"
	ObservationKindGeneration TelemetryObservationKind = "generation"
	ObservationKindTool       TelemetryObservationKind = "tool"
)

const (
	ObservationLevelDefault = "DEFAULT"
	ObservationLevelError   = "ERROR"
)

// OTel attribute keys shared by instrumentation and providers.
const (
	AttributeErrorType   = "error.type"
	AttributeMode        = "yukino.mode"
	AttributeSessionHash = "session.hash"
	AttributeTokenType   = "token.type"
)

const (
	MetricAgentRuns           = "yukino.agent.runs"
	MetricAgentDuration       = "yukino.agent.duration"
	MetricLlmRequests         = "yukino.llm.requests"
	MetricLlmTokens           = "yukino.llm.tokens"
	MetricLlmTimeToFirstToken = "yukino.llm.time_to_first_token"
	MetricLlmDuration         = "yukino.llm.duration"
	MetricToolCalls           = "yukino.tool.calls"
	MetricToolDuration        = "yukino.tool.duration"
)

const (
	ObservationAgentRun    = "yukino.agent.run"
	ObservationLlmGenerate = "yukino.llm.generate"
	ObservationToolExecute = "yukino.tool.execute"
)

const (
	LogError     = "yukino.error"
	LogLlmError  = "yukino.llm.error"
	LogToolError = "yukino.tool.error"
)

const HistogramUnit = "ms"

// SentryTracesSampleRate keeps Sentry tracing off; OTel owns trace export.
const SentryTracesSampleRate = 0

const ToolErrorStatusMessage = "Tool returned an error"

// RedactedPlaceholder replaces sensitive values scrubbed from payloads before
// export.
const RedactedPlaceholder = "[redacted]"

// SensitiveKeyPattern matches key names whose values are replaced wholesale
// before export.
var SensitiveKeyPattern = regexp.MustCompile(`(?i)(?:authorization|api[_\-]?key|password|secret|credential|(?:^|[_\-])token(?:$|[_\-])|access[_\-]?token|refresh[_\-]?token|private[_\-]?key|(?:^|[_\-])dsn(?:$|[_\-])|^(?:cookie|set-cookie)$)`)
