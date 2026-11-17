package images

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/file_history"
	"github.com/yukino-js/yukino/yukino/internal/storage"
)

// SaveClipboardImageResult mirrors the reference discriminated union
// { ok: true; value } | { ok: false; reason }.
type SaveClipboardImageResult struct {
	OK     bool
	Value  string
	Reason string
}

func IsPngBuffer(data []byte) bool {
	return len(data) > len(PNGSignature) && bytes.Equal(data[:8], PNGSignature)
}

// ClipboardImageFileName mirrors the file-history backup naming scheme
// (sha256 hex prefix), so pasting the same image twice reuses the same file.
func ClipboardImageFileName(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])[:16] + ".png"
}

func StoreClipboardImage(sessionID string, data []byte) (string, error) {
	if !IsPngBuffer(data) {
		return "", errors.New(ClipboardNotPNGError)
	}
	if len(data) > MaxClipboardImageBytes {
		return "", fmt.Errorf("Clipboard image is too large (%d bytes, limit %d).", len(data), MaxClipboardImageBytes)
	}
	dir, err := file_history.FileHistoryDir(sessionID)
	if err != nil {
		return "", err
	}
	if err := storage.MkdirPrivateSync(dir); err != nil {
		return "", err
	}
	path := filepath.Join(dir, ClipboardImageFileName(data))
	if err := storage.WritePrivateFileSync(path, data, os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
		return "", err
	}
	return path, nil
}

type runResult struct {
	code   int
	stdout []byte
	stderr string
}

// limitedBuffer retains at most limit bytes and records whether more arrived.
type limitedBuffer struct {
	mu       sync.Mutex
	limit    int
	data     []byte
	overflow bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	remaining := b.limit - len(b.data)
	if remaining > 0 {
		if len(p) <= remaining {
			b.data = append(b.data, p...)
		} else {
			b.data = append(b.data, p[:remaining]...)
			b.overflow = true
		}
	} else {
		b.overflow = true
	}
	return len(p), nil
}

func (b *limitedBuffer) bytes() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]byte(nil), b.data...)
}

func (b *limitedBuffer) overflowed() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.overflow
}

// runCommand mirrors the reference run(): no shell, hidden window, stdin
// ignored, bounded stdout/stderr, hard timeout that kills the child.
func runCommand(command string, args []string, extraEnv map[string]string) (runResult, error) {
	cmd := exec.Command(command, args...)
	if extraEnv != nil {
		env := os.Environ()
		for key, value := range extraEnv {
			env = append(env, key+"="+value)
		}
		cmd.Env = env
	}
	stdout := &limitedBuffer{limit: MaxClipboardImageBytes}
	stderr := &limitedBuffer{limit: MaxStderrBytes}
	cmd.Stdin = nil
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	var timedOut atomic.Bool
	timer := time.AfterFunc(ClipboardTimeoutMS*time.Millisecond, func() {
		timedOut.Store(true)
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	})
	defer timer.Stop()

	runErr := cmd.Run()
	if timedOut.Load() {
		return runResult{}, fmt.Errorf("%s timed out after %dms.", command, ClipboardTimeoutMS)
	}
	if stdout.overflowed() {
		return runResult{}, fmt.Errorf("%s produced more than the clipboard image byte limit.", command)
	}
	result := runResult{
		code:   0,
		stdout: stdout.bytes(),
		stderr: strings.TrimSpace(string(stderr.bytes())),
	}
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			code := exitErr.ExitCode()
			if code == -1 {
				code = 1
			}
			result.code = code
			return result, nil
		}
		if errors.Is(runErr, exec.ErrNotFound) || errors.Is(runErr, syscall.ENOENT) {
			return runResult{}, fmt.Errorf("%s is not installed or not on PATH.", command)
		}
		return runResult{}, runErr
	}
	return result, nil
}

var macosScriptLines = []string{
	"on run argv",
	"set d to the clipboard as «class PNGf»",
	"set f to open for access POSIX file (item 1 of argv) with write permission",
	"set eof f to 0",
	"write d to f",
	"close access f",
	"end run",
}

func readMacClipboard(tempPath string) ([]byte, error) {
	var args []string
	for _, line := range macosScriptLines {
		args = append(args, "-e", line)
	}
	args = append(args, tempPath)
	result, err := runCommand("/usr/bin/osascript", args, nil)
	if err != nil {
		return nil, err
	}
	if result.code != 0 {
		// AppleScript error -1700: clipboard content can't coerce to PNG data.
		if strings.Contains(result.stderr, "-1700") {
			return nil, errors.New(NoImageMessage)
		}
		detail := result.stderr
		if detail == "" {
			detail = fmt.Sprintf("exit %d", result.code)
		}
		return nil, fmt.Errorf("osascript failed: %s", detail)
	}
	return os.ReadFile(tempPath)
}

