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
// src/telemetry/providers.ts: the real OpenTelemetry-backed Runtime.
//
// Semantic differences from the TS original:
//
//   - Sentry is ported via getsentry/sentry-go (the official Go SDK). The
//     SENTRY_DSN gate, the errors-only configuration (tracesSampleRate 0, no
//     default PII) and the capture/setTag/flush call sites mirror TS;
//     sentry-go has no Close, so shutdown drains the transport with a
//     bounded Flush instead.
//   - The Langfuse integration does not use the Langfuse SDKs (no Go
//     counterpart). When LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set,
//     an additional OTLP/HTTP trace processor exports spans to the Langfuse
//     OTLP endpoint (LANGFUSE_BASE_URL, default https://cloud.langfuse.com,
//     path /api/public/otel/v1/traces, Basic auth), and observations are
//     expressed through the same langfuse.observation.* span attributes the
//     TS SDK emits (type, metadata.<key> as strings, model.name, level,
//     status_message, usage_details as one JSON string,
//     completion_start_time as a JS toISOString value) plus langfuse.release.
//     Observation spans use the TS SDK's tracer scope name "langfuse-sdk";
//     its scope version is the Langfuse SDK version in TS and the yukino
//     version here.
//   - http/json maps to JSON encoding for the OTLP trace exporter; the Go
//     OTLP log and metric HTTP exporters only support protobuf, so http/json
//     falls back to http/protobuf for those two signals.
//   - The TS beforeExit flush hook and the setLangfuseTracerProvider global
//     have no Go counterpart.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/getsentry/sentry-go"
	"github.com/hangtiancheng/yukino-code/yukino/version"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/exporters/prometheus"
	"go.opentelemetry.io/otel/exporters/stdout/stdoutlog"
	"go.opentelemetry.io/otel/exporters/stdout/stdoutmetric"
	"go.opentelemetry.io/otel/exporters/stdout/stdouttrace"
	otellog "go.opentelemetry.io/otel/log"
	"go.opentelemetry.io/otel/metric"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

const (
	// defaultExportIntervalMS mirrors the TS DEFAULT_EXPORT_INTERVAL_MS.
	defaultExportIntervalMS = 60_000
	// shutdownTimeout mirrors the TS SHUTDOWN_TIMEOUT_MS.
	shutdownTimeout = 2 * time.Second
	// instrumentationName is the instrumentation scope name used for the
	// meter and logger (TS: getMeter/getLogger("@yukino.js/yukino", version)).
	instrumentationName = "@yukino.js/yukino"
	// langfuseTracerName is the tracer scope name the TS Langfuse SDK uses
	// when it creates observation spans (LANGFUSE_TRACER_NAME in
	// @langfuse/core). TS pairs it with the Langfuse SDK version; Go pairs it
	// with the yukino version (documented difference).
	langfuseTracerName = "langfuse-sdk"
	// defaultLangfuseBaseURL is the Langfuse cloud endpoint used when
	// LANGFUSE_BASE_URL is unset.
	defaultLangfuseBaseURL = "https://cloud.langfuse.com"
	// langfuseTracesPath is the OTLP traces path on a Langfuse deployment.
	langfuseTracesPath = "/api/public/otel/v1/traces"
)

// otlpProtocol mirrors the TS OtlpProtocol union.
type otlpProtocol string

const (
	protocolGRPC         otlpProtocol = "grpc"
	protocolHTTPJSON     otlpProtocol = "http/json"
	protocolHTTPProtobuf otlpProtocol = "http/protobuf"
)

// ParseExporterTypes mirrors the TS parseExporterTypes: split a
// comma-separated exporter list, trim whitespace and drop empty entries and
// "none".
func ParseExporterTypes(value string) []string {
	items := []string{}
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item != "" && item != "none" {
			items = append(items, item)
		}
	}
	return items
}

