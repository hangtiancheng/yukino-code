package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestComputerUseReferenceActions(t *testing.T) {
	data, err := os.ReadFile("testdata/computer-expected.json")
	if err != nil {
		t.Fatal(err)
	}
	type call struct {
		Command string   `json:"command"`
		Args    []string `json:"args"`
	}
	var fixtures struct {
		Cases []struct {
			Input  map[string]any
			Calls  []call
			Result struct {
				Output  string
				IsError bool
			}
		}
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, c := range fixtures.Cases {
		var calls []call
		tool := NewComputerUseTool(ComputerUseOptions{Platform: "linux", RunCommand: func(_ context.Context, command string, args []string, _ ComputerCommandOptions) (ComputerCommandResult, error) {
			calls = append(calls, call{command, args})
			var output []byte
			if len(args) > 0 && args[0] == "getmouselocation" {
				output = []byte("X=40\nY=60\n")
			}
			return ComputerCommandResult{Stdout: output}, nil
		}})
		result := tool.Execute(context.Background(), c.Input)
		if result.Output != c.Result.Output || result.IsError != c.Result.IsError {
			t.Errorf("%v: got %+v, want %+v", c.Input, result, c.Result)
		}
		if len(calls) != len(c.Calls) || len(calls) > 0 && !reflect.DeepEqual(calls, c.Calls) {
			t.Errorf("%v: calls %+v, want %+v", c.Input, calls, c.Calls)
		}
	}
}

func TestComputerUseScreenshotScalingZoomAndBatch(t *testing.T) {
	var imageBytes bytes.Buffer
	if err := png.Encode(&imageBytes, image.NewRGBA(image.Rect(0, 0, 2732, 1800))); err != nil {
		t.Fatal(err)
	}
	var clicks [][]string
	tool := NewComputerUseTool(ComputerUseOptions{Platform: "linux", RunCommand: func(_ context.Context, command string, args []string, _ ComputerCommandOptions) (ComputerCommandResult, error) {
		if command == "gnome-screenshot" {
			if err := os.WriteFile(args[1], imageBytes.Bytes(), 0600); err != nil {
				t.Fatal(err)
			}
		} else if command == "xdotool" {
			clicks = append(clicks, append([]string(nil), args...))
		}
		return ComputerCommandResult{}, nil
	}})
	result := tool.Execute(context.Background(), map[string]any{"action": "screenshot"})
	if result.IsError || len(result.ContentBlocks) != 1 || !strings.Contains(result.Output, "1366x900") {
		t.Fatalf("screenshot %+v", result)
	}
	result = tool.Execute(context.Background(), map[string]any{"action": "left_click", "coordinate": []int{10, 20}})
	if result.IsError || !reflect.DeepEqual(clicks[0], []string{"mousemove", "--sync", "20", "40"}) {
		t.Fatalf("coordinates not scaled: %+v %v", result, clicks)
	}
	result = tool.Execute(context.Background(), map[string]any{"action": "zoom", "region": []int{0, 0, 100, 100}})
	if result.IsError || tool.scaleX != 2 || tool.scaleY != 2 {
		t.Fatalf("zoom changed coordinate space: %+v", result)
	}
	result = tool.Execute(context.Background(), map[string]any{"actions": []any{map[string]any{"type": "click", "x": 10, "y": 20}, map[string]any{"type": "type", "text": "hello"}}, "status": "completed", "pendingSafetyChecks": []any{map[string]any{"id": "check-1"}}})
	if result.IsError || len(result.ContentBlocks) != 1 || !strings.Contains(result.Output, "Executed 2 action(s): click, type. Status: completed. Acknowledged safety checks: check-1.") {
		t.Fatalf("batch %+v", result)
	}
}

func TestComputerUseHelperReuseAndRetry(t *testing.T) {
	for _, platform := range []string{"darwin", "win32"} {
		t.Run(platform, func(t *testing.T) {
			compiled, calls := 0, 0
			tool := NewComputerUseTool(ComputerUseOptions{Platform: platform, RunCommand: func(_ context.Context, command string, args []string, options ComputerCommandOptions) (ComputerCommandResult, error) {
				calls++
				if options.Timeout == 120*time.Second {
					compiled++
					if compiled == 1 {
						return ComputerCommandResult{Code: 1, Stderr: "compile failed"}, nil
					}
				}
				return ComputerCommandResult{}, nil
			}})
			input := map[string]any{"action": "mouse_move", "coordinate": []int{10, 20}}
			if result := tool.Execute(context.Background(), input); !result.IsError || !strings.Contains(result.Output, "compile failed") {
				t.Fatal(result)
			}
			for range 2 {
				if result := tool.Execute(context.Background(), input); result.IsError {
					t.Fatal(result)
				}
			}
			if compiled != 2 || calls != 4 {
				t.Fatalf("compiled=%d calls=%d", compiled, calls)
			}
		})
	}
	RunExitCleanups()
}

func TestComputerUseValidationAndExclusiveLock(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	tool := NewComputerUseTool(ComputerUseOptions{Platform: "linux", RunCommand: func(context.Context, string, []string, ComputerCommandOptions) (ComputerCommandResult, error) {
		close(entered)
		<-release
		return ComputerCommandResult{}, nil
	}})
	for _, input := range []map[string]any{{"action": "unknown"}, {"action": "key", "keys": []string{""}}, {"action": "wait", "duration": 61}, {"actions": []any{}}, {"action": "mouse_move", "coordinate": []int{-1, 0}}, {"action": "type", "text": strings.Repeat("👩", 5001)}} {
		if result := tool.Execute(context.Background(), input); !result.IsError {
			t.Fatalf("accepted invalid input %v", input)
		}
	}
	done := make(chan ToolResult, 1)
	go func() { done <- tool.Execute(context.Background(), map[string]any{"action": "left_mouse_down"}) }()
	<-entered
	second := NewComputerUseTool(ComputerUseOptions{Platform: "linux"}).Execute(context.Background(), map[string]any{"action": "wait", "duration": 0})
	if !second.IsError || second.Output != ComputerLockedError {
		t.Fatalf("lock %+v", second)
	}
	close(release)
	if result := <-done; result.IsError {
		t.Fatal(result)
	}
}

func TestComputerCommandResourceLimits(t *testing.T) {
	if _, err := runComputerCommand(context.Background(), "yukino-command-that-does-not-exist", nil, ComputerCommandOptions{}); err == nil || !strings.Contains(err.Error(), "not installed") {
		t.Fatalf("missing command %v", err)
	}
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("POSIX command runner checks")
	}
	if _, err := runComputerCommand(context.Background(), "/bin/sh", []string{"-c", "printf 1234567890"}, ComputerCommandOptions{MaxOutputBytes: 5}); err == nil || !strings.Contains(err.Error(), "5 byte output limit") {
		t.Fatalf("output limit %v", err)
	}
	if _, err := runComputerCommand(context.Background(), "/bin/sh", []string{"-c", "sleep 1"}, ComputerCommandOptions{Timeout: 20 * time.Millisecond}); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("timeout %v", err)
	}
}
