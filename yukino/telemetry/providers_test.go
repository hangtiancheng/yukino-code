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
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/version"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	otellog "go.opentelemetry.io/otel/log"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestParseExporterTypes(t *testing.T) {
	tests := []struct {
		value string
		want  []string
	}{
		{value: "otlp, console, none", want: []string{"otlp", "console"}},
		{value: "", want: []string{}},
		{value: " , none ,", want: []string{}},
		{value: "otlp", want: []string{"otlp"}},
		{value: "prometheus,none,console", want: []string{"prometheus", "console"}},
	}
	for _, tt := range tests {
		if got := ParseExporterTypes(tt.value); !reflect.DeepEqual(got, tt.want) {
			t.Errorf("ParseExporterTypes(%q) = %v, want %v", tt.value, got, tt.want)
		}
	}
}

func TestParsePositiveInteger(t *testing.T) {
	const fallback = 60_000
	tests := []struct {
		value string
		want  int
	}{
		{value: "30000", want: 30000},
		{value: "", want: fallback},
		{value: "abc", want: fallback},
		{value: "0", want: fallback},
		{value: "-5", want: fallback},
		// Number.parseInt leniency: trailing non-digits are ignored.
		{value: "12abc", want: 12},
		{value: "  42  ", want: 42},
		{value: "+7", want: 7},
	}
	for _, tt := range tests {
		if got := parsePositiveInteger(tt.value, fallback); got != tt.want {
			t.Errorf("parsePositiveInteger(%q) = %d, want %d", tt.value, got, tt.want)
		}
	}
}

func TestParseResourceAttributes(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  map[string]string
	}{
		{name: "empty", value: "", want: map[string]string{}},
		{name: "pairs", value: "a=b,c=d", want: map[string]string{"a": "b", "c": "d"}},
		{
			name:  "url decoded",
			value: "key%20one=hello%20world,plus=a%2Bb",
			want:  map[string]string{"key one": "hello world", "plus": "a+b"},
		},
		{name: "malformed entries skipped", value: "novalue,=empty,trailing=,a=b", want: map[string]string{"a": "b"}},
		{name: "first separator wins", value: "a=b=c", want: map[string]string{"a": "b=c"}},
		{name: "trimmed", value: " spaced = value ", want: map[string]string{"spaced": "value"}},
		// decodeURIComponent failure falls back to the raw key/value.
		{name: "invalid escape falls back", value: "a=%zz", want: map[string]string{"a": "%zz"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseResourceAttributes(tt.value); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("parseResourceAttributes(%q) = %v, want %v", tt.value, got, tt.want)
			}
		})
	}
}

func TestGetProtocol(t *testing.T) {
	protocolEnvKeys := []string{
		"OTEL_EXPORTER_OTLP_PROTOCOL",
		"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
		"OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
		"OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
	}
	tests := []struct {
		name    string
		env     map[string]string
		signal  string
		want    otlpProtocol
		wantErr bool
	}{
		{name: "default", signal: "traces", want: protocolHTTPProtobuf},
		{
			name:   "generic grpc",
			env:    map[string]string{"OTEL_EXPORTER_OTLP_PROTOCOL": "grpc"},
			signal: "logs",
			want:   protocolGRPC,
		},
		{
			name: "signal specific wins",
			env: map[string]string{
				"OTEL_EXPORTER_OTLP_PROTOCOL":        "grpc",
				"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "http/json",
			},
			signal: "traces",
			want:   protocolHTTPJSON,
		},
		{
			name: "other signals keep generic",
			env: map[string]string{
				"OTEL_EXPORTER_OTLP_PROTOCOL":        "grpc",
				"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL": "http/json",
			},
			signal: "metrics",
			want:   protocolGRPC,
		},
		{
			name:   "trimmed",
			env:    map[string]string{"OTEL_EXPORTER_OTLP_METRICS_PROTOCOL": " grpc "},
			signal: "metrics",
			want:   protocolGRPC,
		},
		{
			name:   "empty signal specific falls back to generic",
			env:    map[string]string{"OTEL_EXPORTER_OTLP_LOGS_PROTOCOL": "  ", "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json"},
			signal: "logs",
			want:   protocolHTTPJSON,
		},
		{
			name:    "unsupported",
			env:     map[string]string{"OTEL_EXPORTER_OTLP_PROTOCOL": "thrift"},
			signal:  "traces",
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, key := range protocolEnvKeys {
				t.Setenv(key, "")
			}
			for key, value := range tt.env {
				t.Setenv(key, value)
			}
			got, err := getProtocol(tt.signal)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("getProtocol(%q) should fail for unsupported protocol", tt.signal)
				}
				return
			}
			if err != nil {
				t.Fatalf("getProtocol(%q) error = %v", tt.signal, err)
			}
			if got != tt.want {
				t.Errorf("getProtocol(%q) = %q, want %q", tt.signal, got, tt.want)
			}
		})
	}
}