// parsePositiveInteger mirrors the TS parsePositiveInteger, including the
// Number.parseInt leniency (leading whitespace and sign, trailing non-digits
// ignored): invalid or non-positive values fall back to the default.
func parsePositiveInteger(value string, fallback int) int {
	trimmed := strings.TrimLeft(value, " \t\n\r\v\f")
	sign := 1
	i := 0
	if i < len(trimmed) && (trimmed[i] == '+' || trimmed[i] == '-') {
		if trimmed[i] == '-' {
			sign = -1
		}
		i++
	}
	end := i
	for end < len(trimmed) && trimmed[end] >= '0' && trimmed[end] <= '9' {
		end++
	}
	if end == i {
		return fallback
	}
	parsed, err := strconv.Atoi(trimmed[i:end])
	if err != nil {
		return fallback
	}
	parsed *= sign
	if parsed > 0 {
		return parsed
	}
	return fallback
}

// getProtocol mirrors the TS getProtocol: the signal-specific
// OTEL_EXPORTER_OTLP_<SIGNAL>_PROTOCOL wins over the generic
// OTEL_EXPORTER_OTLP_PROTOCOL, defaulting to http/protobuf.
func getProtocol(signal string) (otlpProtocol, error) {
	signalKey := "OTEL_EXPORTER_OTLP_" + strings.ToUpper(signal) + "_PROTOCOL"
	configured := strings.TrimSpace(os.Getenv(signalKey))
	if configured == "" {
		configured = strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_PROTOCOL"))
	}
	if configured == "" {
		configured = string(protocolHTTPProtobuf)
	}
	switch protocol := otlpProtocol(configured); protocol {
	case protocolGRPC, protocolHTTPJSON, protocolHTTPProtobuf:
		return protocol, nil
	}
	return "", fmt.Errorf("unsupported OpenTelemetry protocol: %s", configured)
}

// parseResourceAttributes mirrors the TS parseResourceAttributes: k=v pairs
// separated by commas, keys/values trimmed and URL-decoded (decodeURIComponent
// semantics: '+' is preserved, invalid escapes fall back to the raw value).
func parseResourceAttributes(value string) map[string]string {
	attributes := map[string]string{}
	if value == "" {
		return attributes
	}
	for _, entry := range strings.Split(value, ",") {
		separator := strings.Index(entry, "=")
		if separator <= 0 {
			continue
		}
		key := strings.TrimSpace(entry[:separator])
		rawValue := strings.TrimSpace(entry[separator+1:])
		if key == "" || rawValue == "" {
			continue
		}
		decodedKey, keyErr := url.PathUnescape(key)
		decodedValue, valueErr := url.PathUnescape(rawValue)
		if keyErr != nil || valueErr != nil {
			attributes[key] = rawValue
			continue
		}
		attributes[decodedKey] = decodedValue
	}
	return attributes
}

// createResource mirrors the TS createResource: service.name/service.version
// defaults, overlaid by OTEL_RESOURCE_ATTRIBUTES, with OTEL_SERVICE_NAME
// winning for service.name.
func createResource() *resource.Resource {
	attrs := map[string]string{
		"service.name":    "yukino",
		"service.version": version.Get(),
	}
	for key, value := range parseResourceAttributes(os.Getenv("OTEL_RESOURCE_ATTRIBUTES")) {
		attrs[key] = value
	}
	if name := os.Getenv("OTEL_SERVICE_NAME"); name != "" {
		attrs["service.name"] = name
	}
	kvs := make([]attribute.KeyValue, 0, len(attrs))
	for key, value := range attrs {
		kvs = append(kvs, attribute.String(key, value))
	}
	return resource.NewSchemaless(kvs...)
}

// createTraceExporter mirrors the TS createTraceExporter. The Go OTLP
// exporters read the standard OTEL_EXPORTER_OTLP_* environment variables
// (endpoint, headers, timeout, ...) by default, matching the TS behavior of
// constructing the exporter without explicit options.
func createTraceExporter(ctx context.Context, protocol otlpProtocol) (sdktrace.SpanExporter, error) {
	switch protocol {
	case protocolGRPC:
		return otlptracegrpc.New(ctx)
	case protocolHTTPJSON:
		return otlptracehttp.New(ctx, otlptracehttp.WithEncoding(otlptracehttp.EncodingJSON))
	case protocolHTTPProtobuf:
		return otlptracehttp.New(ctx)
	}
	return nil, fmt.Errorf("unsupported OpenTelemetry protocol: %s", protocol)
}

