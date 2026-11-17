package tools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/images"
)

type computerOutputLimit struct {
	sync.Mutex
	total, maximum int
	cancel         context.CancelCauseFunc
	command        string
}
type computerOutput struct {
	limit  *computerOutputLimit
	buffer bytes.Buffer
}

func (o *computerOutput) Write(data []byte) (int, error) {
	o.limit.Lock()
	defer o.limit.Unlock()
	o.limit.total += len(data)
	if o.limit.total > o.limit.maximum {
		o.limit.cancel(fmt.Errorf("%s exceeded the %d byte output limit.", o.limit.command, o.limit.maximum))
		return len(data), nil
	}
	return o.buffer.Write(data)
}
func runComputerCommand(parent context.Context, command string, args []string, options ComputerCommandOptions) (ComputerCommandResult, error) {
	timeout := options.Timeout
	if timeout == 0 {
		timeout = ComputerCommandTimeout
	}
	maximum := options.MaxOutputBytes
	if maximum == 0 {
		maximum = MaxComputerOutputBytes
	}
	deadline, stop := context.WithTimeout(parent, timeout)
	defer stop()
	ctx, cancel := context.WithCancelCause(deadline)
	defer cancel(nil)
	cmd := exec.CommandContext(ctx, command, args...)
	prepareShellProcess(cmd)
	cmd.Cancel = func() error { killShellProcess(cmd, true); return nil }
	cmd.WaitDelay = time.Second
	cmd.Env = os.Environ()
	for key, value := range options.Env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	limit := &computerOutputLimit{maximum: maximum, cancel: cancel, command: command}
	out, stderr := &computerOutput{limit: limit}, &computerOutput{limit: limit}
	cmd.Stdout, cmd.Stderr = out, stderr
	err := cmd.Run()
	if cause := context.Cause(ctx); cause != nil {
		if parent.Err() != nil {
			return ComputerCommandResult{}, fmt.Errorf("%s was interrupted.", command)
		}
		if errors.Is(cause, context.DeadlineExceeded) {
			return ComputerCommandResult{}, fmt.Errorf("%s timed out after %dms.", command, timeout.Milliseconds())
		}
		return ComputerCommandResult{}, cause
	}
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
				return ComputerCommandResult{}, fmt.Errorf("%s is not installed or not on PATH.", command)
			}
			return ComputerCommandResult{}, err
		}
	}
	return ComputerCommandResult{Code: cmd.ProcessState.ExitCode(), Stdout: out.buffer.Bytes(), Stderr: strings.TrimSpace(stderr.buffer.String())}, nil
}
func computerCommandError(command string, result ComputerCommandResult) error {
	reason := result.Stderr
	if reason == "" {
		reason = strings.TrimSpace(string(result.Stdout))
	}
	if reason == "" {
		reason = fmt.Sprintf("exit %d", result.Code)
	}
	return fmt.Errorf("%s failed: %s", command, reason)
}
func (t *ComputerUseTool) runComputerChecked(ctx context.Context, command string, args []string, options ComputerCommandOptions) (string, error) {
	result, err := t.run(ctx, command, args, options)
	if err != nil {
		return "", err
	}
	if result.Code != 0 {
		return "", computerCommandError(command, result)
	}
	return strings.TrimSpace(string(result.Stdout)), nil
}
func (t *ComputerUseTool) executeComputerNative(ctx context.Context, action nativeComputerInput) (string, error) {
	if t.platform == "linux" {
		return t.executeComputerLinux(ctx, action)
	}
	timeout := ComputerCommandTimeout
	if action.Action == "hold_key" && action.Duration != nil {
		timeout = max(timeout, time.Duration(*action.Duration*float64(time.Second))+5*time.Second)
	}
	if t.platform == "darwin" {
		return t.runMacComputerPayload(ctx, action, timeout)
	}
	if t.platform == "win32" {
		helper, err := t.getComputerHelper(ctx, false)
		if err != nil {
			return "", err
		}
		data, _ := json.Marshal(action)
		return t.runComputerChecked(ctx, "powershell.exe", []string{"-NoProfile", "-NonInteractive", "-Sta", "-Command", computerAsset("action.ps1")}, ComputerCommandOptions{Env: map[string]string{"YUKINO_COMPUTER_ASSEMBLY": helper, "YUKINO_COMPUTER_INPUT": base64.StdEncoding.EncodeToString(data)}, Timeout: timeout})
	}
	return "", fmt.Errorf("ComputerUse is not supported on %s.", t.platform)
}
func (t *ComputerUseTool) runMacComputerPayload(ctx context.Context, payload any, timeout time.Duration) (string, error) {
	helper, err := t.getComputerHelper(ctx, true)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	result, err := t.run(ctx, helper, nil, ComputerCommandOptions{Env: map[string]string{"YUKINO_COMPUTER_INPUT": base64.StdEncoding.EncodeToString(data)}, Timeout: timeout})
	if err != nil {
		return "", err
	}
	if result.Code != 0 {
		return "", computerCommandError("macOS computer helper", result)
	}
	return strings.TrimSpace(string(result.Stdout)), nil
}
func (t *ComputerUseTool) getComputerHelper(ctx context.Context, mac bool) (string, error) {
	helper := &t.windowsHelper
	prefix := "yukino-windows-computer-helper-"
	if mac {
		helper = &t.macHelper
		prefix = "yukino-computer-helper-"
	}
	if *helper != "" {
		return *helper, nil
	}
	dir, err := os.MkdirTemp("", prefix)
	if err != nil {
		return "", err
	}
	cleanup := func() { os.RemoveAll(dir) }
	unregister := RegisterExitCleanup(cleanup)
	var path string
	if mac {
		source := filepath.Join(dir, "main.swift")
		path = filepath.Join(dir, "computer-helper")
		err = os.WriteFile(source, []byte(computerAsset("main.swift")), 0600)
		if err == nil {
			var result ComputerCommandResult
			result, err = t.run(ctx, "/usr/bin/xcrun", []string{"swiftc", "-O", source, "-o", path}, ComputerCommandOptions{Timeout: 120 * time.Second})
			if err == nil && result.Code != 0 {
				err = computerCommandError("swiftc", result)
			}
		}
	} else {
		path = filepath.Join(dir, "YukinoComputer.dll")
		var result ComputerCommandResult
		result, err = t.run(ctx, "powershell.exe", []string{"-NoProfile", "-NonInteractive", "-Sta", "-Command", computerAsset("compile.ps1")}, ComputerCommandOptions{Env: map[string]string{"YUKINO_COMPUTER_ASSEMBLY": path}, Timeout: 120 * time.Second})
		if err == nil && result.Code != 0 {
			err = computerCommandError("powershell.exe", result)
		}
	}
	if err != nil {
		unregister()
		cleanup()
		return "", err
	}
	*helper = path
	return path, nil
}