func TestCreateResource(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment=prod,custom%20key=value%201,broken")
	t.Setenv("OTEL_SERVICE_NAME", "yukino-override")

	attrs := map[string]string{}
	for _, kv := range createResource().Attributes() {
		attrs[string(kv.Key)] = kv.Value.AsString()
	}
	if attrs["service.name"] != "yukino-override" {
		t.Errorf("service.name = %q, want %q", attrs["service.name"], "yukino-override")
	}
	if attrs["service.version"] != version.Get() {
		t.Errorf("service.version = %q, want %q", attrs["service.version"], version.Get())
	}
	if attrs["deployment.environment"] != "prod" {
		t.Errorf("deployment.environment = %q, want %q", attrs["deployment.environment"], "prod")
	}
	if attrs["custom key"] != "value 1" {
		t.Errorf("custom key = %q, want %q", attrs["custom key"], "value 1")
	}
	if _, ok := attrs["broken"]; ok {
		t.Errorf("entry without '=' must be skipped")
	}
}

func TestCreateResourceDefaults(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "")
	t.Setenv("OTEL_SERVICE_NAME", "")

	attrs := map[string]string{}
	for _, kv := range createResource().Attributes() {
		attrs[string(kv.Key)] = kv.Value.AsString()
	}
	if attrs["service.name"] != "yukino" {
		t.Errorf("service.name = %q, want %q", attrs["service.name"], "yukino")
	}
	if attrs["service.version"] != version.Get() {
		t.Errorf("service.version = %q, want %q", attrs["service.version"], version.Get())
	}
}

func TestLangfuseEndpointURL(t *testing.T) {
	if got, want := langfuseEndpointURL(""), "https://cloud.langfuse.com/api/public/otel/v1/traces"; got != want {
		t.Errorf("langfuseEndpointURL(\"\") = %q, want %q", got, want)
	}
	if got, want := langfuseEndpointURL("https://lf.example.com/"), "https://lf.example.com/api/public/otel/v1/traces"; got != want {
		t.Errorf("langfuseEndpointURL with trailing slash = %q, want %q", got, want)
	}
	if got, want := langfuseEndpointURL("http://localhost:3000"), "http://localhost:3000/api/public/otel/v1/traces"; got != want {
		t.Errorf("langfuseEndpointURL self-hosted = %q, want %q", got, want)
	}
}

func TestLangfuseAuthHeader(t *testing.T) {
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte("pk-test:sk-test"))
	if got := langfuseAuthHeader("pk-test", "sk-test"); got != want {
		t.Errorf("langfuseAuthHeader() = %q, want %q", got, want)
	}
}

func TestLangfuseRelease(t *testing.T) {
	t.Setenv("LANGFUSE_RELEASE", "")
	if got := langfuseRelease(); got != version.Get() {
		t.Errorf("langfuseRelease() = %q, want version %q", got, version.Get())
	}
	t.Setenv("LANGFUSE_RELEASE", "r1")
	if got := langfuseRelease(); got != "r1" {
		t.Errorf("langfuseRelease() = %q, want %q", got, "r1")
	}
}