// createLogExporter mirrors the TS createLogExporter. The Go otlploghttp
// exporter only supports protobuf encoding, so http/json falls back to
// protobuf-over-HTTP (documented difference from TS).
func createLogExporter(ctx context.Context, protocol otlpProtocol) (sdklog.Exporter, error) {
	switch protocol {
	case protocolGRPC:
		return otlploggrpc.New(ctx)
	case protocolHTTPJSON, protocolHTTPProtobuf:
		return otlploghttp.New(ctx)
	}
	return nil, fmt.Errorf("unsupported OpenTelemetry protocol: %s", protocol)
}

// createMetricExporter mirrors the TS createMetricExporter. The Go
// otlpmetrichttp exporter only supports protobuf encoding, so http/json falls
// back to protobuf-over-HTTP (documented difference from TS).
func createMetricExporter(ctx context.Context, protocol otlpProtocol) (sdkmetric.Exporter, error) {
	switch protocol {
	case protocolGRPC:
		return otlpmetricgrpc.New(ctx)
	case protocolHTTPJSON, protocolHTTPProtobuf:
		return otlpmetrichttp.New(ctx)
	}
	return nil, fmt.Errorf("unsupported OpenTelemetry protocol: %s", protocol)
}

// langfuseEndpointURL derives the full Langfuse OTLP traces URL from the base
// URL (LANGFUSE_BASE_URL semantics: empty means the Langfuse cloud).
func langfuseEndpointURL(baseURL string) string {
	if baseURL == "" {
		baseURL = defaultLangfuseBaseURL
	}
	return strings.TrimRight(baseURL, "/") + langfuseTracesPath
}

// langfuseAuthHeader builds the Basic auth header value from the Langfuse
// key pair.
func langfuseAuthHeader(publicKey, secretKey string) string {
	credentials := base64.StdEncoding.EncodeToString([]byte(publicKey + ":" + secretKey))
	return "Basic " + credentials
}

// langfuseRelease mirrors the TS release option: LANGFUSE_RELEASE ?? version.
func langfuseRelease() string {
	if release := os.Getenv("LANGFUSE_RELEASE"); release != "" {
		return release
	}
	return version.Get()
}

// createLangfuseTraceExporter builds the OTLP/HTTP exporter pointed at the
// Langfuse OTLP endpoint with Basic auth, replacing the TS
// LangfuseSpanProcessor (no Go Langfuse SDK exists).
func createLangfuseTraceExporter(ctx context.Context) (sdktrace.SpanExporter, error) {
	return otlptracehttp.New(ctx,
		otlptracehttp.WithEndpointURL(langfuseEndpointURL(os.Getenv("LANGFUSE_BASE_URL"))),
		otlptracehttp.WithHeaders(map[string]string{
			"Authorization": langfuseAuthHeader(os.Getenv("LANGFUSE_PUBLIC_KEY"), os.Getenv("LANGFUSE_SECRET_KEY")),
		}),
	)
}

// createTracerProvider mirrors the TS createTracerProvider. The second return
// value is the langfuse.release attribute value (empty when Langfuse is not
// configured).
func createTracerProvider(ctx context.Context, res *resource.Resource) (*sdktrace.TracerProvider, string, error) {
	var processors []sdktrace.SpanProcessor
	for _, exporterType := range ParseExporterTypes(os.Getenv("OTEL_TRACES_EXPORTER")) {
		switch exporterType {
		case "console":
			// TS ConsoleSpanExporter writes single-line JSON via console.log;
			// stdouttrace without pretty-printing matches that shape.
			exporter, err := stdouttrace.New()
			if err != nil {
				return nil, "", err
			}
			processors = append(processors, sdktrace.NewBatchSpanProcessor(exporter))
		case "otlp":
			protocol, err := getProtocol("traces")
			if err != nil {
				return nil, "", err
			}
			exporter, err := createTraceExporter(ctx, protocol)
			if err != nil {
				return nil, "", err
			}
			processors = append(processors, sdktrace.NewBatchSpanProcessor(exporter))
		default:
			return nil, "", fmt.Errorf("unsupported trace exporter: %s", exporterType)
		}
	}

	release := ""
	if publicKey, secretKey := os.Getenv("LANGFUSE_PUBLIC_KEY"), os.Getenv("LANGFUSE_SECRET_KEY"); publicKey != "" && secretKey != "" {
		exporter, err := createLangfuseTraceExporter(ctx)
		if err != nil {
			return nil, "", err
		}
		processors = append(processors, sdktrace.NewBatchSpanProcessor(exporter))
		release = langfuseRelease()
	}

	if len(processors) == 0 {
		return nil, "", nil
	}

	options := []sdktrace.TracerProviderOption{sdktrace.WithResource(res)}
	for _, processor := range processors {
		options = append(options, sdktrace.WithSpanProcessor(processor))
	}
	return sdktrace.NewTracerProvider(options...), release, nil
}

