package history

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

func setupHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

func testInput(t *testing.T, index int, commandName *string) []byte {
	entry := InputEntry{
		Type:        "input",
		ID:          uuid.NewString(),
		Text:        fmt.Sprintf("prompt-%d", index),
		Timestamp:   int64(index),
		Cwd:         canonicalCwd(t),
		SessionID:   strPtr("session"),
		Source:      "cli",
		CommandName: commandName,
	}
	data, err := json.Marshal(entry)
	if err != nil {
		panic(err)
	}
	return data
}

func strPtr(s string) *string { return &s }

func canonicalCwd(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(wd)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

func appendActivity(t *testing.T, lines ...string) {
	t.Helper()
	path := storage.YukinoPath(ActivityFileName)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, line := range lines {
		if _, err := f.WriteString(line); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRetainsDuplicateInputsDedupesConsecutiveTexts(t *testing.T) {
	setupHome(t)
	wd := canonicalCwd(t)
	first, err := RecordInput(InputOptions{Text: "continue", Cwd: wd, SessionID: strPtr("one"), Source: "cli"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := RecordInput(InputOptions{Text: "continue", Cwd: wd, SessionID: strPtr("two"), Source: "ws"})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == second.ID {
		t.Fatal("entries must have distinct ids")
	}
	inputs := mustHistory(LoadInputs())
	if len(inputs) != 2 || *inputs[0].SessionID != "one" || *inputs[1].SessionID != "two" {
		t.Fatalf("inputs = %+v", inputs)
	}
	if texts := mustHistory(LoadInputTexts()); len(texts) != 1 || texts[0] != "continue" {
		t.Fatalf("texts = %v, want [continue]", texts)
	}
	projects := mustHistory(ListProjects())
	if len(projects) != 1 {
		t.Fatalf("projects = %+v, want 1", projects)
	}
	key, err := storage.ProjectKey(wd)
	if err != nil {
		t.Fatal(err)
	}
	if projects[0].ProjectKey != key || projects[0].Cwd != wd {
		t.Fatalf("project = %+v, want key %s cwd %s", projects[0], key, wd)
	}
}

func TestBoundsRecallKeepsUsageAndProjects(t *testing.T) {
	setupHome(t)
	wd := canonicalCwd(t)
	if err := RegisterProject(wd); err != nil {
		t.Fatal(err)
	}
	project := mustHistory(ListProjects())[0]
	help := "help"
	var lines []string
	for i := 0; i < MaxHistoryEntries+2; i++ {
		lines = append(lines, string(testInput(t, i, &help))+"\n")
	}
	appendActivity(t, lines...)

	inputs := mustHistory(LoadInputs())
	if len(inputs) != MaxHistoryEntries {
		t.Fatalf("inputs = %d, want %d", len(inputs), MaxHistoryEntries)
	}
	if inputs[0].Text != "prompt-2" {
		t.Fatalf("first input = %s, want prompt-2", inputs[0].Text)
	}
	if err := CompactActivity(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(storage.YukinoPath(ActivityFileName))
	if err != nil {
		t.Fatal(err)
	}
	trimmed := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(trimmed) != 1 {
		t.Fatalf("checkpoint file has %d lines, want 1", len(trimmed))
	}
	if !strings.Contains(trimmed[0], `"type":"checkpoint"`) {
		t.Fatalf("line is not a checkpoint: %s", trimmed[0][:60])
	}
	projects := mustHistory(ListProjects())
	if len(projects) != 1 || projects[0].ProjectKey != project.ProjectKey {
		t.Fatalf("projects = %+v, want %+v", projects, project)
	}
	usage := mustHistory(GetCommandUsage()).Entries["help"]
	if usage.UsageCount != MaxHistoryEntries+2 || usage.LastUsedAt != MaxHistoryEntries+1 {
		t.Fatalf("usage = %+v", usage)
	}
	if _, err := RecordInput(InputOptions{Text: "/help", Cwd: wd, Source: "cli", CommandName: &help}); err != nil {
		t.Fatal(err)
	}
	if got := mustHistory(GetCommandUsage()).Entries["help"].UsageCount; got != MaxHistoryEntries+3 {
		t.Fatalf("usageCount = %d, want %d", got, MaxHistoryEntries+3)
	}
	if err := CompactActivity(); err != nil {
		t.Fatal(err)
	}
	if got := mustHistory(GetCommandUsage()).Entries["help"].UsageCount; got != MaxHistoryEntries+3 {
		t.Fatalf("post-compact usageCount = %d, want %d", got, MaxHistoryEntries+3)
	}
}

func TestRepairsIncompleteTailAndSkipsCorruptRecords(t *testing.T) {
	setupHome(t)
	wd := canonicalCwd(t)
	if _, err := RecordInput(InputOptions{Text: "first", Cwd: wd, SessionID: strPtr("one"), Source: "cli"}); err != nil {
		t.Fatal(err)
	}
	appendActivity(t, "not-json\n", `{"type":"input","text":"未完成`)
	if texts := mustHistory(LoadInputTexts()); len(texts) != 1 || texts[0] != "first" {
		t.Fatalf("texts = %v, want [first]", texts)
	}
	if _, err := RecordInput(InputOptions{Text: "last", Cwd: wd, SessionID: strPtr("one"), Source: "cli"}); err != nil {
		t.Fatal(err)
	}
	if texts := mustHistory(LoadInputTexts()); len(texts) != 2 || texts[1] != "last" {
		t.Fatalf("texts = %v, want [first last]", texts)
	}
	data, err := os.ReadFile(storage.YukinoPath(ActivityFileName))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "未完成") {
		t.Fatal("torn tail must be truncated before appending")
	}
}

func TestCheckpointOnRecordThreshold(t *testing.T) {
	setupHome(t)
	wd := canonicalCwd(t)
	if err := RegisterProject(wd); err != nil {
		t.Fatal(err)
	}
	help := "help"
	entry := testInput(t, 1, &help)
	var lines []string
	for i := 0; i < CompactAfterRecords-2; i++ {
		var record map[string]any
		if err := json.Unmarshal(entry, &record); err != nil {
			t.Fatal(err)
		}
		record["id"] = uuid.NewString()
		record["timestamp"] = i
		data, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		lines = append(lines, string(data)+"\n")
	}
	appendActivity(t, lines...)
	if _, err := RecordInput(InputOptions{Text: "last", Cwd: wd, SessionID: strPtr("one"), Source: "cli"}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(storage.YukinoPath(ActivityFileName))
	if err != nil {
		t.Fatal(err)
	}
	if got := len(strings.Split(strings.TrimSpace(string(data)), "\n")); got != 1 {
		t.Fatalf("file has %d lines after threshold checkpoint, want 1", got)
	}
	if got := mustHistory(GetCommandUsage()).Entries["help"].UsageCount; got != CompactAfterRecords-2 {
		t.Fatalf("usageCount = %d, want %d", got, CompactAfterRecords-2)
	}
}

func TestCanonicalizesAliasesAndRegistersProjectsWithoutInput(t *testing.T) {
	home := setupHome(t)
	project := filepath.Join(home, "project")
	alias := filepath.Join(home, "alias")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(project, alias); err != nil {
		t.Fatal(err)
	}
	if err := RegisterProject(alias); err != nil {
		t.Fatal(err)
	}
	if err := RegisterProject(project); err != nil {
		t.Fatal(err)
	}
	projects := mustHistory(ListProjects())
	if len(projects) != 1 {
		t.Fatalf("projects = %+v, want 1", projects)
	}
	real, err := filepath.EvalSymlinks(project)
	if err != nil {
		t.Fatal(err)
	}
	if projects[0].Cwd != real {
		t.Fatalf("cwd = %s, want %s", projects[0].Cwd, real)
	}
	if inputs := mustHistory(LoadInputs()); len(inputs) != 0 {
		t.Fatalf("inputs = %+v, want none", inputs)
	}
	info, err := os.Stat(storage.YukinoPath(ActivityFileName))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("activity mode = %o, want 600", info.Mode().Perm())
	}
}

func TestIgnoresMismatchedProjectRegistrations(t *testing.T) {
	setupHome(t)
	wd := canonicalCwd(t)
	if err := RegisterProject(wd); err != nil {
		t.Fatal(err)
	}
	appendActivity(t, `{"type":"project","cwd":"/wrong","projectKey":"`+strings.Repeat("0", 64)+`","createdAt":1}`+"\n")
	if projects := mustHistory(ListProjects()); len(projects) != 1 {
		t.Fatalf("projects = %+v, want 1", projects)
	}
}

func TestConcurrentWritersPreserveUpdatesWhileCompacting(t *testing.T) {
	setupHome(t)
	wd := canonicalCwd(t)
	if err := RegisterProject(wd); err != nil {
		t.Fatal(err)
	}
	help := "help"
	var wg sync.WaitGroup
	for worker := 0; worker < 3; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				if _, err := RecordInput(InputOptions{Text: "/help", Cwd: wd, Source: "sdk", CommandName: &help}); err != nil {
					t.Error(err)
					return
				}
				if i%7 == 0 {
					if err := CompactActivity(); err != nil {
						t.Error(err)
						return
					}
				}
			}
		}()
	}
	wg.Wait()
	if got := mustHistory(GetCommandUsage()).Entries["help"].UsageCount; got != 60 {
		t.Fatalf("usageCount = %d, want 60", got)
	}
	if got := len(mustHistory(LoadInputs())); got != 60 {
		t.Fatalf("inputs = %d, want 60", got)
	}
}

func TestRecordInputRejectsInvalidEntries(t *testing.T) {
	setupHome(t)
	if _, err := RecordInput(InputOptions{Text: "", Cwd: canonicalCwd(t), Source: "cli"}); err == nil {
		t.Fatal("empty text must be rejected")
	}
	if _, err := RecordInput(InputOptions{Text: "x", Cwd: canonicalCwd(t), Source: "bogus"}); err == nil {
		t.Fatal("invalid source must be rejected")
	}
	bad := "../escape"
	if _, err := RecordInput(InputOptions{Text: "x", Cwd: canonicalCwd(t), Source: "cli", SessionID: &bad}); err == nil {
		t.Fatal("invalid session id must be rejected")
	}
}

func TestActivityCacheNoticesSameSizeRewriteWithRestoredMtime(t *testing.T) {
	setupHome(t)
	wd := canonicalCwd(t)
	if _, err := RecordInput(InputOptions{Text: "first", Cwd: wd, Source: "cli"}); err != nil {
		t.Fatal(err)
	}
	if texts := mustHistory(LoadInputTexts()); len(texts) != 1 || texts[0] != "first" {
		t.Fatal(texts)
	}
	path := storage.YukinoPath(ActivityFileName)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), `"text":"first"`, `"text":"other"`, 1))
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if texts := mustHistory(LoadInputTexts()); len(texts) != 1 || texts[0] != "other" {
		t.Fatal("history cache hid external rewrite", texts)
	}
}

func mustHistory[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}
	return value
}
