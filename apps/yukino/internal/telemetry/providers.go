package telemetry

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/getsentry/sentry-go"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	otelprometheus "go.opentelemetry.io/otel/exporters/prometheus"
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

	"github.com/yukino-js/yukino/yukino/internal/logger"
	"github.com/yukino-js/yukino/yukino/internal/utils"
	"github.com/yukino-js/yukino/yukino/internal/version"
)

var telemetryLog = logger.CreateChildLogger("telemetry")

// observationKindAttribute carries the observation type on spans; the Langfuse
// processor that consumed it in the reference has no official Go SDK and is
// not ported.
const observationKindAttribute = "yukino.observation.kind"

// ParseExporterTypes splits an OTEL_*_EXPORTER value into exporter tokens.
func ParseExporterTypes(value string) []string {
	var out []string
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item != "" && item != ExporterNone {
			out = append(out, item)
		}
	}
	return out
}

func parsePositiveInteger(value string, fallback int) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err == nil && parsed > 0 {
		return parsed
	}
	return fallback
}

// getProtocol resolves the OTLP protocol for a signal. The Go OTLP HTTP
// exporter only speaks protobuf, so http/json is rejected like any other
// unsupported protocol.
func getProtocol(signal string) (string, error) {
	signalKey := "OTEL_EXPORTER_OTLP_" + strings.ToUpper(signal) + "_PROTOCOL"
	configured := strings.TrimSpace(os.Getenv(signalKey))
	if configured == "" {
		configured = strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_PROTOCOL"))
	}
	protocol := configured
	if protocol == "" {
		protocol = DefaultOtlpProtocol
	}
	switch protocol {
	case OtlpProtocolGrpc, OtlpProtocolHTTPProtobuf:
		return protocol, nil
	default:
		return "", fmt.Errorf("unsupported OpenTelemetry protocol: %s", protocol)
	}
}

func parseResourceAttributes(value string) []attribute.KeyValue {
	var attrs []attribute.KeyValue
	if value == "" {
		return attrs
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
		decodedKey, keyErr := utils.DecodeURIComponent(key)
		decodedValue, valueErr := utils.DecodeURIComponent(rawValue)
		if keyErr != nil || valueErr != nil {
			attrs = append(attrs, attribute.String(key, rawValue))
			continue
		}
		attrs = append(attrs, attribute.String(decodedKey, decodedValue))
	}
	return attrs
}

