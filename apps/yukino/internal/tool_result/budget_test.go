package tool_result

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
)

const testSession = "test-session"

func setupHome(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
}

func batchOf(sizes map[string]int) []conversation.ToolResultBlock {
	var rs []conversation.ToolResultBlock
	for _, id := range []string{"t1", "t2", "t3", "t4", "t5"} {
		if n, ok := sizes[id]; ok {
			rs = append(rs, conversation.ToolResultBlock{
				ToolUseID: id,
				Content:   strings.Repeat(string(id[1]), n),
			})
		}
	}
	return rs
}

func totalLen(rs []conversation.ToolResultBlock) int {
	total := 0
	for _, r := range rs {
		total += len(r.Content)
	}
	return total
}

func spillDirFor(t *testing.T) string {
	t.Helper()
	dir, err := SpillDir(testSession)
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestApplyBudgetUnderLimitUntouched(t *testing.T) {
	setupHome(t)
	rs := batchOf(map[string]int{"t1": 40000, "t2": 40000})
	before := rs[0].Content

	ApplyBudget(rs, testSession, nil)

	if rs[0].Content != before {
		t.Fatal("under-limit batch must not be modified")
	}
}

func TestApplyBudgetSpillsLargestFirst(t *testing.T) {
	setupHome(t)
	rs := batchOf(map[string]int{"t1": 45000, "t2": 45000, "t3": 45001, "t4": 45000, "t5": 45000})

	ApplyBudget(rs, testSession, nil)

	if got := totalLen(rs); got > MessageAggregateLimit {
		t.Fatalf("aggregate %d still over limit %d", got, MessageAggregateLimit)
	}
	var t3 string
	replaced := 0
	for _, r := range rs {
		if strings.HasPrefix(r.Content, "<persisted-output>") {
			replaced++
		}
		if r.ToolUseID == "t3" {
			t3 = r.Content
		}
	}
	if replaced != 1 {
		t.Fatalf("expected exactly 1 replacement, got %d", replaced)
	}
	if !strings.HasPrefix(t3, "<persisted-output>") {
		t.Fatal("largest result t3 should have been spilled")
	}
	data := filepath.Join(spillDirFor(t), "t3.txt")
	if fi := mustStat(t, data); fi != 45001 {
		t.Fatalf("spill file size = %d, want 45001", fi)
	}
}

func TestApplyBudgetExemptSkipped(t *testing.T) {
	setupHome(t)
	rs := batchOf(map[string]int{"t1": 45000, "t2": 45000, "t3": 45001, "t4": 45000, "t5": 45000})
	exempt := map[string]bool{"t3": true}

	ApplyBudget(rs, testSession, exempt)

	for _, r := range rs {
		if r.ToolUseID == "t3" && strings.HasPrefix(r.Content, "<persisted-output>") {
			t.Fatal("exempt t3 must not be spilled")
		}
	}
	if got := totalLen(rs); got > MessageAggregateLimit {
		t.Fatalf("aggregate %d still over limit", got)
	}
}

func TestApplyBudgetAllExemptAcceptsOverage(t *testing.T) {
	setupHome(t)
	rs := batchOf(map[string]int{"t1": 105000, "t2": 105000})
	exempt := map[string]bool{"t1": true, "t2": true}
	before1, before2 := rs[0].Content, rs[1].Content

	ApplyBudget(rs, testSession, exempt)

	if rs[0].Content != before1 || rs[1].Content != before2 {
		t.Fatal("all-exempt batch must be left as-is (accepted overage)")
	}
}

func TestApplyBudgetDeterministic(t *testing.T) {
	setupHome(t)
	rs1 := batchOf(map[string]int{"t1": 45000, "t2": 45000, "t3": 45001, "t4": 45000, "t5": 45000})
	rs2 := batchOf(map[string]int{"t1": 45000, "t2": 45000, "t3": 45001, "t4": 45000, "t5": 45000})

	ApplyBudget(rs1, testSession, nil)
	ApplyBudget(rs2, testSession, nil)

	for i := range rs1 {
		if rs1[i].Content != rs2[i].Content {
			t.Fatalf("non-deterministic output for %s", rs1[i].ToolUseID)
		}
	}
}

func TestApplyBudgetIdempotent(t *testing.T) {
	setupHome(t)
	rs := batchOf(map[string]int{"t1": 45000, "t2": 45000, "t3": 45001, "t4": 45000, "t5": 45000})
	ApplyBudget(rs, testSession, nil)

	snapshot := make([]string, len(rs))
	for i, r := range rs {
		snapshot[i] = r.Content
	}

	ApplyBudget(rs, testSession, nil)
	for i, r := range rs {
		if r.Content != snapshot[i] {
			t.Fatalf("second pass modified %s", r.ToolUseID)
		}
	}
}

func TestIsSpillReadback(t *testing.T) {
	setupHome(t)
	wd := t.TempDir()
	inside := filepath.Join(spillDirFor(t), "toolu_abc.txt")
	outside := filepath.Join(wd, "main.go")

	if !IsSpillReadback("ReadFile", map[string]any{"file_path": inside}, wd, testSession) {
		t.Fatal("ReadFile of spill file should be a readback")
	}
	if IsSpillReadback("ReadFile", map[string]any{"file_path": outside}, wd, testSession) {
		t.Fatal("ReadFile outside spill dir is not a readback")
	}
	if IsSpillReadback("Bash", map[string]any{"file_path": inside}, wd, testSession) {
		t.Fatal("non-ReadFile tool is never a readback")
	}
	if IsSpillReadback("ReadFile", map[string]any{}, wd, testSession) {
		t.Fatal("missing file_path is not a readback")
	}
	if IsSpillReadback("ReadFile", map[string]any{"file_path": inside}, wd, "") {
		t.Fatal("missing session id is not a readback")
	}
}

func TestPersistLargeResultRoundTrip(t *testing.T) {
	setupHome(t)
	content := strings.Repeat("x", 60000)

	preview := PersistLargeResult(testSession, "t_big", content)

	if !strings.HasPrefix(preview, "<persisted-output>") {
		t.Fatalf("preview missing tag: %q", preview[:40])
	}
	if !strings.Contains(preview, "Preview (first 2000 characters)") {
		t.Fatal("preview missing preview section")
	}
	if fi := mustStat(t, filepath.Join(spillDirFor(t), "t_big.txt")); fi != 60000 {
		t.Fatalf("spill file size = %d, want 60000", fi)
	}
	if again := PersistLargeResult(testSession, "t_big", content); again != preview {
		t.Fatal("second persist must reproduce identical preview")
	}
}

func TestSpillEncodesToolUseIDs(t *testing.T) {
	setupHome(t)
	source := filepath.Join(t.TempDir(), "source.txt")
	if err := os.WriteFile(source, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A hostile provider call ID shaped like a relative path must not escape
	// the spill directory.
	id := "../" + strings.TrimSuffix(filepath.Base(source), ".txt")
	preview := PersistLargeResult(testSession, id, "large result")
	if !strings.Contains(preview, "<persisted-output>") {
		t.Fatalf("preview = %q", preview)
	}
	data, err := os.ReadFile(source)
	if err != nil || string(data) != "original" {
		t.Fatalf("source file modified: %q, %v", data, err)
	}
	saved := filepath.Join(spillDirFor(t), encodeToolUseID(id)+SpillFileExtension)
	content, err := os.ReadFile(saved)
	if err != nil || string(content) != "large result" {
		t.Fatalf("saved spill = %q, %v", content, err)
	}
}

func TestSpillRequiresSessionID(t *testing.T) {
	if _, err := SpillDir(""); err == nil {
		t.Fatal("empty session id must fail")
	}
	content := strings.Repeat("x", 60000)
	if got := PersistLargeResult("", "t1", content); got != content {
		t.Fatal("persist without session id must return the content unchanged")
	}
}

func mustStat(t *testing.T, path string) int64 {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return fi.Size()
}
