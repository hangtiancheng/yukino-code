package teams

import (
	"strings"
	"testing"
)

func TestFormatTokensMatchesJSToFixed(t *testing.T) {
	cases := []struct {
		n    int64
		want string
	}{
		{0, "0"},
		{999, "999"},
		{1000, "1.0k"},
		{1049, "1.0k"},
		{1050, "1.1k"},
		{1234, "1.2k"},
		{1250, "1.3k"}, // exact tie 1.25: toFixed picks the larger neighbor
		{1750, "1.8k"},
		{2250, "2.3k"}, // exact tie 2.25
		{9999, "10.0k"},
		{999_999, "1000.0k"},
		{1_000_000, "1.0M"},
		{1_250_000, "1.3M"}, // exact tie 1.25
		{1_523_456, "1.5M"},
		{2_250_000, "2.3M"},
	}
	for _, tc := range cases {
		if got := FormatTokens(tc.n); got != tc.want {
			t.Errorf("FormatTokens(%d) = %q, want %q", tc.n, got, tc.want)
		}
	}
}

func TestSetLastMessageClipsByUTF16Units(t *testing.T) {
	p := NewTeammateProgress("w", "t", TeammateSpinnerVerb)
	p.SetLastMessage(strings.Repeat("a", 200))
	if p.LastMessage != strings.Repeat("a", 200) {
		t.Errorf("200-unit message must not be clipped")
	}
	p.SetLastMessage(strings.Repeat("a", 201))
	if p.LastMessage != strings.Repeat("a", 200)+"..." {
		t.Errorf("201-unit message must clip to 200 units plus ellipsis")
	}
	emoji := "\U0001F600" // two UTF-16 units
	p.SetLastMessage(strings.Repeat(emoji, 100))
	if p.LastMessage != strings.Repeat(emoji, 100) {
		t.Errorf("exactly 200 units must not be clipped")
	}
	p.SetLastMessage(strings.Repeat(emoji, 101))
	if p.LastMessage != strings.Repeat(emoji, 100)+"..." {
		t.Errorf("202 units must clip to 100 emoji plus ellipsis")
	}
	p.SetLastMessage(strings.Repeat("b", 199) + emoji)
	if p.LastMessage != strings.Repeat("b", 199)+"\uFFFD..." {
		t.Errorf("split surrogate pair must decode to U+FFFD: %q", p.LastMessage)
	}
}

func TestDescribeActivityClipsCommandsByUTF16(t *testing.T) {
	long := strings.Repeat("\U0001F600", 21) // 42 UTF-16 units
	got := describeActivity("Bash", map[string]any{"command": long})
	want := "Running " + strings.Repeat("\U0001F600", 20) + "..."
	if got != want {
		t.Errorf("describeActivity = %q, want %q", got, want)
	}
}

func TestRecordToolLifecycle(t *testing.T) {
	p := NewTeammateProgress("w", "t", TeammateSpinnerVerb)
	for i := 0; i < 7; i++ {
		p.RecordToolStart("id", "ReadFile", map[string]any{"file_path": "x"})
	}
	if len(p.ActiveTools) != 1 {
		t.Errorf("repeated starts must dedupe to one active tool: %+v", p.ActiveTools)
	}
	if len(p.RecentActivities) != MaxRecentActivities {
		t.Errorf("recent activities must cap at %d, got %d", MaxRecentActivities, len(p.RecentActivities))
	}
	if p.ToolUseCount != 7 {
		t.Errorf("ToolUseCount = %d, want 7", p.ToolUseCount)
	}
	if p.LastActivity == nil || p.LastActivity.Description != "Reading x" {
		t.Errorf("unexpected last activity: %+v", p.LastActivity)
	}
	p.RecordToolResult("id")
	if len(p.ActiveTools) != 0 {
		t.Errorf("result must clear the active tool: %+v", p.ActiveTools)
	}
	p.RecordTurnComplete()
	if p.TurnCount != 1 || len(p.ActiveTools) != 0 {
		t.Errorf("turn complete must bump TurnCount and clear tools: %+v", p)
	}
	p.ClearActivity()
	if p.LastActivity != nil || len(p.RecentActivities) != 0 {
		t.Error("ClearActivity must reset the activity trace")
	}
}
