package vscode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/text/unicode/norm"
)

func normNFC(s string) string { return norm.NFC.String(s) }

func setupLockDir(t *testing.T) string {
	t.Helper()
	configDir := t.TempDir()
	t.Setenv(ClaudeConfigDirEnvVar, configDir)
	t.Setenv(ClaudeCodeSSEPortEnvVar, "")
	dir := filepath.Join(configDir, IdeLockDirName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

func writeLock(t *testing.T, dir, filename string, content any) {
	t.Helper()
	data, err := json.Marshal(content)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, filename), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestDetectIdeNoDirectory(t *testing.T) {
	t.Setenv(ClaudeConfigDirEnvVar, filepath.Join(t.TempDir(), "missing"))
	if ide := DetectIde(t.TempDir()); ide != nil {
		t.Fatalf("expected nil without lock directory, got %+v", ide)
	}
}

func TestDetectIdeByEnvPort(t *testing.T) {
	dir := setupLockDir(t)
	workspace := t.TempDir()
	writeLock(t, dir, "55001"+LockfileExtension, map[string]any{
		"transport":        "ws",
		"workspaceFolders": []string{workspace},
		"ideName":          "VS Code",
		"authToken":        "secret",
	})
	writeLock(t, dir, "55002"+LockfileExtension, map[string]any{"transport": "ws"})
	t.Setenv(ClaudeCodeSSEPortEnvVar, "55002")

	// cwd outside every workspace: only the env port can match.
	ide := DetectIde(t.TempDir())
	if ide == nil || ide.Port != 55002 {
		t.Fatalf("expected port match 55002, got %+v", ide)
	}

	t.Setenv(ClaudeCodeSSEPortEnvVar, "55001")
	ide = DetectIde(t.TempDir())
	if ide == nil || ide.IdeName != "VS Code" || ide.AuthToken != "secret" {
		t.Fatalf("expected VS Code entry, got %+v", ide)
	}
	if ide.URL != "ws://127.0.0.1:55001" {
		t.Fatalf("url = %q", ide.URL)
	}
}

func TestDetectIdeByUniqueWorkspace(t *testing.T) {
	dir := setupLockDir(t)
	workspace := t.TempDir()
	nested := filepath.Join(workspace, "sub", "project")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	writeLock(t, dir, "55003"+LockfileExtension, map[string]any{
		"transport":        "ws",
		"workspaceFolders": []string{workspace},
	})

	ide := DetectIde(nested)
	if ide == nil || ide.Port != 55003 {
		t.Fatalf("expected workspace match, got %+v", ide)
	}
	if ide.IdeName != DefaultIdeName {
		t.Fatalf("expected default IDE name, got %q", ide.IdeName)
	}
	// Outside the workspace there is no match.
	if found := DetectIde(t.TempDir()); found != nil {
		t.Fatalf("expected nil outside workspace, got %+v", found)
	}
}

func TestDetectIdeAmbiguousWorkspace(t *testing.T) {
	dir := setupLockDir(t)
	workspace := t.TempDir()
	writeLock(t, dir, "55004"+LockfileExtension, map[string]any{"transport": "ws", "workspaceFolders": []string{workspace}})
	writeLock(t, dir, "55005"+LockfileExtension, map[string]any{"transport": "ws", "workspaceFolders": []string{workspace}})

	if ide := DetectIde(workspace); ide != nil {
		t.Fatalf("expected nil for ambiguous workspace, got %+v", ide)
	}
}

func TestDetectIdeSkipsStalePid(t *testing.T) {
	dir := setupLockDir(t)
	workspace := t.TempDir()
	// A pid that cannot be alive (reserved/invalid on every platform).
	writeLock(t, dir, "55006"+LockfileExtension, map[string]any{
		"transport":        "ws",
		"workspaceFolders": []string{workspace},
		"pid":              999999999,
	})
	if ide := DetectIde(workspace); ide != nil {
		t.Fatalf("expected stale lockfile to be dropped, got %+v", ide)
	}

	// Our own pid is alive, so the entry survives.
	writeLock(t, dir, "55007"+LockfileExtension, map[string]any{
		"transport":        "ws",
		"workspaceFolders": []string{workspace},
		"pid":              os.Getpid(),
	})
	ide := DetectIde(workspace)
	if ide == nil || ide.Port != 55007 || ide.Pid == nil {
		t.Fatalf("expected live-pid entry, got %+v", ide)
	}
}

func TestDetectIdeRejectsNonWsAndMalformed(t *testing.T) {
	dir := setupLockDir(t)
	workspace := t.TempDir()
	writeLock(t, dir, "55008"+LockfileExtension, map[string]any{"transport": "sse", "workspaceFolders": []string{workspace}})
	writeLock(t, dir, "55009"+LockfileExtension, map[string]any{"workspaceFolders": []string{workspace}})
	if err := os.WriteFile(filepath.Join(dir, "55010"+LockfileExtension), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notaport"+LockfileExtension), []byte(`{"transport":"ws"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ignored.txt"), []byte(`{"transport":"ws"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	if ide := DetectIde(workspace); ide != nil {
		t.Fatalf("expected nil with only invalid entries, got %+v", ide)
	}
}

func TestDetectIdeTypeMismatchRejected(t *testing.T) {
	dir := setupLockDir(t)
	workspace := t.TempDir()
	// pid with the wrong type fails schema validation like zod.
	writeLock(t, dir, "55011"+LockfileExtension, map[string]any{
		"transport":        "ws",
		"workspaceFolders": []string{workspace},
		"pid":              "alive",
	})
	if ide := DetectIde(workspace); ide != nil {
		t.Fatalf("expected type-mismatch entry to be rejected, got %+v", ide)
	}
}

func TestCwdInWorkspaceNFC(t *testing.T) {
	// "ü" as NFD (u + combining diaeresis) vs NFC.
	nfd := filepath.Join(t.TempDir(), "u\u0308nicode")
	if err := os.MkdirAll(nfd, 0o755); err != nil {
		t.Fatal(err)
	}
	nfc := normNFC(nfd)
	if !cwdInWorkspace(nfd, []string{nfc}) {
		t.Fatalf("NFD cwd should match NFC workspace folder")
	}
	if cwdInWorkspace(nfd, []string{""}) {
		t.Fatalf("empty folder must not match")
	}
}

func TestJsParseInt(t *testing.T) {
	cases := []struct {
		in   string
		want int
		ok   bool
	}{
		{"55001", 55001, true},
		{"12abc", 12, true},
		{"  34", 34, true},
		{"-5", -5, true},
		{"abc", 0, false},
		{"", 0, false},
	}
	for _, tc := range cases {
		got, ok := jsParseInt(tc.in)
		if ok != tc.ok || (ok && got != tc.want) {
			t.Errorf("jsParseInt(%q) = %d,%v want %d,%v", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestIdeLockDirDefault(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	os.Unsetenv(ClaudeConfigDirEnvVar)
	want := filepath.Join(home, DefaultConfigDirName, IdeLockDirName)
	if got := IdeLockDir(); got != want {
		t.Fatalf("IdeLockDir = %q, want %q", got, want)
	}
}
