package images

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestIsPngBuffer(t *testing.T) {
	valid := append(append([]byte{}, PNGSignature...), 0x00, 0x01)
	if !IsPngBuffer(valid) {
		t.Fatal("expected valid PNG buffer")
	}
	if IsPngBuffer(PNGSignature) {
		t.Fatal("exactly 8 bytes must be rejected (needs > signature length)")
	}
	if IsPngBuffer([]byte("not a png at all")) {
		t.Fatal("non-PNG must be rejected")
	}
	if IsPngBuffer(nil) {
		t.Fatal("nil must be rejected")
	}
}

func TestClipboardImageFileName(t *testing.T) {
	data := []byte("some clipboard png bytes")
	name := ClipboardImageFileName(data)
	if !strings.HasSuffix(name, ".png") || len(name) != 16+len(".png") {
		t.Fatalf("name = %q, want 16 hex chars + .png", name)
	}
	if ClipboardImageFileName(data) != name {
		t.Fatal("same bytes must reuse the same file name")
	}
	if ClipboardImageFileName([]byte("other bytes")) == name {
		t.Fatal("different bytes must produce a different name")
	}
}

func TestStoreClipboardImage(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	sessionID := "clipboard-test"

	if _, err := StoreClipboardImage(sessionID, []byte("not png")); err == nil || err.Error() != ClipboardNotPNGError {
		t.Fatalf("expected not-PNG error, got %v", err)
	}

	pngBytes := append(append([]byte{}, PNGSignature...), make([]byte, 64)...)
	path, err := StoreClipboardImage(sessionID, pngBytes)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	wantDir, _ := filepath.Split(path)
	if !strings.Contains(strings.ReplaceAll(wantDir, "\\", "/"), "sessions/artifacts/"+sessionID+"/file-history/") {
		t.Fatalf("path = %q, want under the session file-history dir", path)
	}
	stored, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(stored, pngBytes) {
		t.Fatalf("stored content mismatch: %v", err)
	}

	// Same bytes reuse the same file.
	again, err := StoreClipboardImage(sessionID, pngBytes)
	if err != nil || again != path {
		t.Fatalf("expected reuse of %q, got %q (%v)", path, again, err)
	}
}

func TestStoreClipboardImageTooLarge(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	big := append(append([]byte{}, PNGSignature...), make([]byte, MaxClipboardImageBytes)...)
	if _, err := StoreClipboardImage("clipboard-test", big); err == nil ||
		!strings.Contains(err.Error(), "Clipboard image is too large") {
		t.Fatalf("expected too-large error, got %v", err)
	}
}

func TestRunCommandExitAndOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell test")
	}
	result, err := runCommand("/bin/sh", []string{"-c", "echo hello; echo oops >&2; exit 7"}, nil)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if result.code != 7 {
		t.Fatalf("code = %d, want 7", result.code)
	}
	if string(result.stdout) != "hello\n" {
		t.Fatalf("stdout = %q", result.stdout)
	}
	if result.stderr != "oops" {
		t.Fatalf("stderr = %q, want trimmed", result.stderr)
	}
}

func TestRunCommandMissingBinary(t *testing.T) {
	_, err := runCommand("yukino-definitely-not-installed-xyz", nil, nil)
	if err == nil || err.Error() != "yukino-definitely-not-installed-xyz is not installed or not on PATH." {
		t.Fatalf("expected not-installed error, got %v", err)
	}
}

func TestRunCommandExtraEnv(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell test")
	}
	result, err := runCommand("/bin/sh", []string{"-c", "printf %s \"$YUKINO_TEST_VAR\""}, map[string]string{"YUKINO_TEST_VAR": "injected"})
	if err != nil || result.code != 0 {
		t.Fatalf("run: %v (code %d)", err, result.code)
	}
	if string(result.stdout) != "injected" {
		t.Fatalf("stdout = %q", result.stdout)
	}
}

func TestRunCommandStdoutLimit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell test")
	}
	// head -c produces one byte over the limit without a huge intermediate file.
	_, err := runCommand("/bin/sh", []string{"-c", "head -c " + strconv.Itoa(MaxClipboardImageBytes+1) + " /dev/zero"}, nil)
	if err == nil || !strings.Contains(err.Error(), "produced more than the clipboard image byte limit") {
		t.Fatalf("expected stdout-limit error, got %v", err)
	}
}

func TestSaveClipboardImageUnsupportedPlatform(t *testing.T) {
	// On supported platforms exercise the no-session failure path instead:
	// linux without WAYLAND_DISPLAY/DISPLAY reports the session error.
	if runtime.GOOS != "linux" {
		t.Skip("platform-specific failure path")
	}
	t.Setenv("WAYLAND_DISPLAY", "")
	t.Setenv("DISPLAY", "")
	os.Unsetenv("WAYLAND_DISPLAY")
	os.Unsetenv("DISPLAY")
	t.Setenv("HOME", t.TempDir())
	result := SaveClipboardImage("clipboard-test")
	if result.OK || result.Reason != ClipboardNoSessionError {
		t.Fatalf("result = %+v", result)
	}
}