// createLoggerProvider mirrors the TS createLoggerProvider.
func createLoggerProvider(ctx context.Context, res *resource.Resource) (*sdklog.LoggerProvider, error) {
	var options []sdklog.LoggerProviderOption
	count := 0
	for _, exporterType := range ParseExporterTypes(os.Getenv("OTEL_LOGS_EXPORTER")) {
		var exporter sdklog.Exporter
		var err error
		switch exporterType {
		case "console":
			exporter, err = stdoutlog.New()
		case "otlp":
			var protocol otlpProtocol
			protocol, err = getProtocol("logs")
			if err == nil {
				exporter, err = createLogExporter(ctx, protocol)
			}
		default:
			err = fmt.Errorf("unsupported log exporter: %s", exporterType)
		}
		if err != nil {
			return nil, err
		}
		options = append(options, sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)))
		count++
	}
	if count == 0 {
		return nil, nil
	}
	options = append(options, sdklog.WithResource(res))
	return sdklog.NewLoggerProvider(options...), nil
}

// createMetricReaders mirrors the TS createMetricReaders.
func createMetricReaders(ctx context.Context) ([]sdkmetric.Reader, error) {
	var readers []sdkmetric.Reader
	interval := time.Duration(parsePositiveInteger(os.Getenv("OTEL_METRIC_EXPORT_INTERVAL"), defaultExportIntervalMS)) * time.Millisecond
	for _, exporterType := range ParseExporterTypes(os.Getenv("OTEL_METRICS_EXPORTER")) {
		if exporterType == "prometheus" {
			exporter, err := prometheus.New()
			if err != nil {
				return nil, err
			}
			readers = append(readers, exporter)
			continue
		}

		var exporter sdkmetric.Exporter
		var err error
		switch exporterType {
		case "console":
			exporter, err = stdoutmetric.New()
		case "otlp":
			var protocol otlpProtocol
			protocol, err = getProtocol("metrics")
			if err == nil {
				exporter, err = createMetricExporter(ctx, protocol)
			}
		default:
			err = fmt.Errorf("unsupported metric exporter: %s", exporterType)
		}
		if err != nil {
			return nil, err
		}
		readers = append(readers, sdkmetric.NewPeriodicReader(exporter, sdkmetric.WithInterval(interval)))
	}
	return readers, nil
}

// errorTypeName mirrors the TS `error instanceof Error ? error.name : typeof
// error`: the concrete error type name, dereferencing pointers.
func errorTypeName(err error) string {
	if err == nil {
		return "undefined"
	}
	t := reflect.TypeOf(err)
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if name := t.Name(); name != "" {
		return name
	}
	return t.String()
}

// toAttribute converts a TelemetryAttributes value (string/number/bool) to an
// OTel attribute; anything else is stringified.
func toAttribute(key string, value any) attribute.KeyValue {
	switch v := value.(type) {
	case string:
		return attribute.String(key, v)
	case bool:
		return attribute.Bool(key, v)
	case int:
		return attribute.Int(key, v)
	case int64:
		return attribute.Int64(key, v)
	case float64:
		return attribute.Float64(key, v)
	case float32:
		return attribute.Float64(key, float64(v))
	case uint64:
		return attribute.Int64(key, int64(v))
	default:
		return attribute.String(key, fmt.Sprint(v))
	}
}