// TestCreateTracerProviderLangfuseExporter verifies the Langfuse processor
// end to end against a local httptest collector: the span batch must reach
// <base>/api/public/otel/v1/traces with the Basic auth header and protobuf
// encoding.
func TestCreateTracerProviderLangfuseExporter(t *testing.T) {
	var mu sync.Mutex
	var gotPath, gotAuth, gotContentType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	t.Setenv("OTEL_TRACES_EXPORTER", "")
	t.Setenv("LANGFUSE_PUBLIC_KEY", "pk-test")
	t.Setenv("LANGFUSE_SECRET_KEY", "sk-test")
	t.Setenv("LANGFUSE_BASE_URL", server.URL)
	t.Setenv("LANGFUSE_RELEASE", "release-9")

	ctx := context.Background()
	tracerProvider, release, err := createTracerProvider(ctx, createResource())
	if err != nil {
		t.Fatalf("createTracerProvider() error = %v", err)
	}
	if tracerProvider == nil {
		t.Fatalf("tracer provider must be created when Langfuse keys are set")
	}
	if release != "release-9" {
		t.Errorf("release = %q, want %q", release, "release-9")
	}
	defer func() { _ = tracerProvider.Shutdown(context.Background()) }()

	_, span := tracerProvider.Tracer("test").Start(ctx, "langfuse-op")
	span.End()
	if err := tracerProvider.ForceFlush(ctx); err != nil {
		t.Fatalf("ForceFlush() error = %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if gotPath != langfuseTracesPath {
		t.Errorf("export path = %q, want %q", gotPath, langfuseTracesPath)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("pk-test:sk-test"))
	if gotAuth != wantAuth {
		t.Errorf("Authorization = %q, want %q", gotAuth, wantAuth)
	}
	if gotContentType != "application/x-protobuf" {
		t.Errorf("Content-Type = %q, want %q", gotContentType, "application/x-protobuf")
	}
}

func TestCreateTracerProviderNoExporters(t *testing.T) {
	t.Setenv("OTEL_TRACES_EXPORTER", "none, ")
	t.Setenv("LANGFUSE_PUBLIC_KEY", "")
	t.Setenv("LANGFUSE_SECRET_KEY", "")

	tracerProvider, release, err := createTracerProvider(context.Background(), createResource())
	if err != nil {
		t.Fatalf("createTracerProvider() error = %v", err)
	}
	if tracerProvider != nil {
		t.Errorf("tracer provider must be nil without exporters")
	}
	if release != "" {
		t.Errorf("release = %q, want empty", release)
	}
}

func TestCreateTracerProviderUnsupportedExporter(t *testing.T) {
	t.Setenv("OTEL_TRACES_EXPORTER", "bogus")
	t.Setenv("LANGFUSE_PUBLIC_KEY", "")
	t.Setenv("LANGFUSE_SECRET_KEY", "")

	if _, _, err := createTracerProvider(context.Background(), createResource()); err == nil {
		t.Errorf("unsupported trace exporter must fail (TS throw semantics)")
	}
}

func TestCreateLoggerProviderUnsupportedExporter(t *testing.T) {
	t.Setenv("OTEL_LOGS_EXPORTER", "bogus")
	if _, err := createLoggerProvider(context.Background(), createResource()); err == nil {
		t.Errorf("unsupported log exporter must fail (TS throw semantics)")
	}
}

func TestCreateMetricReadersUnsupportedExporter(t *testing.T) {
	t.Setenv("OTEL_METRICS_EXPORTER", "bogus")
	t.Setenv("OTEL_METRIC_EXPORT_INTERVAL", "")
	if _, err := createMetricReaders(context.Background()); err == nil {
		t.Errorf("unsupported metric exporter must fail (TS throw semantics)")
	}
}

func TestCreateMetricReadersConsoleInterval(t *testing.T) {
	t.Setenv("OTEL_METRICS_EXPORTER", "console")
	t.Setenv("OTEL_METRIC_EXPORT_INTERVAL", "15000")

	readers, err := createMetricReaders(context.Background())
	if err != nil {
		t.Fatalf("createMetricReaders() error = %v", err)
	}
	if len(readers) != 1 {
		t.Fatalf("readers = %d, want 1", len(readers))
	}
	periodic, ok := readers[0].(*sdkmetric.PeriodicReader)
	if !ok {
		t.Fatalf("reader type = %T, want *sdkmetric.PeriodicReader", readers[0])
	}
	if err := periodic.Shutdown(context.Background()); err != nil {
		t.Errorf("PeriodicReader.Shutdown() error = %v", err)
	}
}

func TestErrorTypeName(t *testing.T) {
	if got := errorTypeName(errors.New("x")); got != "errorString" {
		t.Errorf("errorTypeName(errors.New) = %q, want %q", got, "errorString")
	}
	if got := errorTypeName(fmt.Errorf("wrapped: %w", errors.New("x"))); got != "wrapError" {
		t.Errorf("errorTypeName(fmt.Errorf %%w) = %q, want %q", got, "wrapError")
	}
	if got := errorTypeName(&customTestError{}); got != "customTestError" {
		t.Errorf("errorTypeName(custom) = %q, want %q", got, "customTestError")
	}
	if got := errorTypeName(nil); got != "undefined" {
		t.Errorf("errorTypeName(nil) = %q, want %q", got, "undefined")
	}
}

type customTestError struct{}

func (e *customTestError) Error() string { return "custom" }

func attributeMap(kvs []attribute.KeyValue) map[string]attribute.Value {
	m := make(map[string]attribute.Value, len(kvs))
	for _, kv := range kvs {
		m[string(kv.Key)] = kv.Value
	}
	return m
}

func TestProviderRuntimeObservations(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	tracerProvider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	rt := newProviderRuntime(tracerProvider, nil, nil, "release-1", false)
	rt.SetMode(ModeRemote)

	obs := rt.StartObservation(ObservationGeneration, "gen", Attributes{"model": "claude-test", "session": "s1"})
	child := obs.StartChild(ObservationTool, "tool", Attributes{"tool": "Bash"})
	completionStart := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	child.Update(ObservationUpdate{
		Level:               ObservationLevelWarning,
		StatusMessage:       "slow",
		Model:               "m2",
		UsageDetails:        map[string]float64{"input": 11},
		CompletionStartTime: &completionStart,
		Metadata:            map[string]any{"k": "v"},
	})
	child.RecordException(errors.New("boom"))
	child.End()
	obs.End()

	// A tool observation must not receive the generation model attribute.
	toolRoot := rt.StartObservation(ObservationTool, "tool-root", Attributes{"model": "not-a-generation"})
	toolRoot.End()

	spans := recorder.Ended()
	if len(spans) != 3 {
		t.Fatalf("ended spans = %d, want 3", len(spans))
	}
	byName := map[string]sdktrace.ReadOnlySpan{}
	for _, span := range spans {
		byName[span.Name()] = span
	}
	root, childSpan, toolSpan := byName["gen"], byName["tool"], byName["tool-root"]
	if root == nil || childSpan == nil || toolSpan == nil {
		t.Fatalf("missing spans: %v", byName)
	}

	rootAttrs := attributeMap(root.Attributes())
	for key, want := range map[string]string{
		"langfuse.observation.type":                 "generation",
		"langfuse.observation.model.name":           "claude-test",
		"langfuse.observation.metadata.model":       "claude-test",
		"langfuse.observation.metadata.session":     "s1",
		"langfuse.observation.metadata.yukino.mode": "remote",
		"langfuse.release":                          "release-1",
	} {
		got, ok := rootAttrs[key]
		if !ok || got.AsString() != want {
			t.Errorf("root span %s = %v (present=%v), want %q", key, got, ok, want)
		}
	}
	// TS sets yukino.mode only inside the observation metadata, never as a
	// bare span attribute.
	if _, ok := rootAttrs["yukino.mode"]; ok {
		t.Errorf("root span must not carry a bare yukino.mode attribute")
	}

	if childSpan.Parent().SpanID() != root.SpanContext().SpanID() {
		t.Errorf("child span must derive from the parent span context")
	}
	childAttrs := attributeMap(childSpan.Attributes())
	for key, want := range map[string]string{
		"langfuse.observation.type":                  "tool",
		"langfuse.observation.metadata.tool":         "Bash",
		"langfuse.observation.level":                 "ERROR",
		"langfuse.observation.status_message":        "errorString",
		"langfuse.observation.model.name":            "m2",
		"langfuse.observation.completion_start_time": "2026-09-20T12:00:00.000Z",
		"langfuse.observation.metadata.k":            "v",
		"error.type":                                 "errorString",
		"langfuse.release":                           "release-1",
	} {
		got, ok := childAttrs[key]
		if !ok || got.AsString() != want {
			t.Errorf("child span %s = %v (present=%v), want %q", key, got, ok, want)
		}
	}
	// TS startChild passes the caller attributes through unchanged: no
	// yukino.mode on child observations.
	if _, ok := childAttrs["langfuse.observation.metadata.yukino.mode"]; ok {
		t.Errorf("child span must not carry metadata.yukino.mode")
	}
	// The Langfuse SDK serializes usageDetails as ONE JSON-string attribute.
	if usage, ok := childAttrs["langfuse.observation.usage_details"]; !ok || usage.AsString() != `{"input":11}` {
		t.Errorf("child span usage_details = %v (present=%v), want %q", usage, ok, `{"input":11}`)
	}
	if childSpan.Status().Code != codes.Error {
		t.Errorf("child span status = %v, want Error", childSpan.Status().Code)
	}

	toolAttrs := attributeMap(toolSpan.Attributes())
	if _, ok := toolAttrs["langfuse.observation.model.name"]; ok {
		t.Errorf("non-generation observations must not set langfuse.observation.model.name at start")
	}
	if got := toolAttrs["langfuse.observation.type"].AsString(); got != "tool" {
		t.Errorf("tool-root observation.type = %q, want %q", got, "tool")
	}
}

func TestProviderRuntimeNoopChainWithoutTracer(t *testing.T) {
	rt := newProviderRuntime(nil, nil, nil, "", false)
	obs := rt.StartObservation(ObservationAgent, "root", Attributes{"k": "v"})
	if _, ok := obs.(noopObservation); !ok {
		t.Fatalf("observation = %T, want noopObservation", obs)
	}
	child := obs.StartChild(ObservationTool, "child", nil)
	child.Update(ObservationUpdate{Model: "m"})
	child.RecordException(errors.New("x"))
	child.End()
	obs.End()
	// The remaining methods are safe no-ops without providers.
	rt.EmitLog("log", LogSeverityInfo, Attributes{"k": "v"})
	rt.RecordMetric("m", MetricCounter, 1, nil)
	rt.RecordMetric("m", MetricHistogram, 1, nil)
	rt.CaptureError(errors.New("x"), "ctx")
	if err := rt.Flush(context.Background()); err != nil {
		t.Errorf("Flush() error = %v", err)
	}
	if err := rt.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown() error = %v", err)
	}
}

