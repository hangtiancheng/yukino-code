package ui

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/bootstrap"
)

func TestInteractionSummaryReference(t *testing.T) {
	data, err := os.ReadFile("testdata/summary-expected.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		Summary bootstrap.InteractionSummary
		Cases   []struct {
			Columns  int
			Expected string
		}
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, c := range fixtures.Cases {
		if got := RenderInteractionSummary(fixtures.Summary, c.Columns, false, time.UnixMilli(16000)); got != c.Expected {
			t.Errorf("width %d got %q, want %q", c.Columns, got, c.Expected)
		}
	}
}

func TestInteractionStatsMeasureConcurrentToolsOnce(t *testing.T) {
	m := newChatModel(t)
	m.beginInteractionRun()
	m.recordInteractionEvent(agent.ToolUseEvent{ToolID: "one"})
	m.recordInteractionEvent(agent.ToolUseEvent{ToolID: "two"})
	m.toolBatchStartedAt = time.Now().Add(-time.Second)
	m.recordInteractionEvent(agent.ToolResultEvent{ToolID: "one"})
	if m.interactionStats.ToolTimeMs != 0 {
		t.Fatal("concurrent batch ended early")
	}
	m.recordInteractionEvent(agent.ToolResultEvent{ToolID: "two", IsError: true})
	m.endInteractionRun()
	summary := m.InteractionSummary()
	if summary.SuccessfulToolCalls != 1 || summary.FailedToolCalls != 1 || summary.ToolTimeMs < 1000 || summary.ToolTimeMs > 1500 {
		t.Fatalf("stats %+v", summary)
	}
	next, _ := m.executeCommand("/clear", nil)
	m = asModel(t, next)
	if summary := m.InteractionSummary(); summary.SuccessfulToolCalls != 0 || summary.ToolTimeMs != 0 {
		t.Fatalf("clear retained stats %+v", summary)
	}
	for _, mode := range []ThemeMode{ThemeModeLight, ThemeModeDark} {
		SetThemeMode(mode)
		output := RenderInteractionSummary(m.InteractionSummary(), 80, true, time.Now())
		if !strings.Contains(output, "Session") || !strings.Contains(output, "yukino --resume") {
			t.Fatal("summary content lost")
		}
	}
}
