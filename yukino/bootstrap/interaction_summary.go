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

package bootstrap

import (
	"fmt"
	"strings"
	"time"
)

// InteractionSummary aggregates one agent session's activity for the
// end-of-run report.
type InteractionSummary struct {
	AgentActiveMs       int64
	FailedToolCalls     int
	SessionID           string
	StartedAt           int64 // Unix milliseconds
	SuccessfulToolCalls int
	ToolTimeMs          int64
}

func formatDuration(milliseconds int64) string {
	seconds := (milliseconds + 500) / 1000
	if seconds < 0 {
		seconds = 0
	}
	if seconds < 60 {
		return fmt.Sprintf("%ds", seconds)
	}
	return fmt.Sprintf("%dm %ds", seconds/60, seconds%60)
}

func percentage(value, total int64) string {
	pct := 0.0
	if total > 0 {
		pct = float64(value) / float64(total) * 100
	}
	return fmt.Sprintf("%.1f%%", pct)
}

func field(label, value string) string {
	padded := label + ":"
	for len(padded) < 28 {
		padded += " "
	}
	return " " + padded + value
}

// FormatInteractionSummary renders the end-of-session report. endedAt is Unix
// milliseconds; zero means "now".
func FormatInteractionSummary(summary InteractionSummary, endedAt int64) string {
	if endedAt == 0 {
		endedAt = time.Now().UnixMilli()
	}
	totalToolCalls := summary.SuccessfulToolCalls + summary.FailedToolCalls
	apiTimeMs := summary.AgentActiveMs - summary.ToolTimeMs
	if apiTimeMs < 0 {
		apiTimeMs = 0
	}
	successRate := 0.0
	if totalToolCalls > 0 {
		successRate = float64(summary.SuccessfulToolCalls) / float64(totalToolCalls) * 100
	}

	lines := []string{
		" Interaction Summary",
		field("Session ID", summary.SessionID),
		field("Tool Calls", fmt.Sprintf("%d ( ✓ %d x %d )",
			totalToolCalls, summary.SuccessfulToolCalls, summary.FailedToolCalls)),
		field("Success Rate", fmt.Sprintf("%.1f%%", successRate)),
		"",
		" Performance",
		field("Wall Time", formatDuration(endedAt-summary.StartedAt)),
		field("Agent Active", formatDuration(summary.AgentActiveMs)),
		field("  > API Time", fmt.Sprintf("%s (%s)",
			formatDuration(apiTimeMs), percentage(apiTimeMs, summary.AgentActiveMs))),
		field("  > Tool Time", fmt.Sprintf("%s (%s)",
			formatDuration(summary.ToolTimeMs), percentage(summary.ToolTimeMs, summary.AgentActiveMs))),
		"",
		fmt.Sprintf(" To resume this session: yukino --resume %s", summary.SessionID),
	}
	return strings.Join(lines, "\n")
}