func TestProviderRuntimeMetrics(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	meterProvider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	rt := newProviderRuntime(nil, nil, meterProvider, "", false)
	rt.SetMode(ModePrint)

	rt.RecordMetric("yukino.tokens", MetricCounter, 2, Attributes{"token.type": "input"})
	rt.RecordMetric("yukino.tokens", MetricCounter, 3, Attributes{"token.type": "input"})
	rt.RecordMetric("yukino.latency", MetricHistogram, 12.5, nil)

	rt.instrumentMu.Lock()
	counters, histograms := len(rt.counters), len(rt.histograms)
	rt.instrumentMu.Unlock()
	if counters != 1 || histograms != 1 {
		t.Errorf("instrument cache = %d counters / %d histograms, want 1 / 1", counters, histograms)
	}

	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatalf("Collect() error = %v", err)
	}
	if len(rm.ScopeMetrics) != 1 {
		t.Fatalf("scope metrics = %d, want 1", len(rm.ScopeMetrics))
	}
	byName := map[string]metricdata.Metrics{}
	for _, m := range rm.ScopeMetrics[0].Metrics {
		byName[m.Name] = m
	}

	counter, ok := byName["yukino.tokens"]
	if !ok {
		t.Fatalf("counter metric yukino.tokens missing: %v", byName)
	}
	sum, ok := counter.Data.(metricdata.Sum[float64])
	if !ok {
		t.Fatalf("counter data = %T, want metricdata.Sum[float64]", counter.Data)
	}
	if len(sum.DataPoints) != 1 {
		t.Fatalf("counter data points = %d, want 1 (cached instrument)", len(sum.DataPoints))
	}
	if sum.DataPoints[0].Value != 5 {
		t.Errorf("counter value = %v, want 5", sum.DataPoints[0].Value)
	}
	if mode, ok := sum.DataPoints[0].Attributes.Value("yukino.mode"); !ok || mode.AsString() != "print" {
		t.Errorf("counter yukino.mode = %v (present=%v), want %q", mode, ok, "print")
	}
	if tokenType, ok := sum.DataPoints[0].Attributes.Value("token.type"); !ok || tokenType.AsString() != "input" {
		t.Errorf("counter token.type = %v (present=%v), want %q", tokenType, ok, "input")
	}

	histogram, ok := byName["yukino.latency"]
	if !ok {
		t.Fatalf("histogram metric yukino.latency missing: %v", byName)
	}
	if histogram.Unit != "ms" {
		t.Errorf("histogram unit = %q, want %q", histogram.Unit, "ms")
	}
	histData, ok := histogram.Data.(metricdata.Histogram[float64])
	if !ok {
		t.Fatalf("histogram data = %T, want metricdata.Histogram[float64]", histogram.Data)
	}
	if len(histData.DataPoints) != 1 || histData.DataPoints[0].Count != 1 || histData.DataPoints[0].Sum != 12.5 {
		t.Errorf("histogram data points = %+v, want one point with count 1 and sum 12.5", histData.DataPoints)
	}

	if err := rt.Flush(context.Background()); err != nil {
		t.Errorf("Flush() error = %v", err)
	}
	if err := rt.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown() error = %v", err)
	}
}

