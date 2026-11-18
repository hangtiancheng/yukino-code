package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

type realisticMCPTool struct {
	name   string
	desc   string
	params map[string]any
}

func (t *realisticMCPTool) Name() string           { return t.name }
func (t *realisticMCPTool) Description() string    { return t.desc }
func (t *realisticMCPTool) Category() ToolCategory { return CategoryCommand }
func (t *realisticMCPTool) ShouldDefer() bool      { return true }
func (t *realisticMCPTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.name,
		"description": t.desc,
		"input_schema": map[string]any{
			"type":       "object",
			"required":   []string{"query", "datasource"},
			"properties": t.params,
		},
	}
}
func (t *realisticMCPTool) Execute(_ context.Context, _ map[string]any) ToolResult {
	return ToolResult{Output: "ok"}
}

func makeRealisticTools(n int) []*realisticMCPTool {
	templates := []struct {
		namePrefix string
		desc       string
		params     map[string]any
	}{
		{
			namePrefix: "mcp__grafana__query_prometheus",
			desc:       "Execute a PromQL query against the specified Prometheus datasource and return time-series or instant results. Supports range queries with configurable step and time window.",
			params: map[string]any{
				"expr":        map[string]any{"type": "string", "description": "PromQL query expression to evaluate against the datasource"},
				"datasource":  map[string]any{"type": "string", "description": "Name or UID of the Prometheus datasource to query"},
				"start":       map[string]any{"type": "string", "description": "Start of the time range in RFC3339 format or relative (e.g. 'now-1h')"},
				"end":         map[string]any{"type": "string", "description": "End of the time range in RFC3339 format or relative (e.g. 'now')"},
				"step":        map[string]any{"type": "string", "description": "Query resolution step width in Prometheus duration format (e.g. '15s', '1m')"},
				"format":      map[string]any{"type": "string", "description": "Output format for results", "enum": []string{"table", "timeseries", "json"}},
				"max_results": map[string]any{"type": "integer", "description": "Maximum number of time series to return", "default": 100},
				"legend":      map[string]any{"type": "string", "description": "Legend format template for result series names"},
			},
		},
		{
			namePrefix: "mcp__grafana__search_dashboards",
			desc:       "Search for Grafana dashboards by title, tag, or folder. Returns matching dashboards with metadata including UID, title, URL, folder, and tags.",
			params: map[string]any{
				"query":   map[string]any{"type": "string", "description": "Search query string to match against dashboard titles"},
				"tag":     map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Filter dashboards by tags (AND logic)"},
				"folder":  map[string]any{"type": "string", "description": "Folder title or UID to restrict search scope"},
				"starred": map[string]any{"type": "boolean", "description": "If true, only return starred dashboards"},
				"limit":   map[string]any{"type": "integer", "description": "Maximum number of dashboards to return", "default": 50},
				"sort":    map[string]any{"type": "string", "description": "Sort order for results", "enum": []string{"alpha-asc", "alpha-desc", "created-asc", "created-desc"}},
			},
		},
		{
			namePrefix: "mcp__playwright__browser_click",
			desc:       "Click an element on the page identified by a CSS selector or accessible role. Supports options for button type, click count, position offset, force click, and timeout.",
			params: map[string]any{
				"selector":   map[string]any{"type": "string", "description": "CSS selector, XPath, or text selector to identify the target element"},
				"button":     map[string]any{"type": "string", "description": "Mouse button to click", "enum": []string{"left", "right", "middle"}, "default": "left"},
				"clickCount": map[string]any{"type": "integer", "description": "Number of clicks (1 for single, 2 for double)", "default": 1},
				"force":      map[string]any{"type": "boolean", "description": "Whether to bypass actionability checks and force the click"},
				"timeout":    map[string]any{"type": "integer", "description": "Maximum time in milliseconds to wait for the element", "default": 30000},
				"position":   map[string]any{"type": "object", "description": "Offset position relative to element's top-left corner", "properties": map[string]any{"x": map[string]any{"type": "number"}, "y": map[string]any{"type": "number"}}},
				"modifiers":  map[string]any{"type": "array", "items": map[string]any{"type": "string", "enum": []string{"Alt", "Control", "Meta", "Shift"}}, "description": "Keyboard modifiers to press during click"},
			},
		},
		{
			namePrefix: "mcp__grafana__query_loki",
			desc:       "Run a LogQL query against a Loki datasource and return matching log lines or metric results. Supports log queries, metric queries, and pattern-based aggregation.",
			params: map[string]any{
				"query":      map[string]any{"type": "string", "description": "LogQL query expression to execute"},
				"datasource": map[string]any{"type": "string", "description": "Name or UID of the Loki datasource"},
				"start":      map[string]any{"type": "string", "description": "Start timestamp in RFC3339 or relative format"},
				"end":        map[string]any{"type": "string", "description": "End timestamp in RFC3339 or relative format"},
				"limit":      map[string]any{"type": "integer", "description": "Maximum number of log entries to return", "default": 1000},
				"direction":  map[string]any{"type": "string", "description": "Log ordering direction", "enum": []string{"forward", "backward"}},
				"step":       map[string]any{"type": "string", "description": "Step interval for metric queries"},
				"dedup":      map[string]any{"type": "boolean", "description": "Whether to deduplicate log lines with same content"},
			},
		},
		{
			namePrefix: "mcp__playwright__browser_fill",
			desc:       "Fill an input field with text. Clears existing content before typing. Works with input, textarea, and contenteditable elements. Dispatches input and change events.",
			params: map[string]any{
				"selector":    map[string]any{"type": "string", "description": "CSS selector or text selector for the input element to fill"},
				"value":       map[string]any{"type": "string", "description": "Text value to fill into the input field"},
				"force":       map[string]any{"type": "boolean", "description": "Whether to bypass actionability checks"},
				"timeout":     map[string]any{"type": "integer", "description": "Maximum time in milliseconds to wait for element", "default": 30000},
				"noWaitAfter": map[string]any{"type": "boolean", "description": "If true, do not wait for navigation events after filling"},
			},
		},
		{
			namePrefix: "mcp__grafana__create_annotation",
			desc:       "Create an annotation on a Grafana dashboard panel or at the global level. Annotations mark important events on time-series graphs with optional tags and rich text descriptions.",
			params: map[string]any{
				"dashboardUID": map[string]any{"type": "string", "description": "UID of the dashboard to annotate (omit for global annotation)"},
				"panelId":      map[string]any{"type": "integer", "description": "Panel ID within the dashboard to annotate"},
				"time":         map[string]any{"type": "integer", "description": "Unix timestamp in milliseconds for annotation start"},
				"timeEnd":      map[string]any{"type": "integer", "description": "Unix timestamp in milliseconds for annotation end (for range annotations)"},
				"text":         map[string]any{"type": "string", "description": "Annotation description text, supports basic HTML formatting"},
				"tags":         map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Tags to associate with the annotation for filtering"},
			},
		},
	}

	tools := make([]*realisticMCPTool, n)
	for i := 0; i < n; i++ {
		tmpl := templates[i%len(templates)]
		tools[i] = &realisticMCPTool{
			name:   fmt.Sprintf("%s_%03d", tmpl.namePrefix, i),
			desc:   tmpl.desc,
			params: tmpl.params,
		}
	}
	return tools
}