// providerObservation mirrors the TS ProviderObservation: a wrapper around an
// OTel span carrying the Langfuse observation attributes.
type providerObservation struct {
	runtime *ProviderRuntime
	span    trace.Span
}

func (o *providerObservation) End() {
	o.span.End()
}

// RecordException mirrors the TS recordException: error.type attribute, ERROR
// span status, and level/status_message observation updates.
func (o *providerObservation) RecordException(err error) {
	errorType := errorTypeName(err)
	o.span.SetAttributes(attribute.String("error.type", errorType))
	o.span.SetStatus(codes.Error, "")
	o.Update(ObservationUpdate{Level: ObservationLevelError, StatusMessage: errorType})
}

// StartChild mirrors the TS startChild: a span derived from the parent span
// context.
func (o *providerObservation) StartChild(kind ObservationKind, name string, attrs Attributes) Observation {
	ctx := trace.ContextWithSpan(context.Background(), o.span)
	_, span := o.runtime.tracer.Start(ctx, name, trace.WithAttributes(o.runtime.observationAttributes(kind, attrs)...))
	return &providerObservation{runtime: o.runtime, span: span}
}

// Update mirrors the TS update -> updateOtelSpanAttributes mapping onto
// langfuse.observation.* span attributes, with the Langfuse SDK's
// serialization: usage_details is ONE attribute holding JSON.stringify of the
// whole map (json.Marshal sorts map keys, matching the TS insertion order of
// the current call sites), completion_start_time is the JS toISOString form
// (UTC, exactly three decimal places), and metadata values are strings.
func (o *providerObservation) Update(update ObservationUpdate) {
	attrs := make([]attribute.KeyValue, 0, len(update.Metadata)+4)
	if update.Level != "" {
		attrs = append(attrs, attribute.String("langfuse.observation.level", string(update.Level)))
	}
	if update.StatusMessage != "" {
		attrs = append(attrs, attribute.String("langfuse.observation.status_message", update.StatusMessage))
	}
	if update.Model != "" {
		attrs = append(attrs, attribute.String("langfuse.observation.model.name", update.Model))
	}
	if update.CompletionStartTime != nil {
		attrs = append(attrs, attribute.String("langfuse.observation.completion_start_time",
			update.CompletionStartTime.UTC().Format("2006-01-02T15:04:05.000")+"Z"))
	}
	if len(update.UsageDetails) > 0 {
		if serialized, err := json.Marshal(update.UsageDetails); err == nil {
			attrs = append(attrs, attribute.String("langfuse.observation.usage_details", string(serialized)))
		}
	}
	for key, value := range update.Metadata {
		if serialized, ok := serializeMetadataValue(value); ok {
			attrs = append(attrs, attribute.String("langfuse.observation.metadata."+key, serialized))
		}
	}
	if len(attrs) > 0 {
		o.span.SetAttributes(attrs...)
	}
}

// ProviderRuntime mirrors the TS ProviderRuntime: the real Runtime backed by
// OTel tracer/logger/meter providers (each optional) plus the optional
// Sentry error channel.
type ProviderRuntime struct {
	tracerProvider *sdktrace.TracerProvider
	loggerProvider *sdklog.LoggerProvider
	meterProvider  *sdkmetric.MeterProvider
	tracer         trace.Tracer
	logger         otellog.Logger
	meter          metric.Meter

	// sentryEnabled records that sentry.Init succeeded (TS: the sentry module
	// reference is non-null). Error capture, the mode tag and flush/shutdown
	// all gate on it.
	sentryEnabled bool

	// langfuseRelease holds the langfuse.release span attribute value; empty
	// when Langfuse is not configured.
	langfuseRelease string

	instrumentMu sync.Mutex
	counters     map[string]metric.Float64Counter
	histograms   map[string]metric.Float64Histogram

	modeMu sync.RWMutex
	mode   Mode
}