// capturingLogProcessor records everything emitted through a LoggerProvider.
type capturingLogProcessor struct {
	mu      sync.Mutex
	records []sdklog.Record
}

func (p *capturingLogProcessor) Enabled(context.Context, sdklog.EnabledParameters) bool { return true }

func (p *capturingLogProcessor) OnEmit(_ context.Context, record *sdklog.Record) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.records = append(p.records, record.Clone())
	return nil
}

func (p *capturingLogProcessor) Shutdown(context.Context) error   { return nil }
func (p *capturingLogProcessor) ForceFlush(context.Context) error { return nil }

func TestProviderRuntimeEmitLogAndCaptureError(t *testing.T) {
	processor := &capturingLogProcessor{}
	loggerProvider := sdklog.NewLoggerProvider(sdklog.WithProcessor(processor))
	rt := newProviderRuntime(nil, loggerProvider, nil, "", false)
	rt.SetMode(ModeTeammate)

	rt.EmitLog("yukino.event", LogSeverityWarn, Attributes{"k": "v", "n": 3})
	rt.CaptureError(errors.New("boom"), "startup")

	processor.mu.Lock()
	records := processor.records
	processor.mu.Unlock()
	if len(records) != 2 {
		t.Fatalf("emitted records = %d, want 2", len(records))
	}

	recordAttrs := func(record sdklog.Record) map[string]attribute.Value {
		m := map[string]attribute.Value{}
		record.WalkAttributes(func(kv attribute.KeyValue) bool {
			m[string(kv.Key)] = kv.Value
			return true
		})
		return m
	}

	first := records[0]
	if got := first.Body().AsString(); got != "yukino.event" {
		t.Errorf("body = %q, want %q", got, "yukino.event")
	}
	if first.Severity() != otellog.SeverityWarn {
		t.Errorf("severity = %v, want %v", first.Severity(), otellog.SeverityWarn)
	}
	if got := first.SeverityText(); got != "WARN" {
		t.Errorf("severityText = %q, want %q", got, "WARN")
	}
	firstAttrs := recordAttrs(first)
	if got := firstAttrs["k"].AsString(); got != "v" {
		t.Errorf("attribute k = %q, want %q", got, "v")
	}
	if got := firstAttrs["n"].AsInt64(); got != 3 {
		t.Errorf("attribute n = %d, want 3", got)
	}
	if got := firstAttrs["yukino.mode"].AsString(); got != "teammate" {
		t.Errorf("attribute yukino.mode = %q, want %q", got, "teammate")
	}

	second := records[1]
	if got := second.Body().AsString(); got != "yukino.error" {
		t.Errorf("captureError body = %q, want %q", got, "yukino.error")
	}
	if second.Severity() != otellog.SeverityError {
		t.Errorf("captureError severity = %v, want %v", second.Severity(), otellog.SeverityError)
	}
	if got := second.SeverityText(); got != "ERROR" {
		t.Errorf("captureError severityText = %q, want %q", got, "ERROR")
	}
	secondAttrs := recordAttrs(second)
	if got := secondAttrs["context"].AsString(); got != "startup" {
		t.Errorf("captureError context = %q, want %q", got, "startup")
	}
	if got := secondAttrs["error.type"].AsString(); got != "errorString" {
		t.Errorf("captureError error.type = %q, want %q", got, "errorString")
	}

	if err := rt.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown() error = %v", err)
	}
}