func builtinToolSchemaSize() int {
	reg := CreateDefaultRegistry()
	schemas := reg.GetAllSchemas("anthropic")
	data, _ := json.Marshal(schemas)
	return len(data)
}

func TestDeferredBenchmarkFullSession(t *testing.T) {
	const (
		numMCPTools = 58
		numTurns    = 10
	)

	builtinBytes := builtinToolSchemaSize()
	builtinCount := len(CreateDefaultRegistry().ListTools())
	regFull := NewRegistry()
	for _, tool := range CreateDefaultTools().Registry.ListTools() {
		regFull.Register(tool)
	}
	mcpTools := makeRealisticTools(numMCPTools)
	for _, mt := range mcpTools {
		regFull.Register(&nonDeferredWrapper{realisticMCPTool: mt})
	}

	regDeferred := NewRegistry()
	for _, tool := range CreateDefaultTools().Registry.ListTools() {
		regDeferred.Register(tool)
	}
	toolSearch := &ToolSearchTool{Registry: regDeferred}
	regDeferred.Register(toolSearch)
	for _, mt := range mcpTools {
		regDeferred.Register(mt)
	}

	var totalBytesFull int
	var totalBytesDeferred int

	activateAtTurn := map[int]string{
		3: mcpTools[5].Name(),
		6: mcpTools[20].Name(),
	}

	t.Logf("=== session simulation: %d builtin tools + %d MCP tools, %d turns ===\n", builtinCount, numMCPTools, numTurns)
	t.Logf("%-6s %12s %12s %12s   %s", "Turn", "Full(bytes)", "Deferred(bytes)", "Deferred-detail", "Event")

	for turn := 1; turn <= numTurns; turn++ {
		event := ""

		if toolName, ok := activateAtTurn[turn]; ok {
			regDeferred.MarkDiscovered(toolName)
			event = fmt.Sprintf("activated %s", toolName)
		}

		schemasFull := regFull.GetAllSchemas("anthropic")
		dataFull, _ := json.Marshal(schemasFull)
		turnBytesFull := len(dataFull)

		schemasDeferred := regDeferred.GetAllSchemas("anthropic")
		dataDeferred, _ := json.Marshal(schemasDeferred)
		turnToolsBytes := len(dataDeferred)

		deferredNames := regDeferred.GetDeferredToolNames()
		reminderText := ""
		if len(deferredNames) > 0 {
			reminderText = "The following deferred tools are available via ToolSearch. Their schemas are NOT loaded - use ToolSearch with query \"select:<name>[,<name>...]\" to load tool schemas before calling them:\n" + strings.Join(deferredNames, "\n")
		}
		turnReminderBytes := len(reminderText)
		turnBytesDeferred := turnToolsBytes + turnReminderBytes

		totalBytesFull += turnBytesFull
		totalBytesDeferred += turnBytesDeferred

		t.Logf("%-6d %12d %12d   (tools=%d + reminder=%d)   %s",
			turn, turnBytesFull, turnBytesDeferred, turnToolsBytes, turnReminderBytes, event)
	}

	savings := 1 - float64(totalBytesDeferred)/float64(totalBytesFull)
	estimatedTokensFull := totalBytesFull / 4
	estimatedTokensDeferred := totalBytesDeferred / 4
	tokensSaved := estimatedTokensFull - estimatedTokensDeferred

	t.Logf("")
	t.Logf("=== whole-session stats ===")
	t.Logf("eager total:   %d bytes (%d estimated tokens)", totalBytesFull, estimatedTokensFull)
	t.Logf("deferred total: %d bytes (%d estimated tokens)", totalBytesDeferred, estimatedTokensDeferred)
	t.Logf("savings:        %.1f%% (%d estimated tokens saved)", savings*100, tokensSaved)
	t.Logf("")

	schemasFull1 := regFull.GetAllSchemas("anthropic")
	dataFull1, _ := json.Marshal(schemasFull1)
	t.Logf("=== single-turn snapshot (final state, 2 MCP tools activated) ===")
	t.Logf("eager tools param:   %d bytes (%d tools)", len(dataFull1), len(schemasFull1))

	schemasD1 := regDeferred.GetAllSchemas("anthropic")
	dataD1, _ := json.Marshal(schemasD1)
	dNames := regDeferred.GetDeferredToolNames()
	reminder := strings.Join(dNames, "\n")
	t.Logf("deferred tools param: %d bytes (%d tools) + reminder %d bytes (%d names)",
		len(dataD1), len(schemasD1), len(reminder), len(dNames))

	mcpSavings := 1 - float64(totalBytesDeferred-builtinBytes*numTurns)/float64(totalBytesFull-builtinBytes*numTurns)
	if mcpSavings < 0.80 {
		t.Errorf("MCP schema savings should be >= 80%%, got %.1f%%", mcpSavings*100)
	}
}

type nonDeferredWrapper struct {
	*realisticMCPTool
}

func (w *nonDeferredWrapper) ShouldDefer() bool { return false }