func createResource() *resource.Resource {
	attrs := map[string]string{
		"service.name":    ServiceName,
		"service.version": version.Version,
	}
	for _, kv := range parseResourceAttributes(os.Getenv("OTEL_RESOURCE_ATTRIBUTES")) {
		attrs[string(kv.Key)] = kv.Value.AsString()
	}
	if name := os.Getenv("OTEL_SERVICE_NAME"); name != "" {
		attrs["service.name"] = name
	}
	keys := make([]string, 0, len(attrs))
	for key := range attrs {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	kvs := make([]attribute.KeyValue, 0, len(keys))
	for _, key := range keys {
		kvs = append(kvs, attribute.String(key, attrs[key]))
	}
	return resource.NewSchemaless(kvs...)
}

func createTraceExporter(ctx context.Context, protocol string) (sdktrace.SpanExporter, error) {
	switch protocol {
	case OtlpProtocolGrpc:
		return otlptracegrpc.New(ctx)
	case OtlpProtocolHTTPProtobuf:
		return otlptracehttp.New(ctx)
	}
	return nil, fmt.Errorf("unsupported OpenTelemetry protocol: %s", protocol)
}

func createLogExporter(ctx context.Context, protocol string) (sdklog.Exporter, error) {
	switch protocol {
	case OtlpProtocolGrpc:
		return otlploggrpc.New(ctx)
	case OtlpProtocolHTTPProtobuf:
		return otlploghttp.New(ctx)
	}
	return nil, fmt.Errorf("unsupported OpenTelemetry protocol: %s", protocol)
}

func createMetricExporter(ctx context.Context, protocol string) (sdkmetric.Exporter, error) {
	switch protocol {
	case OtlpProtocolGrpc:
		return otlpmetricgrpc.New(ctx)
	case OtlpProtocolHTTPProtobuf:
		return otlpmetrichttp.New(ctx)
	}
	return nil, fmt.Errorf("unsupported OpenTelemetry protocol: %s", protocol)
}

func createTracerProvider(ctx context.Context, res *resource.Resource) (*sdktrace.TracerProvider, error) {
	var processors []sdktrace.SpanProcessor
	for _, exporterType := range ParseExporterTypes(os.Getenv("OTEL_TRACES_EXPORTER")) {
		switch exporterType {
		case ExporterConsole:
			exporter, err := stdouttrace.New()
			if err != nil {
				return nil, err
			}
			processors = append(processors, sdktrace.NewBatchSpanProcessor(exporter))
		case ExporterOtlp:
			protocol, err := getProtocol("traces")
			if err != nil {
				return nil, err
			}
			exporter, err := createTraceExporter(ctx, protocol)
			if err != nil {
				return nil, err
			}
			processors = append(processors, sdktrace.NewBatchSpanProcessor(exporter))
		default:
			return nil, fmt.Errorf("unsupported trace exporter: %s", exporterType)
		}
	}
	if len(processors) == 0 {
		return nil, nil
	}
	opts := []sdktrace.TracerProviderOption{sdktrace.WithResource(res)}
	for _, processor := range processors {
		opts = append(opts, sdktrace.WithSpanProcessor(processor))
	}
	return sdktrace.NewTracerProvider(opts...), nil
}

func createLoggerProvider(ctx context.Context, res *resource.Resource) (*sdklog.LoggerProvider, error) {
	var processors []sdklog.Processor
	for _, exporterType := range ParseExporterTypes(os.Getenv("OTEL_LOGS_EXPORTER")) {
		var exporter sdklog.Exporter
		var err error
		switch exporterType {
		case ExporterConsole:
			exporter, err = stdoutlog.New()
		case ExporterOtlp:
			var protocol string
			if protocol, err = getProtocol("logs"); err == nil {
				exporter, err = createLogExporter(ctx, protocol)
			}
		default:
			return nil, fmt.Errorf("unsupported log exporter: %s", exporterType)
		}
		if err != nil {
			return nil, err
		}
		processors = append(processors, sdklog.NewBatchProcessor(exporter))
	}
	if len(processors) == 0 {
		return nil, nil
	}
	opts := []sdklog.LoggerProviderOption{sdklog.WithResource(res)}
	for _, processor := range processors {
		opts = append(opts, sdklog.WithProcessor(processor))
	}
	return sdklog.NewLoggerProvider(opts...), nil
}

func createMetricReaders(ctx context.Context) ([]sdkmetric.Reader, error) {
	var readers []sdkmetric.Reader
	exportInterval := parsePositiveInteger(os.Getenv("OTEL_METRIC_EXPORT_INTERVAL"), DefaultExportIntervalMs)
	for _, exporterType := range ParseExporterTypes(os.Getenv("OTEL_METRICS_EXPORTER")) {
		if exporterType == ExporterPrometheus {
			reader, err := otelprometheus.New()
			if err != nil {
				return nil, err
			}
			readers = append(readers, reader)
			continue
		}
		var exporter sdkmetric.Exporter
		var err error
		switch exporterType {
		case ExporterConsole:
			exporter, err = stdoutmetric.New()
		case ExporterOtlp:
			var protocol string
			if protocol, err = getProtocol("metrics"); err == nil {
				exporter, err = createMetricExporter(ctx, protocol)
			}
		default:
			return nil, fmt.Errorf("unsupported metric exporter: %s", exporterType)
		}
		if err != nil {
			return nil, err
		}
		readers = append(readers, sdkmetric.NewPeriodicReader(exporter,
			sdkmetric.WithInterval(time.Duration(exportInterval)*time.Millisecond)))
	}
	return readers, nil
}

func initializeSentry() (bool, error) {
	dsn := os.Getenv("SENTRY_DSN")
	if dsn == "" {
		return false, nil
	}
	release := os.Getenv("SENTRY_RELEASE")
	if release == "" {
		release = version.Version
	}
	err := sentry.Init(sentry.ClientOptions{
		Debug:            strings.EqualFold(os.Getenv("SENTRY_DEBUG"), "true"),
		Dsn:              dsn,
		Environment:      os.Getenv("SENTRY_ENVIRONMENT"),
		Release:          release,
		SendDefaultPII:   false,
		TracesSampleRate: SentryTracesSampleRate,
		BeforeSend: func(event *sentry.Event, hint *sentry.EventHint) *sentry.Event {
			if event.Request != nil {
				event.Request.Data = ""
				event.Request.Cookies = ""
			}
			ScrubSentryEvent(event)
			return event
		},
	})
	if err != nil {
		return false, err
	}
	return true, nil
}

func safely[T any](label string, operation func() (T, error)) T {
	result, err := operation()
	if err != nil {
		telemetryLog.Error(map[string]any{"err": err, "label": label}, "telemetry initialization failed")
		var zero T
		return zero
	}
	return result
}

func withTimeout(operation func()) {
	done := make(chan struct{})
	go func() {
		operation()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(ShutdownTimeout):
	}
}

func otelSeverity(severity Severity) otellog.Severity {
	switch severity {
	case SeverityError:
		return otellog.SeverityError
	case SeverityInfo:
		return otellog.SeverityInfo
	case SeverityWarn:
		return otellog.SeverityWarn
	}
	return otellog.SeverityUndefined
}

func toOTelAttribute(key string, value any) attribute.KeyValue {
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
	default:
		return attribute.String(key, fmt.Sprint(v))
	}
}

