package hooks

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/logger"
)

var log = logger.CreateChildLogger("hooks")

const hookTimeout = HookTimeoutMS * time.Millisecond

type EventName string

const (
	EventSessionStart EventName = "session_start"
	EventSessionEnd   EventName = "session_end"
	EventTurnStart    EventName = "turn_start"
	EventTurnEnd      EventName = "turn_end"
	EventPreSend      EventName = "pre_send"
	EventPostReceive  EventName = "post_receive"
	EventPreToolUse   EventName = "pre_tool_use"
	EventPostToolUse  EventName = "post_tool_use"
	EventShutdown     EventName = "shutdown"
)

type HookContext struct {
	Event    EventName
	ToolName string
	Args     map[string]any
	FilePath string
	Message  string
}

// MarshalJSON mirrors JSON.stringify of the reference HookContext: optionals
// are omitted only when the reference leaves them undefined, which depends on
// the event that built the context.
func (c HookContext) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteString(`{"event":`)
	writeJSONValue(&b, string(c.Event))
	if c.ToolName != "" {
		b.WriteString(`,"toolName":`)
		writeJSONValue(&b, c.ToolName)
	}
	if c.Args != nil {
		b.WriteString(`,"args":`)
		writeJSONValue(&b, c.Args)
	}
	if c.Event == EventPreToolUse || c.Event == EventPostToolUse {
		b.WriteString(`,"filePath":`)
		writeJSONValue(&b, c.FilePath)
	}
	if c.Message != "" || c.Event == EventPostToolUse {
		b.WriteString(`,"message":`)
		writeJSONValue(&b, c.Message)
	}
	b.WriteString("}")
	return b.Bytes(), nil
}

func writeJSONValue(b *bytes.Buffer, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		b.WriteString("null")
		return
	}
	b.Write(data)
}

type HookResult struct {
	Output  string
	Success bool
	Reject  bool
}

type HookRuntimeOptions struct {
	Cwd   string
	Abort context.Context
}

type AgentRunner func(prompt string, ctx HookContext) (string, error)

type Engine struct {
	mu            sync.Mutex
	hooks         []config.HookConfig
	notifications []string
	firedOnce     map[string]bool
	AgentRunner   AgentRunner
}

func NewEngine(hooks []config.HookConfig) *Engine {
	return &Engine{hooks: hooks, firedOnce: map[string]bool{}}
}

var validEventNames = map[EventName]bool{
	EventSessionStart: true,
	EventSessionEnd:   true,
	EventTurnStart:    true,
	EventTurnEnd:      true,
	EventPreSend:      true,
	EventPostReceive:  true,
	EventPreToolUse:   true,
	EventPostToolUse:  true,
	EventShutdown:     true,
}

