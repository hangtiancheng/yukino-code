package telemetry

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseExporterTypes(t *testing.T) {
	cases := []struct {
		value string
		want  []string
	}{
		{"", nil},
		{"none", nil},
		{" none , none ", nil},
		{"console", []string{"console"}},
		{"otlp,console", []string{"otlp", "console"}},
		{" otlp , none , prometheus ", []string{"otlp", "prometheus"}},
	}
	for _, c := range cases {
		if got := ParseExporterTypes(c.value); !reflect.DeepEqual(got, c.want) {
			t.Errorf("ParseExporterTypes(%q) = %v, want %v", c.value, got, c.want)
		}
	}
}

func TestParsePositiveInteger(t *testing.T) {
	cases := []struct {
		value string
		want  int
	}{
		{"", 60000},
		{"abc", 60000},
		{"0", 60000},
		{"-5", 60000},
		{"30000", 30000},
		{" 15 ", 15},
	}
	for _, c := range cases {
		if got := parsePositiveInteger(c.value, 60000); got != c.want {
			t.Errorf("parsePositiveInteger(%q) = %d, want %d", c.value, got, c.want)
		}
	}
}

func TestGetProtocol(t *testing.T) {
	clear := func(t *testing.T) {
		for _, key := range []string{"OTEL_EXPORTER_OTLP_PROTOCOL", "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL"} {
			t.Setenv(key, "")
		}
	}
	t.Run("default is http/protobuf", func(t *testing.T) {
		clear(t)
		protocol, err := getProtocol("traces")
		if err != nil || protocol != OtlpProtocolHTTPProtobuf {
			t.Errorf("protocol = %q, err = %v", protocol, err)
		}
	})
	t.Run("generic env override", func(t *testing.T) {
		clear(t)
		t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc")
		protocol, err := getProtocol("metrics")
		if err != nil || protocol != OtlpProtocolGrpc {
			t.Errorf("protocol = %q, err = %v", protocol, err)
		}
	})
	t.Run("signal-specific wins", func(t *testing.T) {
		clear(t)
		t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc")
		t.Setenv("OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", " http/protobuf ")
		protocol, err := getProtocol("logs")
		if err != nil || protocol != OtlpProtocolHTTPProtobuf {
			t.Errorf("protocol = %q, err = %v", protocol, err)
		}
	})
	t.Run("http/json unsupported in Go", func(t *testing.T) {
		clear(t)
		t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json")
		_, err := getProtocol("traces")
		if err == nil || !strings.Contains(err.Error(), "http/json") {
			t.Errorf("err = %v, want unsupported protocol error", err)
		}
	})
	t.Run("unknown protocol", func(t *testing.T) {
		clear(t)
		t.Setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "carrier-pigeon")
		_, err := getProtocol("traces")
		if err == nil || !strings.Contains(err.Error(), "carrier-pigeon") {
			t.Errorf("err = %v, want unsupported protocol error", err)
		}
	})
}

func TestParseResourceAttributes(t *testing.T) {
	got := parseResourceAttributes("a=b,c=d")
	if len(got) != 2 || string(got[0].Key) != "a" || got[0].Value.AsString() != "b" || string(got[1].Key) != "c" {
		t.Errorf("parseResourceAttributes = %v", got)
	}
	got = parseResourceAttributes("key%20name=value%3Dx")
	if len(got) != 1 || string(got[0].Key) != "key name" || got[0].Value.AsString() != "value=x" {
		t.Errorf("decoded attributes = %v", got)
	}
	got = parseResourceAttributes("=missing-key,no-separator, k = v ")
	if len(got) != 1 || string(got[0].Key) != "k" || got[0].Value.AsString() != "v" {
		t.Errorf("filtered attributes = %v", got)
	}
	if got := parseResourceAttributes(""); len(got) != 0 {
		t.Errorf("empty value = %v", got)
	}
}

func TestCreateResource(t *testing.T) {
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "deployment.env=staging")
	t.Setenv("OTEL_SERVICE_NAME", "")
	res := createResource()
	attrs := map[string]string{}
	for _, kv := range res.Attributes() {
		attrs[string(kv.Key)] = kv.Value.AsString()
	}
	if attrs["service.name"] != ServiceName || attrs["deployment.env"] != "staging" {
		t.Errorf("resource attributes = %v", attrs)
	}
	t.Setenv("OTEL_SERVICE_NAME", "custom")
	res = createResource()
	for _, kv := range res.Attributes() {
		if string(kv.Key) == "service.name" && kv.Value.AsString() != "custom" {
			t.Errorf("service.name = %v, want custom", kv.Value.AsString())
		}
	}
}

func clearTelemetryEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"SENTRY_DSN", "OTEL_SDK_DISABLED", "OTEL_TRACES_EXPORTER", "OTEL_LOGS_EXPORTER",
		"OTEL_METRICS_EXPORTER", "OTEL_EXPORTER_OTLP_PROTOCOL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY",
	} {
		t.Setenv(key, "")
	}
}

func TestCreateTelemetryRuntimeDisabled(t *testing.T) {
	clearTelemetryEnv(t)
	t.Setenv("OTEL_SDK_DISABLED", "true")
	rt := createTelemetryRuntime()
	provider, ok := rt.(*ProviderRuntime)
	if !ok {
		t.Fatalf("runtime type = %T", rt)
	}
	if provider.tracerProvider != nil || provider.loggerProvider != nil || provider.meterProvider != nil {
		t.Error("expected all providers nil when the OTel SDK is disabled")
	}
	if provider.sentryEnabled {
		t.Error("expected sentry disabled without SENTRY_DSN")
	}
	// Without a tracer provider observations fall back to the noop shape.
	observation := provider.StartObservation(ObservationKindAgent, ObservationAgentRun, nil)
	if _, ok := observation.(noopObservation); !ok {
		t.Errorf("observation type = %T, want noop", observation)
	}
	provider.RecordMetric(MetricAgentRuns, MetricKindCounter, 1, nil)
	provider.EmitLog(LogError, SeverityError, nil)
	provider.CaptureError(errForTest("boom"), "ctx")
	provider.Flush()
	provider.Shutdown()
}

func TestCreateTelemetryRuntimeConsoleTraceExporter(t *testing.T) {
	clearTelemetryEnv(t)
	t.Setenv("OTEL_TRACES_EXPORTER", ExporterConsole)
	t.Setenv("OTEL_METRICS_EXPORTER", ExporterConsole)
	t.Setenv("OTEL_LOGS_EXPORTER", ExporterConsole)
	rt := createTelemetryRuntime()
	provider := rt.(*ProviderRuntime)
	if provider.tracerProvider == nil {
		t.Fatal("expected a tracer provider for the console exporter")
	}
	if provider.loggerProvider == nil || provider.meterProvider == nil || provider.meter == nil || provider.logger == nil {
		t.Fatal("expected logger and meter providers for the console exporters")
	}
	observation := provider.StartObservation(ObservationKindAgent, ObservationAgentRun, TelemetryAttributes{"protocol": "p"})
	if _, ok := observation.(*ProviderObservation); !ok {
		t.Fatalf("observation type = %T, want *ProviderObservation", observation)
	}
	child := observation.StartChild(ObservationKindGeneration, ObservationLlmGenerate, TelemetryAttributes{"model": "m"})
	child.Update(TelemetryObservationUpdate{Level: ObservationLevelDefault, Metadata: map[string]any{"outcome": "completed"}})
	child.End()
	observation.End()
	provider.RecordMetric(MetricAgentRuns, MetricKindCounter, 1, TelemetryAttributes{"protocol": "p"})
	provider.RecordMetric(MetricAgentDuration, MetricKindHistogram, 12.5, nil)
	provider.EmitLog(LogError, SeverityError, TelemetryAttributes{"context": "test"})
	provider.SetMode(ModeTerminal)
	provider.Flush()
	provider.Shutdown()
}

func TestCreateTracerProviderUnsupportedExporter(t *testing.T) {
	clearTelemetryEnv(t)
	t.Setenv("OTEL_TRACES_EXPORTER", "zipkin")
	_, err := createTracerProvider(t.Context(), createResource())
	if err == nil || !strings.Contains(err.Error(), "zipkin") {
		t.Errorf("err = %v, want unsupported trace exporter error", err)
	}
	t.Setenv("OTEL_TRACES_EXPORTER", "")
	provider, err := createTracerProvider(t.Context(), createResource())
	if err != nil || provider != nil {
		t.Errorf("provider = %v, err = %v; want nil provider without exporters", provider, err)
	}
}

type errForTest string

func (e errForTest) Error() string { return string(e) }