func TestCreateTelemetryRuntimeSDKDisabled(t *testing.T) {
	t.Setenv("OTEL_SDK_DISABLED", "TRUE")
	t.Setenv("OTEL_TRACES_EXPORTER", "console")
	t.Setenv("OTEL_LOGS_EXPORTER", "console")
	t.Setenv("OTEL_METRICS_EXPORTER", "console")
	t.Setenv("LANGFUSE_PUBLIC_KEY", "pk")
	t.Setenv("LANGFUSE_SECRET_KEY", "sk")

	rt, err := CreateTelemetryRuntime(context.Background())
	if err != nil {
		t.Fatalf("CreateTelemetryRuntime() error = %v", err)
	}
	provider, ok := rt.(*ProviderRuntime)
	if !ok {
		t.Fatalf("runtime = %T, want *ProviderRuntime", rt)
	}
	if provider.tracerProvider != nil || provider.loggerProvider != nil || provider.meterProvider != nil {
		t.Errorf("OTEL_SDK_DISABLED=true must skip every OTel subsystem")
	}
	if provider.langfuseRelease != "" {
		t.Errorf("langfuseRelease = %q, want empty when disabled", provider.langfuseRelease)
	}
	if _, ok := provider.StartObservation(ObservationAgent, "x", nil).(noopObservation); !ok {
		t.Errorf("observations must degrade to noop when disabled")
	}
	if err := rt.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown() error = %v", err)
	}
}

