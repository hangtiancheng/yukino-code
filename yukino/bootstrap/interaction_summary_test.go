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
	"strings"
	"testing"
)

func TestFormatInteractionSummary(t *testing.T) {
	summary := InteractionSummary{
		SessionID:           "abc123",
		StartedAt:           1_000,
		AgentActiveMs:       90_000,
		ToolTimeMs:          30_000,
		SuccessfulToolCalls: 7,
		FailedToolCalls:     1,
	}
	got := FormatInteractionSummary(summary, 121_000)

	for _, want := range []string{
		" Interaction Summary",
		" Session ID:                 abc123",
		" Tool Calls:                 8 ( ✓ 7 x 1 )",
		" Success Rate:               87.5%",
		" Performance",
		" Wall Time:                  2m 0s",
		" Agent Active:               1m 30s",
		"   > API Time:               1m 0s (66.7%)",
		"   > Tool Time:              30s (33.3%)",
		" To resume this session: yukino --resume abc123",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing line %q in:\n%s", want, got)
		}
	}
}

func TestFormatInteractionSummaryZeroTools(t *testing.T) {
	got := FormatInteractionSummary(InteractionSummary{SessionID: "s1"}, 1000)
	if !strings.Contains(got, "0 ( ✓ 0 x 0 )") || !strings.Contains(got, "Success Rate:               0.0%") {
		t.Fatalf("zero-tool summary wrong:\n%s", got)
	}
}

func TestFormatDuration(t *testing.T) {
	cases := map[int64]string{
		0:       "0s",
		499:     "0s",
		500:     "1s",
		59_499:  "59s",
		60_000:  "1m 0s",
		150_500: "2m 31s",
		-5000:   "0s",
	}
	for ms, want := range cases {
		if got := formatDuration(ms); got != want {
			t.Errorf("formatDuration(%d) = %q, want %q", ms, got, want)
		}
	}
}