func toOTelAttributes(attributes TelemetryAttributes) []attribute.KeyValue {
	keys := make([]string, 0, len(attributes))
	for key := range attributes {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	kvs := make([]attribute.KeyValue, 0, len(keys))
	for _, key := range keys {
		kvs = append(kvs, toOTelAttribute(key, attributes[key]))
	}
	return kvs
}

// ProviderObservation maps a telemetry observation onto an OTel span.
type ProviderObservation struct {
	tracer trace.Tracer
	span   trace.Span
}

func (o *ProviderObservation) End() {
	o.span.End()
}

func (o *ProviderObservation) RecordException(err error) {
	errorType := errorTypeName(err)
	o.span.SetAttributes(
		attribute.String(AttributeErrorType, errorType),
		attribute.String("level", ObservationLevelError),
		attribute.String("status_message", errorType),
	)
	o.span.SetStatus(codes.Error, "")
}

func (o *ProviderObservation) StartChild(kind TelemetryObservationKind, name string, attributes TelemetryAttributes) TelemetryObservation {
	ctx := trace.ContextWithSpan(context.Background(), o.span)
	_, span := o.tracer.Start(ctx, name, trace.WithAttributes(observationAttributes(kind, attributes)...))
	return &ProviderObservation{tracer: o.tracer, span: span}
}

func (o *ProviderObservation) Update(update TelemetryObservationUpdate) {
	var attrs []attribute.KeyValue
	if update.CompletionStartTime != nil {
		attrs = append(attrs, attribute.String("completion_start_time", update.CompletionStartTime.UTC().Format(time.RFC3339Nano)))
	}
	if update.Level != "" {
		attrs = append(attrs, attribute.String("level", update.Level))
	}
	metadataKeys := make([]string, 0, len(update.Metadata))
	for key := range update.Metadata {
		metadataKeys = append(metadataKeys, key)
	}
	sort.Strings(metadataKeys)
	for _, key := range metadataKeys {
		attrs = append(attrs, toOTelAttribute("metadata."+key, update.Metadata[key]))
	}
	if update.Model != "" {
		attrs = append(attrs, attribute.String("gen_ai.request.model", update.Model))
	}
	if update.StatusMessage != "" {
		attrs = append(attrs, attribute.String("status_message", update.StatusMessage))
	}
	usageKeys := make([]string, 0, len(update.UsageDetails))
	for key := range update.UsageDetails {
		usageKeys = append(usageKeys, key)
	}
	sort.Strings(usageKeys)
	for _, key := range usageKeys {
		attrs = append(attrs, attribute.Float64("usage_details."+key, update.UsageDetails[key]))
	}
	if len(attrs) > 0 {
		o.span.SetAttributes(attrs...)
	}
}

func observationAttributes(kind TelemetryObservationKind, attributes TelemetryAttributes) []attribute.KeyValue {
	attrs := toOTelAttributes(attributes)
	attrs = append(attrs, attribute.String(observationKindAttribute, string(kind)))
	if kind == ObservationKindGeneration {
		if model, ok := attributes["model"].(string); ok && model != "" {
			attrs = append(attrs, attribute.String("gen_ai.request.model", model))
		}
	}
	return attrs
}

// ProviderRuntime implements TelemetryRuntime on top of the OTel SDKs and
// sentry-go.
type ProviderRuntime struct {
	tracerProvider *sdktrace.TracerProvider
	loggerProvider *sdklog.LoggerProvider
	meterProvider  *sdkmetric.MeterProvider
	meter          metric.Meter
	logger         otellog.Logger
	sentryEnabled  bool

	mu         sync.Mutex
	counters   map[string]metric.Float64Counter
	histograms map[string]metric.Float64Histogram
	mode       TelemetryMode
}

func (r *ProviderRuntime) getMode() TelemetryMode {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.mode
}

func (r *ProviderRuntime) CaptureError(err error, contextName string) {
	if errors.Is(err, context.Canceled) {
		return
	}
	if r.sentryEnabled {
		hub := sentry.CurrentHub().Clone()
		hub.Scope().SetTags(map[string]string{"context": contextName, "mode": string(r.getMode())})
		hub.CaptureException(err)
	}
	r.EmitLog(LogError, SeverityError, TelemetryAttributes{
		"context":          contextName,
		AttributeErrorType: errorTypeName(err),
	})
}

func (r *ProviderRuntime) EmitLog(name string, severity Severity, attributes TelemetryAttributes) {
	if r.logger == nil {
		return
	}
	var record otellog.Record
	record.SetBody(attribute.StringValue(name))
	record.SetSeverity(otelSeverity(severity))
	record.SetSeverityText(strings.ToUpper(string(severity)))
	record.AddAttributes(toOTelAttributes(attributes)...)
	record.AddAttributes(attribute.String(AttributeMode, string(r.getMode())))
	r.logger.Emit(context.Background(), record)
}

func (r *ProviderRuntime) Flush() {
	ctx, cancel := context.WithTimeout(context.Background(), ShutdownTimeout)
	defer cancel()
	var wg sync.WaitGroup
	if r.tracerProvider != nil {
		wg.Add(1)
		go func() { defer wg.Done(); _ = r.tracerProvider.ForceFlush(ctx) }()
	}
	if r.loggerProvider != nil {
		wg.Add(1)
		go func() { defer wg.Done(); _ = r.loggerProvider.ForceFlush(ctx) }()
	}
	if r.meterProvider != nil {
		wg.Add(1)
		go func() { defer wg.Done(); _ = r.meterProvider.ForceFlush(ctx) }()
	}
	if r.sentryEnabled {
		wg.Add(1)
		go func() { defer wg.Done(); sentry.Flush(ShutdownTimeout) }()
	}
	withTimeout(wg.Wait)
}

func (r *ProviderRuntime) RecordMetric(name string, kind TelemetryMetricKind, value float64, attributes TelemetryAttributes) {
	if r.meter == nil {
		return
	}
	otelAttrs := metric.WithAttributes(append(toOTelAttributes(attributes), attribute.String(AttributeMode, string(r.getMode())))...)
	if kind == MetricKindCounter {
		r.mu.Lock()
		counter, ok := r.counters[name]
		if !ok {
			created, err := r.meter.Float64Counter(name)
			if err != nil {
				r.mu.Unlock()
				return
			}
			counter = created
			r.counters[name] = counter
		}
		r.mu.Unlock()
		counter.Add(context.Background(), value, otelAttrs)
		return
	}
	r.mu.Lock()
	histogram, ok := r.histograms[name]
	if !ok {
		created, err := r.meter.Float64Histogram(name, metric.WithUnit(HistogramUnit))
		if err != nil {
			r.mu.Unlock()
			return
		}
		histogram = created
		r.histograms[name] = histogram
	}
	r.mu.Unlock()
	histogram.Record(context.Background(), value, otelAttrs)
}

func (r *ProviderRuntime) SetMode(nextMode TelemetryMode) {
	r.mu.Lock()
	r.mode = nextMode
	r.mu.Unlock()
	if r.sentryEnabled {
		sentry.CurrentHub().Scope().SetTag(AttributeMode, string(nextMode))
	}
}

func (r *ProviderRuntime) Shutdown() {
	ctx, cancel := context.WithTimeout(context.Background(), ShutdownTimeout)
	defer cancel()
	var wg sync.WaitGroup
	if r.tracerProvider != nil {
		wg.Add(1)
		go func() { defer wg.Done(); _ = r.tracerProvider.Shutdown(ctx) }()
	}
	if r.loggerProvider != nil {
		wg.Add(1)
		go func() { defer wg.Done(); _ = r.loggerProvider.Shutdown(ctx) }()
	}
	if r.meterProvider != nil {
		wg.Add(1)
		go func() { defer wg.Done(); _ = r.meterProvider.Shutdown(ctx) }()
	}
	if r.sentryEnabled {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sentry.Flush(ShutdownTimeout)
			if client := sentry.CurrentHub().Client(); client != nil {
				client.Close()
			}
		}()
	}
	withTimeout(wg.Wait)
}