func TestCreateTelemetryRuntimeDegradesOnUnsupportedExporters(t *testing.T) {
	t.Setenv("OTEL_SDK_DISABLED", "")
	t.Setenv("OTEL_TRACES_EXPORTER", "bogus")
	t.Setenv("OTEL_LOGS_EXPORTER", "bogus")
	t.Setenv("OTEL_METRICS_EXPORTER", "bogus")
	t.Setenv("OTEL_METRIC_EXPORT_INTERVAL", "")
	t.Setenv("LANGFUSE_PUBLIC_KEY", "")
	t.Setenv("LANGFUSE_SECRET_KEY", "")

	rt, err := CreateTelemetryRuntime(context.Background())
	if err != nil {
		t.Fatalf("CreateTelemetryRuntime() error = %v", err)
	}
	provider, ok := rt.(*ProviderRuntime)
	if !ok {
		t.Fatalf("runtime = %T, want *ProviderRuntime", rt)
	}
	// TS safely(): each failing subsystem degrades to nil, not to an error.
	if provider.tracerProvider != nil || provider.loggerProvider != nil || provider.meterProvider != nil {
		t.Errorf("unsupported exporters must degrade to nil providers")
	}
	if err := rt.Shutdown(context.Background()); err != nil {
		t.Errorf("Shutdown() error = %v", err)
	}
}