func Validate(hooks []config.HookConfig) error {
	validActions := map[string]bool{"command": true, "prompt": true, "http": true, "agent": true}
	var errs []string
	for i, h := range hooks {
		label := fmt.Sprintf("hook[%d]", i)
		if h.ID != "" {
			label = fmt.Sprintf("hook[%d] (id=%q)", i, h.ID)
		}
		if h.Event == "" {
			errs = append(errs, label+": event is required")
		} else if !validEventNames[EventName(h.Event)] {
			errs = append(errs, fmt.Sprintf("%s: invalid event '%s'", label, h.Event))
		}
		if h.Action.Type == "" {
			errs = append(errs, label+": action.type is required")
		} else if !validActions[h.Action.Type] {
			errs = append(errs, fmt.Sprintf("%s: invalid action type '%s'", label, h.Action.Type))
		} else {
			switch h.Action.Type {
			case "command":
				if strings.TrimSpace(h.Action.Command) == "" {
					errs = append(errs, fmt.Sprintf("%s: action.command must be non-empty for type \"command\"", label))
				}
			case "prompt":
				if strings.TrimSpace(h.Action.Prompt) == "" {
					errs = append(errs, fmt.Sprintf("%s: action.prompt must be non-empty for type \"prompt\"", label))
				}
			case "http":
				if strings.TrimSpace(h.Action.URL) == "" {
					errs = append(errs, fmt.Sprintf("%s: action.url must be non-empty for type \"http\"", label))
				}
			case "agent":
				if strings.TrimSpace(h.Action.Prompt) == "" && strings.TrimSpace(h.Action.Command) == "" {
					errs = append(errs, fmt.Sprintf("%s: action.prompt (or action.command) must be non-empty for type \"agent\"", label))
				}
				// No host registers an agent runner today; accepting the config
				// would only defer the failure to runtime, where the default
				// on_error:"ignore" swallows it. Reject it here instead.
				errs = append(errs, fmt.Sprintf("%s: action.type \"agent\" is not supported yet — use \"command\" or \"prompt\" instead", label))
			}
		}
		// reject and async are mutually exclusive: async hook results cannot
		// synchronously intercept.
		if h.Reject && h.Async {
			errs = append(errs, label+": reject and async are mutually exclusive")
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

// Fire runs every hook registered for event. Once-slots are claimed before
// execution and released again when execution fails — a once-hook that errored
// has not "fired", and the next matching event should retry it.
func (e *Engine) Fire(event EventName, ctx HookContext, options HookRuntimeOptions) []HookResult {
	var results []HookResult
	for index, hook := range e.snapshotHooks() {
		if options.Abort != nil && options.Abort.Err() != nil {
			break
		}
		if hook.Event != string(event) {
			continue
		}
		if hook.Condition != "" {
			matched, err := evaluateCondition(hook.Condition, ctx)
			if err != nil {
				log.Error(map[string]any{"err": err, "condition": hook.Condition}, "hook condition evaluation failed")
			}
			if err != nil || !matched {
				continue
			}
		}
		var onceKey string
		if hook.Once {
			if hook.ID == "" {
				onceKey = fmt.Sprintf("index:%d", index)
			} else {
				onceKey = "id:" + hook.ID
			}
			e.mu.Lock()
			if e.firedOnce[onceKey] {
				e.mu.Unlock()
				continue
			}
			e.firedOnce[onceKey] = true
			e.mu.Unlock()
		}
		if hook.Async {
			go func(hook config.HookConfig, onceKey string) {
				result, err := e.executeAction(hook, ctx, options)
				if err != nil {
					log.Error(map[string]any{"err": err}, "hooks operation failed")
					if onceKey != "" {
						e.mu.Lock()
						delete(e.firedOnce, onceKey)
						e.mu.Unlock()
					}
					if hook.OnError != "" && hook.OnError != "ignore" {
						e.RecordNotification("Async hook error: " + err.Error())
					}
					return
				}
				e.RecordNotification(result.Output)
			}(hook, onceKey)
			continue
		}
		result, err := e.executeAction(hook, ctx, options)
		if err != nil {
			log.Error(map[string]any{"err": err}, "hooks operation failed")
			if onceKey != "" {
				e.mu.Lock()
				delete(e.firedOnce, onceKey)
				e.mu.Unlock()
			}
			onError := hook.OnError
			if onError == "" {
				onError = "ignore"
			}
			switch onError {
			case "fail":
				results = append(results, HookResult{Output: "Hook error: " + err.Error(), Success: false})
			case "reject":
				results = append(results, HookResult{Output: "Hook error (rejecting): " + err.Error(), Success: false, Reject: true})
				if event == EventPreToolUse {
					return results
				}
			}
			continue
		}
		results = append(results, result)
		if result.Reject && event == EventPreToolUse {
			break
		}
	}
	return results
}

func (e *Engine) FirePreToolHooks(toolName string, args map[string]any, options HookRuntimeOptions) (rejected bool, reason string) {
	filePath := ""
	if v, ok := args["file_path"].(string); ok {
		filePath = v
	} else if v, ok := args["path"].(string); ok {
		filePath = v
	}
	ctx := HookContext{Event: EventPreToolUse, ToolName: toolName, Args: args, FilePath: filePath}
	for _, r := range e.Fire(EventPreToolUse, ctx, options) {
		if r.Reject {
			return true, r.Output
		}
		e.RecordNotification(r.Output)
	}
	return false, ""
}

// RecordNotification queues a message produced by a hook so the agent loop can
// surface it as a system reminder on the next turn.
func (e *Engine) RecordNotification(message string) {
	if strings.TrimSpace(message) == "" {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.notifications = append(e.notifications, message)
}

func (e *Engine) DrainNotifications() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := e.notifications
	e.notifications = nil
	return out
}

func (e *Engine) snapshotHooks() []config.HookConfig {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]config.HookConfig, len(e.hooks))
	copy(out, e.hooks)
	return out
}

func (e *Engine) executeAction(hook config.HookConfig, ctx HookContext, options HookRuntimeOptions) (HookResult, error) {
	switch hook.Action.Type {
	case "command":
		return runCommand(hook, ctx, options)
	case "prompt":
		return HookResult{Output: hook.Action.Prompt, Success: true, Reject: hook.Reject}, nil
	case "http":
		return runHTTP(hook, ctx, options)
	case "agent":
		return e.runAgent(hook, ctx)
	default:
		return HookResult{Success: true}, nil
	}
}

func (e *Engine) runAgent(hook config.HookConfig, ctx HookContext) (HookResult, error) {
	if e.AgentRunner == nil {
		return HookResult{}, errors.New("agent-type hook configured but no AgentRunner registered")
	}
	prompt := hook.Action.Prompt
	if prompt == "" {
		prompt = hook.Action.Command
	}
	output, err := e.AgentRunner(prompt, ctx)
	if err != nil {
		return HookResult{}, err
	}
	return HookResult{Output: output, Success: true, Reject: hook.Reject}, nil
}

func runCommand(hook config.HookConfig, ctx HookContext, options HookRuntimeOptions) (HookResult, error) {
	parent := context.Background()
	if options.Abort != nil {
		parent = options.Abort
	}
	execCtx, cancel := context.WithTimeout(parent, hookTimeout)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		shell := os.Getenv("ComSpec")
		if shell == "" {
			shell = "cmd.exe"
		}
		cmd = exec.CommandContext(execCtx, shell, "/d", "/s", "/c", hook.Action.Command)
	} else {
		cmd = exec.CommandContext(execCtx, "bash", "-c", hook.Action.Command)
	}
	cmd.Dir = options.Cwd
	cmd.Env = append(cmd.Environ(),
		"YUKINO_EVENT="+string(ctx.Event),
		"YUKINO_TOOL="+ctx.ToolName,
		"YUKINO_FILE_PATH="+ctx.FilePath,
	)
	stdout := &cappedBuffer{limit: HookMaxBufferBytes, label: "stdout", cancel: cancel}
	stderr := &cappedBuffer{limit: HookMaxBufferBytes, label: "stderr", cancel: cancel}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		if stdout.exceeded.Load() {
			return HookResult{}, errors.New("stdout maxBuffer length exceeded")
		}
		if stderr.exceeded.Load() {
			return HookResult{}, errors.New("stderr maxBuffer length exceeded")
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return HookResult{}, fmt.Errorf("Command failed: %s\n%s", hook.Action.Command, stderr.String())
		}
		return HookResult{}, err
	}
	return HookResult{Output: strings.TrimSpace(stdout.String()), Success: true, Reject: hook.Reject}, nil
}