func newProviderRuntime(tracerProvider *sdktrace.TracerProvider, loggerProvider *sdklog.LoggerProvider, meterProvider *sdkmetric.MeterProvider, langfuseRelease string, sentryEnabled bool) *ProviderRuntime {
	r := &ProviderRuntime{
		tracerProvider:  tracerProvider,
		loggerProvider:  loggerProvider,
		meterProvider:   meterProvider,
		langfuseRelease: langfuseRelease,
		sentryEnabled:   sentryEnabled,
		counters:        map[string]metric.Float64Counter{},
		histograms:      map[string]metric.Float64Histogram{},
		mode:            ModeUnknown,
	}
	if tracerProvider != nil {
		r.tracer = tracerProvider.Tracer(langfuseTracerName, trace.WithInstrumentationVersion(version.Get()))
	}
	if loggerProvider != nil {
		r.logger = loggerProvider.Logger(instrumentationName, otellog.WithInstrumentationVersion(version.Get()))
	}
	if meterProvider != nil {
		r.meter = meterProvider.Meter(instrumentationName, metric.WithInstrumentationVersion(version.Get()))
	}
	return r
}

func (r *ProviderRuntime) getMode() Mode {
	r.modeMu.RLock()
	defer r.modeMu.RUnlock()
	return r.mode
}

// SetMode mirrors the TS setMode, including the Sentry yukino.mode tag.
func (r *ProviderRuntime) SetMode(mode Mode) {
	r.modeMu.Lock()
	r.mode = mode
	r.modeMu.Unlock()
	if r.sentryEnabled {
		sentry.ConfigureScope(func(scope *sentry.Scope) {
			scope.SetTag("yukino.mode", string(mode))
		})
	}
}

// observationAttributes builds the span attributes for an observation,
// mirroring the TS Langfuse SDK's createObservationAttributes: the
// observation type, the release (Langfuse only), the generation model name
// and the caller attributes flattened into langfuse.observation.metadata.<key>
// string values. The yukino.mode metadata entry is merged by StartObservation
// for root observations only, exactly like the TS ProviderRuntime (root
// startObservation merges it; startChild passes attributes through).
func (r *ProviderRuntime) observationAttributes(kind ObservationKind, attrs Attributes) []attribute.KeyValue {
	spanAttrs := make([]attribute.KeyValue, 0, len(attrs)+3)
	spanAttrs = append(spanAttrs, attribute.String("langfuse.observation.type", string(kind)))
	if r.langfuseRelease != "" {
		spanAttrs = append(spanAttrs, attribute.String("langfuse.release", r.langfuseRelease))
	}
	if kind == ObservationGeneration {
		if model, ok := attrs["model"].(string); ok {
			spanAttrs = append(spanAttrs, attribute.String("langfuse.observation.model.name", model))
		}
	}
	for key, value := range attrs {
		if serialized, ok := serializeMetadataValue(value); ok {
			spanAttrs = append(spanAttrs, attribute.String("langfuse.observation.metadata."+key, serialized))
		}
	}
	return spanAttrs
}

// serializeMetadataValue mirrors the TS _flattenAndSerializeMetadata value
// handling: strings pass through, everything else is JSON.stringify'd,
// null/undefined (nil) and empty strings are dropped (the TS `if
// (serialized)` filter), and serialization failures degrade to the TS
// "<failed to serialize>" marker.
func serializeMetadataValue(value any) (string, bool) {
	if value == nil {
		return "", false
	}
	if s, ok := value.(string); ok {
		if s == "" {
			return "", false
		}
		return s, true
	}
	serialized, err := json.Marshal(value)
	if err != nil {
		return "<failed to serialize>", true
	}
	return string(serialized), true
}

// StartObservation mirrors the TS startObservation: a noop chain without a
// tracer provider, otherwise a span carrying the observation attributes with
// yukino.mode merged into the metadata (TS ProviderRuntime.startObservation).
func (r *ProviderRuntime) StartObservation(kind ObservationKind, name string, attrs Attributes) Observation {
	if r.tracerProvider == nil {
		return noopObservation{}
	}
	merged := make(Attributes, len(attrs)+1)
	for key, value := range attrs {
		merged[key] = value
	}
	merged["yukino.mode"] = string(r.getMode())
	_, span := r.tracer.Start(context.Background(), name, trace.WithAttributes(r.observationAttributes(kind, merged)...))
	return &providerObservation{runtime: r, span: span}
}

