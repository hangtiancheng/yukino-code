package tools

import (
	"context"
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/yukino-js/yukino/yukino/internal/sandbox"
)

// backgroundRequest is the Ctrl+B handshake between backgroundForeground and
// the command's select loop: the loop acknowledges whether the command was
// actually moved to the background.
type backgroundRequest struct {
	reason string
	ack    chan bool
}

type shellState struct {
	mu         sync.Mutex
	next       uint64
	foreground map[uint64]chan backgroundRequest
}

func (s *shellState) hasForeground() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.foreground) > 0
}

// backgroundForeground moves every running foreground command to the
// background, mirroring the reference's synchronous backgroundForegroundTasks:
// each request waits for the command loop's acknowledgement, successfully
// backgrounded entries are dropped before returning, and the count reflects
// commands actually backgrounded (a command that finished in the meantime is
// acknowledged false by the loop's exit path instead of being counted).
func (s *shellState) backgroundForeground() int {
	s.mu.Lock()
	type pendingRequest struct {
		id  uint64
		ack chan bool
	}
	var requests []pendingRequest
	for id, request := range s.foreground {
		ack := make(chan bool, 1)
		select {
		case request <- backgroundRequest{reason: "user", ack: ack}:
			requests = append(requests, pendingRequest{id: id, ack: ack})
		default:
		}
	}
	s.mu.Unlock()
	count := 0
	for _, entry := range requests {
		if <-entry.ack {
			count++
			s.mu.Lock()
			delete(s.foreground, entry.id)
			s.mu.Unlock()
		}
	}
	return count
}

type BashTool struct {
	WorkDir         string
	Sandbox         sandbox.Sandbox
	SandboxRequired bool
	SandboxConfig   sandbox.Config
	TaskManager     BackgroundTaskManager
	state           shellState
}

func (t *BashTool) Name() string           { return "Bash" }
func (t *BashTool) Description() string    { return BashDescription }
func (t *BashTool) Category() ToolCategory { return CategoryCommand }
func (t *BashTool) IsConcurrencySafe(args map[string]any) bool {
	command, ok := args["command"].(string)
	return ok && IsSafeCommand(command)
}
func (t *BashTool) HasForegroundTasks() bool       { return t.state.hasForeground() }
func (t *BashTool) BackgroundForegroundTasks() int { return t.state.backgroundForeground() }
func (t *BashTool) Schema() map[string]any {
	return shellSchema(t.Name(), t.Description(), "Shell command to execute", BashBackgroundDescription, t.TaskManager != nil)
}
func shellSchema(name, description, commandDescription, backgroundDescription string, background bool) map[string]any {
	properties := map[string]any{"command": map[string]any{"type": "string", "description": commandDescription}, "timeout": map[string]any{"type": "integer", "description": "Timeout in seconds (max 600)", "default": 120}}
	if background {
		properties["run_in_background"] = map[string]any{"type": "boolean", "default": false, "description": "Run the command in the background. Returns a task ID immediately; the result arrives later as a task notification."}
		description += "\n" + backgroundDescription
	}
	return map[string]any{"name": name, "description": description, "input_schema": map[string]any{"type": "object", "properties": properties, "required": []string{"command"}}}
}
func (t *BashTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	return executeShell(ctx, t.Name(), "$ ", args, t.TaskManager, &t.state, t.WorkDir, func(command, cwd, outputDirectory string) (sandbox.PreparedCommand, error) {
		prepared := sandbox.PreparedCommand{Executable: "bash", Args: []string{"-c", command}}
		if !t.SandboxRequired && t.Sandbox == nil {
			return prepared, nil
		}
		if t.Sandbox == nil {
			return prepared, fmt.Errorf("sandbox is enabled but unavailable; command was not executed")
		}
		if !t.Sandbox.Available() {
			return prepared, fmt.Errorf("%s sandbox is unavailable; command was not executed", t.Sandbox.Implementation())
		}
		cfg := t.SandboxConfig
		runtime, _ := RuntimeContext(ctx)
		if runtime.Worktrees != nil {
			cfg.AllowWrite = runtime.Worktrees.SandboxWriteRoots(cfg.AllowWrite)
		}
		cfg.AllowWrite = append(append([]string(nil), cfg.AllowWrite...), outputDirectory)
		prepared, err := t.Sandbox.Prepare(ctx, command, cfg, cwd)
		if err != nil {
			return prepared, err
		}
		if runtime.Worktrees != nil {
			if dir := runtime.Worktrees.SandboxTempDirectory(); dir != "" {
				prepared.Env = append(append(os.Environ(), prepared.Env...), "TMPDIR="+dir, "TMP="+dir, "TEMP="+dir)
			}
		}
		return prepared, nil
	})
}

// numericLiteral mirrors the reference NUMERIC_LITERAL: timeout strings are
// parsed only when they are plain numeric literals.
var numericLiteral = regexp.MustCompile(`^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$`)

// shellTimeout mirrors intArg(args, "timeout", DEFAULT_TIMEOUT) plus the
// reference validation: numbers and numeric-literal strings are truncated,
// non-finite or unrecognized values fall back to the default, and a truncated
// value <= 0 is invalid.
func shellTimeout(args map[string]any) (int, bool) {
	value, ok := args["timeout"]
	if !ok {
		return 120, true
	}
	var number float64
	switch n := value.(type) {
	case float64:
		number = n
	case int:
		number = float64(n)
	case int64:
		number = float64(n)
	case string:
		trimmed := strings.TrimSpace(n)
		if !numericLiteral.MatchString(trimmed) {
			return 120, true
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil {
			return 120, true
		}
		number = parsed
	default:
		return 120, true
	}
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return 120, true
	}
	truncated := math.Trunc(number)
	if truncated <= 0 {
		return 0, false
	}
	return min(600, int(truncated)), true
}

func (t *BashTool) Dispose() error {
	var err error
	if disposable, ok := t.Sandbox.(interface{ Dispose() error }); ok {
		err = disposable.Dispose()
	}
	t.Sandbox = nil
	return err
}
