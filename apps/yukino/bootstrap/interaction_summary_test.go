package bootstrap

import "testing"

// Expected outputs captured from the reference implementation executed in Node
// (src/bootstrap/interaction-summary.ts formatInteractionSummary).
func TestFormatInteractionSummaryMatchesReference(t *testing.T) {
	summary := InteractionSummary{
		AgentActiveMs:       125000,
		CacheCreationTokens: 1234,
		CacheReadTokens:     45678,
		FailedToolCalls:     2,
		InputTokens:         999,
		LatestVersion:       "9.9.9",
		OutputTokens:        1523456,
		SessionID:           "abc-123",
		StartedAt:           1000,
		SuccessfulToolCalls: 18,
		ToolTimeMs:          61500,
	}
	want := "### Session `abc-123`\n**Tools** 20 calls · ✓ 18 · ✗ 2 · 90.0% success  \n**Time** 3m 5s wall · 2m 5s active  \n**Breakdown** API 1m 4s (50.8%) · Tools 1m 2s (49.2%)  \n**Tokens** ↑ 999 input · ↓ 1.5M output  \n**Cache** 46k read · 1.2k write  \n**Cache hit** 95.3% (46k of 48k prompt)  \n`yukino --resume abc-123`"
	if got := FormatInteractionSummary(summary, 1000+185000); got != want {
		t.Fatalf("mismatch:\ngot  %q\nwant %q", got, want)
	}

	second := summary
	second.SuccessfulToolCalls = 0
	second.FailedToolCalls = 0
	second.CacheReadTokens = 0
	second.InputTokens = 12345
	second.AgentActiveMs = 3000
	second.ToolTimeMs = 0
	want2 := "### Session `abc-123`\n**Tools** 0 calls · ✓ 0 · ✗ 0 · 0.0% success  \n**Time** 5s wall · 3s active  \n**Breakdown** API 3s (100.0%) · Tools 0s (0.0%)  \n**Tokens** ↑ 12k input · ↓ 1.5M output  \n**Cache** 0 read · 1.2k write  \n**Cache hit** 0.0% (0 of 14k prompt)  \n`yukino --resume abc-123`"
	if got := FormatInteractionSummary(second, 1000+5000); got != want2 {
		t.Fatalf("mismatch:\ngot  %q\nwant %q", got, want2)
	}
}

func TestFormatDuration(t *testing.T) {
	cases := []struct {
		ms   float64
		want string
	}{
		{-5000, "0s"},
		{0, "0s"},
		{499, "0s"},
		{500, "1s"},
		{59_499, "59s"},
		{59_500, "1m 0s"},
		{61_500, "1m 2s"},
		{3_600_000, "60m 0s"},
	}
	for _, tc := range cases {
		if got := formatDuration(tc.ms); got != tc.want {
			t.Errorf("formatDuration(%v) = %q, want %q", tc.ms, got, tc.want)
		}
	}
}

func TestFormatTokens(t *testing.T) {
	cases := []struct {
		value float64
		want  string
	}{
		{-5, "0"},
		{0, "0"},
		{999, "999"},
		{1000, "1.0k"},
		{1234, "1.2k"},
		{9999, "10.0k"},
		{10_000, "10k"},
		{45_678, "46k"},
		{999_999, "1000k"},
		{1_000_000, "1.0M"},
		{1_523_456, "1.5M"},
	}
	for _, tc := range cases {
		if got := formatTokens(tc.value); got != tc.want {
			t.Errorf("formatTokens(%v) = %q, want %q", tc.value, got, tc.want)
		}
	}
}

func TestPercentage(t *testing.T) {
	if got := percentage(1, 3); got != "33.3%" {
		t.Errorf("percentage(1,3) = %q", got)
	}
	if got := percentage(1, 0); got != "0.0%" {
		t.Errorf("percentage(1,0) = %q", got)
	}
	if got := percentage(0.5, 1); got != "50.0%" {
		t.Errorf("percentage(0.5,1) = %q", got)
	}
}