func readLinuxClipboard() ([]byte, error) {
	type backend struct {
		command string
		args    []string
		hint    string
	}
	var backends []backend
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		backends = append(backends, backend{
			command: "wl-paste",
			args:    []string{"--no-newline", "--type", "image/png"},
			hint:    "Install wl-clipboard (provides wl-paste).",
		})
	}
	if os.Getenv("DISPLAY") != "" {
		backends = append(backends, backend{
			command: "xclip",
			args:    []string{"-selection", "clipboard", "-t", "image/png", "-o"},
			hint:    "Install xclip with your system package manager.",
		})
	}
	if len(backends) == 0 {
		return nil, errors.New(ClipboardNoSessionError)
	}

	lastError := errors.New(NoImageMessage)
	for _, b := range backends {
		result, err := runCommand(b.command, b.args, nil)
		if err != nil {
			lastError = fmt.Errorf("%s %s", err.Error(), b.hint)
			continue
		}
		if result.code == 0 && len(result.stdout) > 0 {
			return result.stdout, nil
		}
		detail := strings.ToLower(result.stderr)
		if strings.Contains(detail, "target") || strings.Contains(detail, "no suitable") || strings.Contains(detail, "nothing") {
			lastError = errors.New(NoImageMessage)
		} else {
			message := result.stderr
			if message == "" {
				message = fmt.Sprintf("exit %d", result.code)
			}
			lastError = fmt.Errorf("%s failed: %s", b.command, message)
		}
	}
	return nil, lastError
}

var windowsScript = strings.Join([]string{
	"$ErrorActionPreference = 'Stop'",
	"Add-Type -AssemblyName System.Windows.Forms",
	"Add-Type -AssemblyName System.Drawing",
	"$img = [System.Windows.Forms.Clipboard]::GetImage()",
	"if ($null -eq $img) { exit 3 }",
	"$img.Save($env:YUKINO_CLIPBOARD_PATH, [System.Drawing.Imaging.ImageFormat]::Png)",
	"$img.Dispose()",
}, "; ")

func readWindowsClipboard(tempPath string) ([]byte, error) {
	result, err := runCommand("powershell.exe", []string{"-NoProfile", "-NonInteractive", "-Sta", "-Command", windowsScript}, map[string]string{
		"YUKINO_CLIPBOARD_PATH": tempPath,
	})
	if err != nil {
		return nil, err
	}
	if result.code == 3 {
		return nil, errors.New(NoImageMessage)
	}
	if result.code != 0 {
		detail := result.stderr
		if detail == "" {
			detail = fmt.Sprintf("exit %d", result.code)
		}
		return nil, fmt.Errorf("powershell failed: %s", detail)
	}
	return os.ReadFile(tempPath)
}

// SaveClipboardImage reads an image from the system clipboard and saves it as
// a PNG under ~/.yukino/sessions/artifacts/<sessionId>/file-history/. On
// success Value is the absolute file path, ready to be referenced in a prompt
// and read back via ReadFile; on failure Reason explains why.
func SaveClipboardImage(sessionID string) SaveClipboardImageResult {
	dir, err := file_history.FileHistoryDir(sessionID)
	if err != nil {
		return SaveClipboardImageResult{Reason: err.Error()}
	}
	tempPath := filepath.Join(dir, fmt.Sprintf(".clipboard-%d.tmp", os.Getpid()))
	defer func() { _ = os.Remove(tempPath) }()

	var data []byte
	switch runtime.GOOS {
	case "darwin":
		if err := storage.MkdirPrivateSync(dir); err != nil {
			return SaveClipboardImageResult{Reason: err.Error()}
		}
		data, err = readMacClipboard(tempPath)
	case "linux":
		data, err = readLinuxClipboard()
	case "windows":
		if err := storage.MkdirPrivateSync(dir); err != nil {
			return SaveClipboardImageResult{Reason: err.Error()}
		}
		data, err = readWindowsClipboard(tempPath)
	default:
		return SaveClipboardImageResult{Reason: fmt.Sprintf("Clipboard image paste is not supported on %s.", runtime.GOOS)}
	}
	if err != nil {
		return SaveClipboardImageResult{Reason: err.Error()}
	}
	if len(data) == 0 {
		return SaveClipboardImageResult{Reason: NoImageMessage}
	}
	path, err := StoreClipboardImage(sessionID, data)
	if err != nil {
		return SaveClipboardImageResult{Reason: err.Error()}
	}
	return SaveClipboardImageResult{OK: true, Value: path}
}