var computerCursorX = regexp.MustCompile(`(?:^|\n)X=(\d+)`)
var computerCursorY = regexp.MustCompile(`(?:^|\n)Y=(\d+)`)

func (t *ComputerUseTool) executeComputerLinux(ctx context.Context, a nativeComputerInput) (output string, err error) {
	run := func(ctx context.Context, args ...string) (string, error) {
		return t.runComputerChecked(ctx, "xdotool", args, ComputerCommandOptions{})
	}
	keyDown := func() error {
		for _, key := range a.Keys {
			if _, err := run(ctx, "keydown", "--", key); err != nil {
				return err
			}
		}
		return nil
	}
	keyUp := func() error {
		for i := len(a.Keys) - 1; i >= 0; i-- {
			if _, err := run(context.Background(), "keyup", "--", a.Keys[i]); err != nil {
				return err
			}
		}
		return nil
	}
	withKeys := func(operation func() error) (err error) {
		defer func() {
			if up := keyUp(); up != nil {
				err = up
			}
		}()
		if err = keyDown(); err != nil {
			return err
		}
		return operation()
	}
	move := func() error {
		if a.X != nil && a.Y != nil {
			_, err := run(ctx, "mousemove", "--sync", strconv.Itoa(*a.X), strconv.Itoa(*a.Y))
			return err
		}
		return nil
	}
	switch a.Action {
	case "cursor_position":
		output, err = run(ctx, "getmouselocation", "--shell")
		if err != nil {
			return "", err
		}
		x, y := computerCursorX.FindStringSubmatch(output), computerCursorY.FindStringSubmatch(output)
		if len(x) < 2 || len(y) < 2 {
			return "", fmt.Errorf("Unable to parse cursor position: %s", output)
		}
		return x[1] + "," + y[1], nil
	case "mouse_move":
		err = withKeys(move)
	case "left_mouse_down":
		_, err = run(ctx, "mousedown", "1")
	case "left_mouse_up":
		_, err = run(ctx, "mouseup", "1")
	case "mouse_click":
		if err = move(); err != nil {
			return "", err
		}
		button := 1
		switch a.Button {
		case "right":
			button = 3
		case "middle":
			button = 2
		case "back":
			button = 8
		case "forward":
			button = 9
		}
		err = withKeys(func() error {
			_, err := run(ctx, "click", "--repeat", strconv.Itoa(a.Clicks), "--delay", "80", strconv.Itoa(button))
			return err
		})
	case "left_click_drag":
		if len(a.Path) < 2 {
			return "", errors.New("Drag path must contain at least two points.")
		}
		err = withKeys(func() (err error) {
			p := a.Path[0]
			if _, err = run(ctx, "mousemove", "--sync", strconv.Itoa(p.X), strconv.Itoa(p.Y)); err != nil {
				return err
			}
			if _, err = run(ctx, "mousedown", "1"); err != nil {
				return err
			}
			defer func() {
				_, up := run(context.Background(), "mouseup", "1")
				if up != nil {
					err = up
				}
			}()
			for _, p := range a.Path[1:] {
				if _, err = run(ctx, "mousemove", "--sync", strconv.Itoa(p.X), strconv.Itoa(p.Y)); err != nil {
					return err
				}
			}
			return nil
		})
	case "scroll":
		if err = move(); err != nil {
			return "", err
		}
		err = withKeys(func() error {
			for i, amount := range []*int{a.ScrollY, a.ScrollX} {
				if amount == nil || *amount == 0 {
					continue
				}
				button := 5 + i*2
				n := *amount
				if n < 0 {
					button--
					n = -n
				}
				if _, err := run(ctx, "click", "--repeat", strconv.Itoa(n), strconv.Itoa(button)); err != nil {
					return err
				}
			}
			return nil
		})
	case "key":
		_, err = run(ctx, "key", "--", strings.Join(a.Keys, "+"))
	case "hold_key":
		err = withKeys(func() error {
			duration := 0.0
			if a.Duration != nil {
				duration = *a.Duration
			}
			return waitComputer(ctx, time.Duration(duration*float64(time.Second)))
		})
	case "type":
		text := ""
		if a.Text != nil {
			text = *a.Text
		}
		_, err = run(ctx, "type", "--delay", "1", "--", text)
	}
	return "", err
}

