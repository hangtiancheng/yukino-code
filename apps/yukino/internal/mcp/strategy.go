package mcp

import (
	"encoding/json"
	"net/url"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func IsOfficialAnthropicEndpoint(baseURL string) bool {
	if baseURL == "" {
		return true
	}
	u, err := url.Parse(baseURL)
	if err != nil {
		return false
	}
	return OfficialHosts[strings.ToLower(u.Hostname())]
}

func EstimateSchemaTokens(schemaChars int) int {
	return int(float64(schemaChars) / CharsPerToken)
}

func DecideMode(baseURL, protocol string, contextWindow, mcpSchemaChars int, loading string, thresholdPercent int) tools.McpLoadingMode {
	if loading != "" && loading != "auto" {
		if loading == "native" && protocol != "anthropic" {
			return tools.McpLoadingDispatch
		}
		return tools.McpLoadingMode(loading)
	}
	if mcpSchemaChars <= 0 {
		return tools.McpLoadingEager
	}
	budget := float64(contextWindow) * float64(thresholdPercent) / 100
	if float64(EstimateSchemaTokens(mcpSchemaChars)) < budget {
		return tools.McpLoadingEager
	}
	if protocol == "anthropic" && IsOfficialAnthropicEndpoint(baseURL) {
		return tools.McpLoadingNative
	}
	return tools.McpLoadingDispatch
}

func MeasureSchemaChars(registry *tools.Registry) int {
	total := 0
	for _, t := range registry.ListTools() {
		if !strings.HasPrefix(t.Name(), tools.MCPToolPrefix) {
			continue
		}
		if b, err := json.Marshal(t.Schema()); err == nil {
			total += len(b)
		} else {
			total += len(t.Name()) + len(t.Description())
		}
	}
	return total
}

func ApplyMode(registry *tools.Registry, mode tools.McpLoadingMode) {
	registry.McpLoadingMode = mode
	eager := mode == tools.McpLoadingEager
	for _, t := range registry.ListTools() {
		if mt, ok := t.(tools.MCPTool); ok {
			mt.SetDeferLoading(!eager)
		}
	}

	registry.ExposeToolSearch = !eager
	registry.ExposeMcpCall = mode == tools.McpLoadingDispatch
}

func DecideAndApply(registry *tools.Registry, baseURL, protocol string, contextWindow int, loading string) tools.McpLoadingMode {
	mode := DecideMode(baseURL, protocol, contextWindow, MeasureSchemaChars(registry), loading, DefaultEagerThresholdPercent)
	ApplyMode(registry, mode)
	return mode
}