func severityNumber(severity LogSeverity) otellog.Severity {
	switch severity {
	case LogSeverityError:
		return otellog.SeverityError
	case LogSeverityWarn:
		return otellog.SeverityWarn
	default:
		return otellog.SeverityInfo
	}
}

// EmitLog mirrors the TS emitLog: body=name, mapped severity, attributes plus
// yukino.mode. Noop without a logger provider.
func (r *ProviderRuntime) EmitLog(name string, severity LogSeverity, attrs Attributes) {
	if r.logger == nil {
		return
	}
	var record otellog.Record
	record.SetBody(attribute.StringValue(name))
	record.SetSeverity(severityNumber(severity))
	record.SetSeverityText(strings.ToUpper(string(severity)))
	logAttrs := make([]attribute.KeyValue, 0, len(attrs)+1)
	for key, value := range attrs {
		logAttrs = append(logAttrs, toAttribute(key, value))
	}
	logAttrs = append(logAttrs, attribute.String("yukino.mode", string(r.getMode())))
	record.AddAttributes(logAttrs...)
	r.logger.Emit(context.Background(), record)
}

// CaptureError mirrors the TS captureError: the error goes to Sentry (when
// initialized) with context/mode tags, and through the OTel log pipeline.
func (r *ProviderRuntime) CaptureError(err error, errContext string) {
	if r.sentryEnabled && err != nil {
		mode := string(r.getMode())
		sentry.WithScope(func(scope *sentry.Scope) {
			scope.SetTag("context", errContext)
			scope.SetTag("mode", mode)
			sentry.CaptureException(err)
		})
	}
	r.EmitLog("yukino.error", LogSeverityError, Attributes{
		"context":    errContext,
		"error.type": errorTypeName(err),
	})
}

// RecordMetric mirrors the TS recordMetric: cached Float64 counter/histogram
// instruments (histograms use unit "ms"), attributes plus yukino.mode.
func (r *ProviderRuntime) RecordMetric(name string, kind MetricKind, value float64, attrs Attributes) {
	if r.meter == nil {
		return
	}
	kvs := make([]attribute.KeyValue, 0, len(attrs)+1)
	for key, val := range attrs {
		kvs = append(kvs, toAttribute(key, val))
	}
	kvs = append(kvs, attribute.String("yukino.mode", string(r.getMode())))
	ctx := context.Background()

	if kind == MetricCounter {
		r.instrumentMu.Lock()
		counter, ok := r.counters[name]
		if !ok {
			var err error
			counter, err = r.meter.Float64Counter(name)
			if err != nil {
				r.instrumentMu.Unlock()
				return
			}
			r.counters[name] = counter
		}
		r.instrumentMu.Unlock()
		counter.Add(ctx, value, metric.WithAttributes(kvs...))
		return
	}

	r.instrumentMu.Lock()
	histogram, ok := r.histograms[name]
	if !ok {
		var err error
		histogram, err = r.meter.Float64Histogram(name, metric.WithUnit("ms"))
		if err != nil {
			r.instrumentMu.Unlock()
			return
		}
		r.histograms[name] = histogram
	}
	r.instrumentMu.Unlock()
	histogram.Record(ctx, value, metric.WithAttributes(kvs...))
}