// cappedBuffer mirrors Node's maxBuffer: output past the cap fails the exec
// instead of being silently truncated, and the child is killed.
type cappedBuffer struct {
	buf      bytes.Buffer
	limit    int
	label    string
	cancel   context.CancelFunc
	exceeded atomic.Bool
}

func (w *cappedBuffer) Write(p []byte) (int, error) {
	if w.buf.Len()+len(p) > w.limit {
		w.exceeded.Store(true)
		w.cancel()
		return 0, fmt.Errorf("%s maxBuffer length exceeded", w.label)
	}
	return w.buf.Write(p)
}

func (w *cappedBuffer) String() string { return w.buf.String() }

func runHTTP(hook config.HookConfig, ctx HookContext, options HookRuntimeOptions) (HookResult, error) {
	method := strings.ToUpper(hook.Action.Method)
	if method == "" {
		method = "POST"
	}
	var body io.Reader
	if method != "GET" && method != "HEAD" {
		data, err := json.Marshal(ctx)
		if err != nil {
			return HookResult{}, err
		}
		body = bytes.NewReader(data)
	}
	parent := context.Background()
	if options.Abort != nil {
		parent = options.Abort
	}
	reqCtx, cancel := context.WithTimeout(parent, hookTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, method, hook.Action.URL, body)
	if err != nil {
		return HookResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return HookResult{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return HookResult{}, fmt.Errorf("HTTP hook failed with status %d", resp.StatusCode)
	}
	text, err := io.ReadAll(resp.Body)
	if err != nil {
		return HookResult{}, err
	}
	return HookResult{Output: string(text), Success: true, Reject: hook.Reject}, nil
}
