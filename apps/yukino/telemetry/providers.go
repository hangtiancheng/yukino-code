package telemetry

import "strings"

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

// CreateTelemetryRuntime constructs an independent provider runtime.
// The caller owns its shutdown.
func CreateTelemetryRuntime() TelemetryRuntime {
	return CreateProviderRuntime()
}