func (t *ComputerUseTool) computerScreenshot(ctx context.Context, region []int) (ToolResult, error) {
	data, width, height, err := t.captureComputerScreenshot(ctx)
	if err != nil {
		return ToolResult{}, err
	}
	image, err := images.ProcessScreenshot(ctx, data, images.ScreenshotOptions{ScreenWidth: width, ScreenHeight: height, MaxWidth: MaxScreenshotWidth, MaxHeight: MaxScreenshotHeight, Region: region, CoordinateScaleX: t.scaleX, CoordinateScaleY: t.scaleY})
	if err != nil {
		return ToolResult{}, err
	}
	if len(region) == 0 {
		t.scaleX = float64(image.ScreenWidth) / float64(image.Width)
		t.scaleY = float64(image.ScreenHeight) / float64(image.Height)
	}
	output := fmt.Sprintf("Screenshot %dx%d. Use this coordinate space for subsequent actions.", image.Width, image.Height)
	if len(region) > 0 {
		parts := make([]string, len(region))
		for i, n := range region {
			parts[i] = strconv.Itoa(n)
		}
		output = "Zoomed screenshot of [" + strings.Join(parts, ", ") + "]."
	}
	return ToolResult{Output: output, ContentBlocks: []map[string]any{{"type": "image", "source": map[string]any{"type": "base64", "media_type": string(image.MediaType), "data": image.Data}}}}, nil
}
func (t *ComputerUseTool) captureComputerScreenshot(ctx context.Context) ([]byte, int, int, error) {
	dir, err := os.MkdirTemp("", "yukino-computer-")
	if err != nil {
		return nil, 0, 0, err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "screenshot.png")
	read := func(size string) ([]byte, int, int, error) {
		width, height := 0, 0
		var w, h float64
		if _, err := fmt.Sscanf(strings.TrimSpace(size), "%f,%f", &w, &h); err == nil {
			if w > 0 && w < float64(int(^uint(0)>>1)) {
				width = int(w)
			}
			if h > 0 && h < float64(int(^uint(0)>>1)) {
				height = int(h)
			}
		}
		data, err := os.ReadFile(path)
		return data, width, height, err
	}
	switch t.platform {
	case "darwin":
		if _, err = t.runComputerChecked(ctx, "/usr/sbin/screencapture", []string{"-x", "-m", "-t", "png", path}, ComputerCommandOptions{}); err != nil {
			return nil, 0, 0, err
		}
		size, _ := t.runMacComputerPayload(ctx, map[string]string{"action": "screen_size"}, ComputerCommandTimeout)
		return read(size)
	case "win32":
		size, err := t.runComputerChecked(ctx, "powershell.exe", []string{"-NoProfile", "-NonInteractive", "-Sta", "-Command", computerAsset("screenshot.ps1")}, ComputerCommandOptions{Env: map[string]string{"YUKINO_SCREENSHOT_PATH": path}})
		if err != nil {
			return nil, 0, 0, err
		}
		return read(size)
	case "linux":
		backends := []struct {
			command string
			args    []string
		}{{"gnome-screenshot", []string{"-f", path}}, {"scrot", []string{path}}, {"import", []string{"-window", "root", path}}}
		lastError := "No screenshot backend succeeded."
		for _, backend := range backends {
			_, err := t.runComputerChecked(ctx, backend.command, backend.args, ComputerCommandOptions{})
			if err == nil {
				data, err := os.ReadFile(path)
				if err == nil {
					return data, 0, 0, nil
				}
				lastError = err.Error()
			} else {
				lastError = err.Error()
			}
		}
		return nil, 0, 0, errors.New(lastError + " Install gnome-screenshot, scrot, or ImageMagick; xdotool is required for input control.")
	default:
		return nil, 0, 0, fmt.Errorf("ComputerUse is not supported on %s.", t.platform)
	}
}