// withShutdownTimeout mirrors the TS withTimeout(Promise.allSettled(...)):
// run all operations concurrently and wait at most shutdownTimeout; errors
// are swallowed.
func withShutdownTimeout(operations ...func(context.Context) error) {
	if len(operations) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		for _, op := range operations {
			wg.Add(1)
			go func(op func(context.Context) error) {
				defer wg.Done()
				_ = op(ctx)
			}(op)
		}
		wg.Wait()
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

// Flush mirrors the TS flush: ForceFlush every configured provider (and the
// Sentry transport) with the shared shutdown timeout, swallowing errors
// (Promise.allSettled semantics). The passed context is ignored to match the
// fixed TS timeout.
func (r *ProviderRuntime) Flush(ctx context.Context) error {
	var operations []func(context.Context) error
	if r.tracerProvider != nil {
		operations = append(operations, r.tracerProvider.ForceFlush)
	}
	if r.loggerProvider != nil {
		operations = append(operations, r.loggerProvider.ForceFlush)
	}
	if r.meterProvider != nil {
		operations = append(operations, r.meterProvider.ForceFlush)
	}
	if r.sentryEnabled {
		operations = append(operations, flushSentry)
	}
	withShutdownTimeout(operations...)
	return nil
}

// Shutdown mirrors the TS shutdown: Shutdown every configured provider with
// the shared shutdown timeout, swallowing errors. TS closes the Sentry
// client with the same timeout; sentry-go has no Close, so the equivalent
// is a bounded Flush of its transport. The passed context is ignored to
// match the fixed TS timeout.
func (r *ProviderRuntime) Shutdown(ctx context.Context) error {
	var operations []func(context.Context) error
	if r.tracerProvider != nil {
		operations = append(operations, r.tracerProvider.Shutdown)
	}
	if r.loggerProvider != nil {
		operations = append(operations, r.loggerProvider.Shutdown)
	}
	if r.meterProvider != nil {
		operations = append(operations, r.meterProvider.Shutdown)
	}
	if r.sentryEnabled {
		operations = append(operations, flushSentry)
	}
	withShutdownTimeout(operations...)
	return nil
}

// flushSentry drains the Sentry transport within the shared shutdown timeout
// (TS: sentry.flush(SHUTDOWN_TIMEOUT_MS) / sentry.close(SHUTDOWN_TIMEOUT_MS)).
func flushSentry(context.Context) error {
	sentry.Flush(shutdownTimeout)
	return nil
}

// initializeSentry mirrors the TS initializeSentry: gated on SENTRY_DSN,
// errors-only (tracesSampleRate 0), no default PII, release from
// SENTRY_RELEASE falling back to the package version. sentry-go installs no
// global panic handlers by default, matching the TS integration filter that
// drops OnUncaughtException/OnUnhandledRejection, and it performs no
// OpenTelemetry setup (TS: skipOpenTelemetrySetup).
func initializeSentry() bool {
	dsn := os.Getenv("SENTRY_DSN")
	if dsn == "" {
		return false
	}
	release := os.Getenv("SENTRY_RELEASE")
	if release == "" {
		release = version.Get()
	}
	err := sentry.Init(sentry.ClientOptions{
		Dsn:              dsn,
		Debug:            strings.ToLower(os.Getenv("SENTRY_DEBUG")) == "true",
		Environment:      os.Getenv("SENTRY_ENVIRONMENT"),
		Release:          release,
		SendDefaultPII:   false,
		TracesSampleRate: 0,
	})
	return err == nil
}

// CreateTelemetryRuntime mirrors the TS createTelemetryRuntime: build the
// resource and, unless OTEL_SDK_DISABLED=true, each subsystem; failures
// degrade the affected subsystem to nil (TS safely() semantics) instead of
// failing the whole runtime. Sentry initializes independently of the OTel
// gate, exactly like the TS Promise.all branch.
func CreateTelemetryRuntime(ctx context.Context) (Runtime, error) {
	res := createResource()
	otelEnabled := strings.ToLower(os.Getenv("OTEL_SDK_DISABLED")) != "true"

	var tracerProvider *sdktrace.TracerProvider
	var loggerProvider *sdklog.LoggerProvider
	var meterProvider *sdkmetric.MeterProvider
	langfuseRelease := ""

	if otelEnabled {
		if tp, release, err := createTracerProvider(ctx, res); err == nil {
			tracerProvider = tp
			langfuseRelease = release
		}
		if lp, err := createLoggerProvider(ctx, res); err == nil {
			loggerProvider = lp
		}
		if readers, err := createMetricReaders(ctx); err == nil && len(readers) > 0 {
			options := []sdkmetric.Option{sdkmetric.WithResource(res)}
			for _, reader := range readers {
				options = append(options, sdkmetric.WithReader(reader))
			}
			meterProvider = sdkmetric.NewMeterProvider(options...)
		}
	}
	sentryEnabled := initializeSentry()

	return newProviderRuntime(tracerProvider, loggerProvider, meterProvider, langfuseRelease, sentryEnabled), nil
}
