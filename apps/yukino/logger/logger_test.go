package logger

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func readLines(t *testing.T, path string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("invalid JSONL line %q: %v", line, err)
		}
		out = append(out, record)
	}
	return out
}

func TestSanitizeNameSegment(t *testing.T) {
	for input, want := range map[string]string{
		"alice":     "alice",
		"a b/c":     "a_b_c",
		"mem-ber_1": "mem-ber_1",
		"":          DefaultNameSegment,
		"///":       "___",
		"中文name":    "__name",
	} {
		if got := SanitizeNameSegment(input); got != want {
			t.Errorf("SanitizeNameSegment(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestSilentBeforeInit(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	CloseLogger()
	Global().Warn(nil, "discarded")
	CreateChildLogger("tools").Error(nil, "discarded")
	if path := GetLogFilePath(); path != "" {
		t.Fatalf("expected no log path before init, got %q", path)
	}
}

func TestInitLoggerRecordFormat(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	CloseLogger()
	if err := InitLogger(InitLoggerOptions{SessionID: "sess-1", Mode: ModeTerminal, SkipCleanup: true}); err != nil {
		t.Fatalf("init: %v", err)
	}
	defer CloseLogger()

	path := GetLogFilePath()
	if want := filepath.Join(os.Getenv("HOME"), ".yukino", LogsDirName, "sess-1"+LogFileExtension); path != want {
		t.Fatalf("log path = %q, want %q", path, want)
	}

	CreateChildLogger("tools").Warn(map[string]any{"url": "http://x", "n": 5}, "web fetch failed")
	CreateChildLogger("tools").Error(map[string]any{"err": errors.New("boom")}, "tool operation failed")
	CreateChildLogger("tools").Warn(nil, "message only")
	CreateChildLogger("tools").Info(nil, "below threshold")
	CreateChildLogger("tools").Debug(nil, "below threshold")
	FlushLogger()

	records := readLines(t, path)
	if len(records) != 3 {
		t.Fatalf("expected 3 records (info/debug filtered), got %d", len(records))
	}

	first := records[0]
	if first["level"] != float64(levelWarn) {
		t.Errorf("level = %v, want %d", first["level"], levelWarn)
	}
	if first["sessionId"] != "sess-1" || first["mode"] != "terminal" || first["module"] != "tools" {
		t.Errorf("base/binding fields wrong: %v", first)
	}
	if first["url"] != "http://x" || first["n"] != float64(5) || first["msg"] != "web fetch failed" {
		t.Errorf("merge fields wrong: %v", first)
	}
	if _, ok := first["time"].(float64); !ok {
		t.Errorf("time missing or not numeric: %v", first["time"])
	}

	second := records[1]
	if second["level"] != float64(levelError) {
		t.Errorf("level = %v, want %d", second["level"], levelError)
	}
	errField, ok := second["err"].(map[string]any)
	if !ok {
		t.Fatalf("err field missing: %v", second)
	}
	if errField["message"] != "boom" {
		t.Errorf("err.message = %v, want boom", errField["message"])
	}
	if errField["type"] != "errorString" {
		t.Errorf("err.type = %v, want errorString", errField["type"])
	}

	if records[2]["msg"] != "message only" {
		t.Errorf("message-only record wrong: %v", records[2])
	}
}

func TestLogLineKeyOrderMatchesPino(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	CloseLogger()
	if err := InitLogger(InitLoggerOptions{SessionID: "sess-order", Mode: ModeRemote, SkipCleanup: true}); err != nil {
		t.Fatalf("init: %v", err)
	}
	defer CloseLogger()
	CreateChildLogger("tools").Warn(map[string]any{"url": "http://x"}, "web fetch failed")
	FlushLogger()

	data, err := os.ReadFile(GetLogFilePath())
	if err != nil {
		t.Fatal(err)
	}
	line := strings.TrimSpace(string(data))
	// pino order: level, time, sessionId, mode, module, fields..., msg.
	prefix := `{"level":40,"time":`
	if !strings.HasPrefix(line, prefix) {
		t.Fatalf("line does not start with %q: %s", prefix, line)
	}
	idxSession := strings.Index(line, `"sessionId":"sess-order"`)
	idxMode := strings.Index(line, `"mode":"remote"`)
	idxModule := strings.Index(line, `"module":"tools"`)
	idxURL := strings.Index(line, `"url":"http://x"`)
	idxMsg := strings.Index(line, `"msg":"web fetch failed"`)
	if !(idxSession < idxMode && idxMode < idxModule && idxModule < idxURL && idxURL < idxMsg) {
		t.Fatalf("unexpected key order: %s", line)
	}
}

func TestErrCauseChain(t *testing.T) {
	inner := errors.New("root cause")
	mid := fmt.Errorf("middle: %w", inner)
	outer := fmt.Errorf("outer: %w", mid)

	serialized := SerializeErr(outer).(map[string]any)
	if serialized["message"] != "outer: middle: root cause" {
		t.Fatalf("outer message = %v", serialized["message"])
	}
	cause, ok := serialized["cause"].(map[string]any)
	if !ok {
		t.Fatalf("missing cause: %v", serialized)
	}
	if cause["message"] != "middle: root cause" {
		t.Fatalf("cause message = %v", cause["message"])
	}
	cause2, ok := cause["cause"].(map[string]any)
	if !ok || cause2["message"] != "root cause" {
		t.Fatalf("nested cause wrong: %v", cause["cause"])
	}
	if _, deeper := cause2["cause"]; deeper {
		t.Fatalf("expected no deeper cause")
	}
}

func TestSerializeNonError(t *testing.T) {
	out := SerializeErr("plain string").(map[string]any)
	if out["message"] != "plain string" || out["value"] != "plain string" {
		t.Fatalf("string normalization wrong: %v", out)
	}
	out = SerializeErr(42).(map[string]any)
	if out["message"] != "42" {
		t.Fatalf("number normalization wrong: %v", out)
	}
}

func TestCloseLoggerStopsWriting(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	CloseLogger()
	if err := InitLogger(InitLoggerOptions{SessionID: "sess-close", Mode: ModeTerminal, SkipCleanup: true}); err != nil {
		t.Fatalf("init: %v", err)
	}
	path := GetLogFilePath()
	CloseLogger()
	if GetLogFilePath() != "" {
		t.Fatalf("expected empty path after close")
	}
	Global().Error(nil, "after close")
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), "after close") {
		t.Fatalf("record written after close")
	}
}

func TestReinitClosesPrevious(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	CloseLogger()
	if err := InitLogger(InitLoggerOptions{SessionID: "sess-a", Mode: ModeTerminal, SkipCleanup: true}); err != nil {
		t.Fatalf("init a: %v", err)
	}
	first := GetLogFilePath()
	if err := InitLogger(InitLoggerOptions{SessionID: "sess-b", Mode: ModeTerminal, SkipCleanup: true}); err != nil {
		t.Fatalf("init b: %v", err)
	}
	defer CloseLogger()
	if GetLogFilePath() == first {
		t.Fatalf("expected new log path after re-init")
	}
	Global().Warn(nil, "to b")
	FlushLogger()
	data, _ := os.ReadFile(GetLogFilePath())
	if !strings.Contains(string(data), "to b") {
		t.Fatalf("record not written to new log")
	}
}

func TestCleanExpiredLogs(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	logsDir := filepath.Join(home, ".yukino", LogsDirName)
	if err := os.MkdirAll(logsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	teamLogsDir := filepath.Join(home, ".yukino", teamsDirName, "ns", "team-a", LogsDirName)
	if err := os.MkdirAll(teamLogsDir, 0o700); err != nil {
		t.Fatal(err)
	}

	write := func(dir, name string, age time.Duration) {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		mtime := time.Now().Add(-age)
		if err := os.Chtimes(path, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}
	write(logsDir, "old"+LogFileExtension, 31*24*time.Hour)
	write(logsDir, "fresh"+LogFileExtension, time.Hour)
	write(logsDir, "other.txt", 31*24*time.Hour)
	write(teamLogsDir, "team-old"+LogFileExtension, 40*24*time.Hour)
	write(teamLogsDir, "team-fresh"+LogFileExtension, time.Hour)

	removed := CleanExpiredLogs()
	if removed != 2 {
		t.Fatalf("removed = %d, want 2", removed)
	}
	if _, err := os.Stat(filepath.Join(logsDir, "old"+LogFileExtension)); !os.IsNotExist(err) {
		t.Fatalf("expired main log not removed")
	}
	if _, err := os.Stat(filepath.Join(logsDir, "fresh"+LogFileExtension)); err != nil {
		t.Fatalf("fresh main log removed")
	}
	if _, err := os.Stat(filepath.Join(logsDir, "other.txt")); err != nil {
		t.Fatalf("non-jsonl file removed")
	}
	if _, err := os.Stat(filepath.Join(teamLogsDir, "team-old"+LogFileExtension)); !os.IsNotExist(err) {
		t.Fatalf("expired team log not removed")
	}
	if _, err := os.Stat(filepath.Join(teamLogsDir, "team-fresh"+LogFileExtension)); err != nil {
		t.Fatalf("fresh team log removed")
	}
}

func TestInitLoggerCustomLogDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	CloseLogger()
	dir := filepath.Join(t.TempDir(), "custom")
	if err := InitLogger(InitLoggerOptions{SessionID: "sess-x", Mode: ModeTeammate, LogDir: dir, SkipCleanup: true}); err != nil {
		t.Fatalf("init: %v", err)
	}
	defer CloseLogger()
	if want := filepath.Join(dir, "sess-x"+LogFileExtension); GetLogFilePath() != want {
		t.Fatalf("log path = %q, want %q", GetLogFilePath(), want)
	}
	Global().Warn(nil, "hello")
	FlushLogger()
	data, err := os.ReadFile(GetLogFilePath())
	if err != nil || !strings.Contains(string(data), `"mode":"teammate"`) {
		t.Fatalf("custom-dir record wrong: %v %q", err, data)
	}
}