func (r *ProviderRuntime) StartObservation(kind TelemetryObservationKind, name string, attributes TelemetryAttributes) TelemetryObservation {
	if r.tracerProvider == nil {
		return noopObservation{}
	}
	tracer := r.tracerProvider.Tracer(InstrumentationScopeName)
	_, span := tracer.Start(context.Background(), name,
		trace.WithAttributes(observationAttributes(kind, mergeAttributes(attributes, TelemetryAttributes{AttributeMode: string(r.getMode())}))...))
	return &ProviderObservation{tracer: tracer, span: span}
}

func createTelemetryRuntime() TelemetryRuntime {
	ctx := context.Background()
	res := createResource()
	otelEnabled := !strings.EqualFold(os.Getenv("OTEL_SDK_DISABLED"), "true")

	var tracerProvider *sdktrace.TracerProvider
	var loggerProvider *sdklog.LoggerProvider
	var meterProvider *sdkmetric.MeterProvider
	if otelEnabled {
		tracerProvider = safely("traces", func() (*sdktrace.TracerProvider, error) {
			return createTracerProvider(ctx, res)
		})
		loggerProvider = safely("logs", func() (*sdklog.LoggerProvider, error) {
			return createLoggerProvider(ctx, res)
		})
		metricReaders := safely("metrics", func() ([]sdkmetric.Reader, error) {
			return createMetricReaders(ctx)
		})
		if len(metricReaders) > 0 {
			opts := []sdkmetric.Option{sdkmetric.WithResource(res)}
			for _, reader := range metricReaders {
				opts = append(opts, sdkmetric.WithReader(reader))
			}
			meterProvider = sdkmetric.NewMeterProvider(opts...)
		}
	}
	sentryEnabled := safely("sentry", initializeSentry)

	runtime := &ProviderRuntime{
		tracerProvider: tracerProvider,
		loggerProvider: loggerProvider,
		meterProvider:  meterProvider,
		sentryEnabled:  sentryEnabled,
		counters:       map[string]metric.Float64Counter{},
		histograms:     map[string]metric.Float64Histogram{},
		mode:           ModeUnknown,
	}
	if meterProvider != nil {
		runtime.meter = meterProvider.Meter(InstrumentationScopeName, metric.WithInstrumentationVersion(version.Version))
	}
	if loggerProvider != nil {
		runtime.logger = loggerProvider.Logger(InstrumentationScopeName, otellog.WithInstrumentationVersion(version.Version))
	}
	return runtime
}
