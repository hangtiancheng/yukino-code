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

package logger

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSanitizeNameSegment(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"member-name_01", "member-name_01"},
		{"member name", "member_name"},
		{"a/b\\c", "a_b_c"},
		{"../escape", "___escape"},
		{"", "unnamed"},
		{"///", "___"},
		{"café", "caf_"},
	}
	for _, tt := range tests {
		if got := SanitizeNameSegment(tt.in); got != tt.want {
			t.Errorf("SanitizeNameSegment(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestIsSensitiveKey(t *testing.T) {
	sensitive := []string{
		"password", "PASSWORD", "api_key", "APIKey", "Api-Key",
		"authorization", "access_token", "refreshToken", "client_secret",
		"auth", "Cookie", "private_key", "credentials",
	}
	for _, k := range sensitive {
		if !isSensitiveKey(k) {
			t.Errorf("isSensitiveKey(%q) = false, want true", k)
		}
	}
	plain := []string{"path", "sessionId", "module", "command", "author", "tokenCount"}
	for _, k := range plain {
		if isSensitiveKey(k) {
			t.Errorf("isSensitiveKey(%q) = true, want false", k)
		}
	}
}

func TestInitLoggerWritesRedactsAndFilters(t *testing.T) {
	dir := t.TempDir()
	if _, err := InitLogger(Options{
		SessionID:   "sess-1",
		Mode:        ModeRemote,
		WorkDir:     dir,
		SkipCleanup: true,
	}); err != nil {
		t.Fatalf("InitLogger: %v", err)
	}
	defer CloseLogger()

	child := CreateChildLogger("tester")
	child.Warn("leaky", "password", "hunter2", "path", "/tmp/x")
	child.Info("below threshold") // level warn: must not be recorded
	Logger.Warn("root msg", "api_key", "sekret", "count", 3)
	child.Error("boom", "err", fmt.Errorf("outer: %w", errors.New("inner cause")))

	CloseLogger()

	raw, err := os.ReadFile(filepath.Join(dir, ".yukino", "logs", "sess-1.jsonl"))
	if err != nil {
		t.Fatalf("read log file: %v", err)
	}
	content := string(raw)
	lines := strings.Split(strings.TrimSpace(content), "\n")
	if len(lines) != 3 {
		t.Fatalf("got %d log lines, want 3:\n%s", len(lines), content)
	}

	for _, secret := range []string{"hunter2", "sekret"} {
		if strings.Contains(content, secret) {
			t.Errorf("log contains unredacted secret %q", secret)
		}
	}
	if n := strings.Count(content, redactedPlaceholder); n != 2 {
		t.Errorf("redaction placeholder count = %d, want 2", n)
	}
	if strings.Contains(content, "below threshold") {
		t.Error("info-level record should have been filtered")
	}
	for _, want := range []string{
		`"sessionId":"sess-1"`, `"mode":"remote"`, `"module":"tester"`,
		`"level":"WARN"`, `"level":"ERROR"`, `"path":"/tmp/x"`, `"count":3`,
		// error serialization: type + recursive cause
		`"type":"*fmt.wrapError"`, `"message":"outer: inner cause"`, `"message":"inner cause"`,
	} {
		if !strings.Contains(content, want) {
			t.Errorf("log missing %s\n%s", want, content)
		}
	}

	// .gitignore written into the .yukino ancestor, create-only semantics.
	gi, err := os.ReadFile(filepath.Join(dir, ".yukino", ".gitignore"))
	if err != nil || string(gi) != "*\n" {
		t.Errorf(".yukino/.gitignore = %q, err %v; want %q", string(gi), err, "*\n")
	}
}

func TestPreInitSilentFallback(t *testing.T) {
	CloseLogger() // ensure uninitialized

	child := CreateChildLogger("ghost")
	if child.Enabled(context.Background(), slog.LevelError) {
		t.Error("child logger should be disabled before InitLogger")
	}
	// Must be safe no-ops, no panic, no file created.
	child.Warn("dropped", "password", "whatever")
	Logger.Error("also dropped")

	dir := t.TempDir()
	if _, err := os.Stat(filepath.Join(dir, ".yukino")); !os.IsNotExist(err) {
		t.Errorf("silent fallback must not create log dirs, stat err = %v", err)
	}
}

func TestReinitClosesPreviousFile(t *testing.T) {
	dir := t.TempDir()
	if _, err := InitLogger(Options{SessionID: "first", WorkDir: dir, SkipCleanup: true}); err != nil {
		t.Fatal(err)
	}
	Logger.Warn("to first")
	if _, err := InitLogger(Options{SessionID: "second", WorkDir: dir, SkipCleanup: true}); err != nil {
		t.Fatal(err)
	}
	Logger.Warn("to second")
	CloseLogger()

	for _, session := range []string{"first", "second"} {
		raw, err := os.ReadFile(filepath.Join(dir, ".yukino", "logs", session+".jsonl"))
		if err != nil {
			t.Fatalf("read %s: %v", session, err)
		}
		if !strings.Contains(string(raw), "to "+session) {
			t.Errorf("%s.jsonl missing its record: %s", session, raw)
		}
		if strings.Contains(string(raw), "to first") && session == "second" {
			t.Error("second file must not receive first logger's records")
		}
	}
}

func TestLogDirOverride(t *testing.T) {
	dir := t.TempDir()
	logDir := filepath.Join(dir, "custom-logs")
	if _, err := InitLogger(Options{SessionID: "s", LogDir: logDir, SkipCleanup: true}); err != nil {
		t.Fatal(err)
	}
	Logger.Warn("custom")
	CloseLogger()
	if _, err := os.Stat(filepath.Join(logDir, "s.jsonl")); err != nil {
		t.Errorf("custom log file missing: %v", err)
	}
	// No .yukino ancestor -> no .gitignore written.
	if _, err := os.Stat(filepath.Join(dir, ".yukino", ".gitignore")); !os.IsNotExist(err) {
		t.Errorf("gitignore should not be created outside .yukino, err = %v", err)
	}
}

func TestCleanDir(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "old.jsonl")
	fresh := filepath.Join(dir, "fresh.jsonl")
	other := filepath.Join(dir, "old.txt")
	for _, p := range []string{old, fresh, other} {
		if err := os.WriteFile(p, []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-40 * 24 * time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(other, past, past); err != nil {
		t.Fatal(err)
	}

	if got := cleanDir(dir); got != 1 {
		t.Errorf("cleanDir removed %d, want 1", got)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Error("expired .jsonl should be removed")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Error("fresh .jsonl must survive")
	}
	if _, err := os.Stat(other); err != nil {
		t.Error("non-.jsonl files must survive")
	}
	if got := cleanDir(filepath.Join(dir, "missing")); got != 0 {
		t.Errorf("cleanDir(missing) = %d, want 0", got)
	}
}

func TestSerializeErrorCauseDepth(t *testing.T) {
	// Chain of 7 wrapped errors: cause serialization stops at depth 5.
	var err error = errors.New("base")
	for i := 0; i < 7; i++ {
		err = fmt.Errorf("wrap%d: %w", i, err)
	}
	out := serializeError(err)
	depth := 0
	for cur, ok := out.Cause.(serializedError); ok; cur, ok = cur.Cause.(serializedError) {
		depth++
	}
	if depth != causeMaxDepth {
		t.Errorf("cause chain depth = %d, want %d", depth, causeMaxDepth)
	}
}
