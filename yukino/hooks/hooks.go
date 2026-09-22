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

package hooks

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/hangtiancheng/yukino-code/yukino/logger"
)

// log mirrors the TS module-scoped child logger
// (createChildLogger({module: "hooks"}), hooks/index.ts).
var log = logger.CreateChildLogger("hooks")

// defaultHookTimeout is the cap applied when a hook config doesn't set its own
// `timeout`. Matches the fixed 30s command timeout of the TS reference
// (execHookAsync, hooks/index.ts).
const defaultHookTimeout = 30 * time.Second

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

type ActionType string

const (
	ActionCommand ActionType = "command"
	ActionPrompt  ActionType = "prompt"
	ActionHTTP    ActionType = "http"
	ActionAgent   ActionType = "agent"
)

type Action struct {
	Type    ActionType        `yaml:"type"`
	Command string            `yaml:"command"`
	Prompt  string            `yaml:"prompt"`
	URL     string            `yaml:"url"`
	Method  string            `yaml:"method"`
	Headers map[string]string `yaml:"headers"`
	Body    string            `yaml:"body"`
	Timeout time.Duration     `yaml:"timeout"`
}

type Hook struct {
	ID        string    `yaml:"id"`
	Event     EventName `yaml:"event"`
	Condition string    `yaml:"condition"`
	Action    Action    `yaml:"action"`
	Reject    bool      `yaml:"reject"`
	Once      bool      `yaml:"once"`
	Async     bool      `yaml:"async"`
	// OnError controls behaviour when the action fails.
	//   "fail"   — propagate the error (default for blocking hooks)
	//   "ignore" — log and continue
	//   "reject" — treat hook failure as a reject (pre_tool_use only)
	OnError string `yaml:"on_error"`

	// idSet records that `id` was present in the decoded YAML document, even
	// when its value is the empty string. The TS once-key checks presence
	// (`hook.id === undefined`), not truthiness, so `id: ""` is a value that
	// shares one once-key across hooks. Hooks built programmatically keep
	// idSet=false; a non-empty ID is treated as present regardless.
	idSet bool
}

// UnmarshalYAML decodes the hook fields and records whether the `id` key was
// present in the document (see Hook.idSet).
func (h *Hook) UnmarshalYAML(node *yaml.Node) error {
	type hookFields Hook
	var fields hookFields
	if err := node.Decode(&fields); err != nil {
		return err
	}
	*h = Hook(fields)
	if node.Kind == yaml.MappingNode {
		for i := 0; i+1 < len(node.Content); i += 2 {
			if node.Content[i].Value == "id" {
				h.idSet = true
				break
			}
		}
	}
	return nil
}

// hasID mirrors the TS `hook.id !== undefined` presence check used for the
// once-key.
func (h Hook) hasID() bool {
	return h.idSet || h.ID != ""
}

type HookContext struct {
	EventName EventName
	ToolName  string
	ToolArgs  map[string]any
	FilePath  string
	Message   string
}

type HookResult struct {
	HookID  string
	Output  string
	Success bool
	Reject  bool
}

type Engine struct {
	mu            sync.Mutex
	hooks         []Hook
	notifications []HookResult
	fired         map[string]bool // once-keys that fired: `id:<id>` or `index:<i>`
	// AgentRunner executes agent-type hooks. Optional — when nil, agent hooks
	// return a clear "no runner registered" error rather than silently failing.
	AgentRunner func(prompt string, ctx HookContext) (string, error)
}

func NewEngine() *Engine {
	return &Engine{fired: make(map[string]bool)}
}

// validEventNames is the whitelist of event names accepted by Validate.
// Sourced from the EventName constants above so adding a new event is a
// single-line change there, not two.
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

// Validate checks a slice of hooks for configuration mistakes that would
// otherwise surface as silent misbehaviour at run time. Each action type has
// its own required fields; timeout must be non-negative.
//
// All errors are aggregated into a single "; "-joined message (TS: validate)
// so a single call surfaces every problem at once. Each error is prefixed
// with the hook id (or index when id is empty) and the offending field.
func Validate(hooks []Hook) error {
	var errs []string
	for i, h := range hooks {
		label := h.ID
		if label == "" {
			label = fmt.Sprintf("hook[%d]", i)
		} else {
			label = fmt.Sprintf("hook[%d] (id=%q)", i, h.ID)
		}

		// TS: missing event and unknown event are reported differently.
		if h.Event == "" {
			errs = append(errs, fmt.Sprintf("%s: event is required", label))
		} else if !validEventNames[h.Event] {
			errs = append(errs, fmt.Sprintf("%s: invalid event '%s'", label, h.Event))
		}

		if h.Action.Timeout < 0 {
			errs = append(errs, fmt.Sprintf("%s: action.timeout must be >= 0 (got %s)", label, h.Action.Timeout))
		}

		switch h.Action.Type {
		case ActionCommand:
			if strings.TrimSpace(h.Action.Command) == "" {
				errs = append(errs, fmt.Sprintf("%s: action.command must be non-empty for type %q", label, h.Action.Type))
			}
		case ActionPrompt:
			if strings.TrimSpace(h.Action.Prompt) == "" {
				errs = append(errs, fmt.Sprintf("%s: action.prompt must be non-empty for type %q", label, h.Action.Type))
			}
		case ActionHTTP:
			if strings.TrimSpace(h.Action.URL) == "" {
				errs = append(errs, fmt.Sprintf("%s: action.url must be non-empty for type %q", label, h.Action.Type))
			}
		case ActionAgent:
			if strings.TrimSpace(h.Action.Prompt) == "" && strings.TrimSpace(h.Action.Command) == "" {
				errs = append(errs, fmt.Sprintf("%s: action.prompt (or action.command) must be non-empty for type %q", label, h.Action.Type))
			}
		case "":
			errs = append(errs, fmt.Sprintf("%s: action.type is required", label))
		default:
			errs = append(errs, fmt.Sprintf("%s: invalid action type '%s'", label, h.Action.Type))
		}

		// reject and async are mutually exclusive: async hook results cannot
		// synchronously intercept (TS: validate).
		if h.Reject && h.Async {
			errs = append(errs, fmt.Sprintf("%s: reject and async are mutually exclusive", label))
		}
	}
	if len(errs) == 0 {
		return nil
	}
	// TS joins all problems with "; " into a single Error.
	return errors.New(strings.Join(errs, "; "))
}

func (e *Engine) LoadHooks(hooks []Hook) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.hooks = hooks
	e.fired = make(map[string]bool)
}

// RuntimeOptions carries per-invocation runtime context for hook execution
// (TS: HookRuntimeOptions): the working directory command hooks run in and
// the parent context their execution derives from (cancellation propagates).
type RuntimeOptions struct {
	WorkDir string
	Ctx     context.Context
}

func (e *Engine) RunHooks(ctx HookContext, opts RuntimeOptions) []HookResult {
	var results []HookResult
	for i, h := range e.snapshotHooks() {
		// TS fire(): stop scheduling further hooks once the run is aborted.
		if opts.Ctx != nil && opts.Ctx.Err() != nil {
			break
		}
		if h.Event != ctx.EventName {
			continue
		}
		if !e.shouldFire(i, h, ctx) {
			continue
		}
		if h.Async {
			// TS runs async hooks fully in the background: they never block the
			// caller and never produce a result entry. Success records the raw
			// output; failure always records "Async hook error: ..." regardless
			// of on_error (TS fire() async branch).
			go func(h Hook) {
				res := e.executeAction(h, ctx, opts)
				if res.Success {
					if strings.TrimSpace(res.Output) != "" {
						e.recordNotification(res)
					}
					return
				}
				e.recordNotification(HookResult{
					HookID: h.ID,
					Output: "Async hook error: " + res.Output,
				})
			}(h)
			continue
		}
		result := e.executeAction(h, ctx, opts)
		if result.Success {
			// TS fire() pushes successful results verbatim; the agent call
			// sites queue non-empty outputs into the notification queue
			// (`if (r.output) recordNotification(r.output)`), which the Go
			// host drains, so the recording happens here.
			if strings.TrimSpace(result.Output) != "" {
				e.recordNotification(result)
			}
			results = append(results, result)
			// TS fire(): a rejecting hook stops the loop for pre_tool_use.
			if result.Reject && ctx.EventName == EventPreToolUse {
				break
			}
			continue
		}
		// TS fire()'s catch logs every synchronous hook failure (the
		// action-level catch already logged once, so a failing command/
		// http/agent hook produces two entries, exactly like TS) and pushes a
		// transformed result only for on_error fail/reject — "ignore" (the
		// default) drops it.
		log.Error("hooks operation failed", "err", errors.New(result.Output))
		switch h.OnError {
		case "fail":
			transformed := HookResult{
				HookID: h.ID,
				Output: "Hook error: " + result.Output,
			}
			results = append(results, transformed)
			e.recordNotification(transformed)
		case "reject":
			transformed := HookResult{
				HookID: h.ID,
				Output: "Hook error (rejecting): " + result.Output,
				Reject: true,
			}
			results = append(results, transformed)
			e.recordNotification(transformed)
			if ctx.EventName == EventPreToolUse {
				return results
			}
		}
	}
	return results
}

// notificationFor mirrors the TS fire() handling of one action result: a
// successful action with output becomes a notification; a failure becomes one
// only when on_error asks for it (fail / reject), and “ignore” (the default)
// drops it silently.
func notificationFor(h Hook, result HookResult) *HookResult {
	if result.Success {
		if strings.TrimSpace(result.Output) == "" {
			return nil
		}
		return &result
	}
	switch h.OnError {
	case "fail":
		withPrefix := result
		withPrefix.Output = "Hook error: " + result.Output
		return &withPrefix
	case "reject":
		withPrefix := result
		withPrefix.Output = "Hook error (rejecting): " + result.Output
		withPrefix.Reject = true
		return &withPrefix
	default:
		return nil
	}
}

// RunPreToolHooks runs pre-tool-use hooks. Returns (rejected, message).
// Non-reject hooks still run for their side effects (notifications/HTTP/etc).
func (e *Engine) RunPreToolHooks(ctx HookContext, opts RuntimeOptions) (bool, string) {
	for i, h := range e.snapshotHooks() {
		// TS fire(): stop scheduling further hooks once the run is aborted.
		if opts.Ctx != nil && opts.Ctx.Err() != nil {
			break
		}
		if h.Event != EventPreToolUse {
			continue
		}
		if !e.shouldFire(i, h, ctx) {
			continue
		}
		if h.Async {
			// An async hook can never reject the call; it only observes. Its
			// failure notification bypasses the on_error policy (TS).
			go func(h Hook) {
				res := e.executeAction(h, ctx, opts)
				if res.Success {
					if strings.TrimSpace(res.Output) != "" {
						e.recordNotification(res)
					}
					return
				}
				e.recordNotification(HookResult{
					HookID: h.ID,
					Output: "Async hook error: " + res.Output,
				})
			}(h)
			continue
		}
		result := e.executeAction(h, ctx, opts)
		if !result.Success {
			// TS firePreToolHooks delegates to fire(), whose catch logs every
			// synchronous hook failure (the action-level catch logged first —
			// two entries per failure, exactly like TS).
			log.Error("hooks operation failed", "err", errors.New(result.Output))
		}
		// A hook may reject by config or by failing with on_error=reject. TS
		// returns the result output verbatim as the reason (even when empty).
		if h.Reject && result.Success {
			return true, result.Output
		}
		if !result.Success && h.OnError == "reject" {
			return true, "Hook error (rejecting): " + result.Output
		}
		if notification := notificationFor(h, result); notification != nil {
			e.recordNotification(*notification)
		}
	}
	return false, ""
}

func (e *Engine) shouldFire(index int, h Hook, ctx HookContext) bool {
	if h.Condition != "" && !evaluateCondition(h.Condition, ctx) {
		return false
	}
	if h.Once {
		// TS keys fired-once state by hook id presence (`hook.id === undefined`
		// → `index:N`, otherwise `id:<id>` — an explicit empty-string id is a
		// value and shares the `id:` key), so id-less once hooks still fire
		// exactly once each.
		key := fmt.Sprintf("index:%d", index)
		if h.hasID() {
			key = "id:" + h.ID
		}
		e.mu.Lock()
		defer e.mu.Unlock()
		if e.fired[key] {
			return false
		}
		e.fired[key] = true
	}
	return true
}

func (e *Engine) snapshotHooks() []Hook {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]Hook, len(e.hooks))
	copy(out, e.hooks)
	return out
}

func (e *Engine) recordNotification(r HookResult) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.notifications = append(e.notifications, r)
}

func (e *Engine) DrainNotifications() []HookResult {
	e.mu.Lock()
	defer e.mu.Unlock()
	n := e.notifications
	e.notifications = nil
	return n
}

// evaluateCondition mirrors the TS reference (evaluateCondition):
//   - leaf: `var == "value"`, `var != "value"`, `var =~ "regex"`, `var =* "glob"`
//   - bare tool-name shorthand: `Bash` is true when ctx.ToolName == "Bash"
//   - composite: `&&` binds tighter than `||` (OR of AND groups); operators
//     inside double quotes are not treated as splitters
//   - inverse: `!leaf`
//
// Unbalanced quotes make the whole condition false, same as the TS reference.
func evaluateCondition(condition string, ctx HookContext) bool {
	// Split into OR-groups of AND-parts, keeping quoted operators intact.
	groups := [][]string{{}}
	start := 0
	quoted := false
	for i := 0; i < len(condition); i++ {
		if condition[i] == '"' {
			quoted = !quoted
		}
		if quoted || i+1 >= len(condition) {
			continue
		}
		if op := condition[i : i+2]; op == "&&" || op == "||" {
			last := len(groups) - 1
			groups[last] = append(groups[last], condition[start:i])
			if op == "||" {
				groups = append(groups, []string{})
			}
			start = i + 2
			i++
		}
	}
	groups[len(groups)-1] = append(groups[len(groups)-1], condition[start:])
	if quoted {
		return false
	}
	for _, group := range groups {
		all := true
		for _, part := range group {
			if !evaluateSingleCondition(part, ctx) {
				all = false
				break
			}
		}
		if all {
			return true
		}
	}
	return false
}

var (
	// TS condition keys are `\w+`; anything else (including dotted legacy
	// spellings) simply does not match the comparison patterns.
	condEqRegex    = regexp.MustCompile(`^(\w+)\s*==\s*"([^"]*)"$`)
	condNeqRegex   = regexp.MustCompile(`^(\w+)\s*!=\s*"([^"]*)"$`)
	condRegexRegex = regexp.MustCompile(`^(\w+)\s*=~\s*"([^"]*)"$`)
	condGlobRegex  = regexp.MustCompile(`^(\w+)\s*=\*\s*"([^"]*)"$`)
	bareWordRegex  = regexp.MustCompile(`^\w+$`)
	globTokenRegex = regexp.MustCompile(`\*\*/|\*\*|\*|\?`)
)

// evaluateSingleCondition mirrors the TS reference of the same name. An
// invalid regex/glob evaluates to false instead of failing the hook.
func evaluateSingleCondition(expr string, ctx HookContext) bool {
	trimmed := strings.TrimSpace(expr)
	if strings.HasPrefix(trimmed, "!") {
		return !evaluateSingleCondition(trimmed[1:], ctx)
	}
	if m := condEqRegex.FindStringSubmatch(trimmed); m != nil {
		return resolveVar(m[1], ctx) == m[2]
	}
	if m := condNeqRegex.FindStringSubmatch(trimmed); m != nil {
		return resolveVar(m[1], ctx) != m[2]
	}
	if m := condRegexRegex.FindStringSubmatch(trimmed); m != nil {
		re, err := regexp.Compile(m[2])
		if err != nil {
			// TS catches the invalid RegExp, logs, and evaluates to false.
			log.Error("hooks operation failed", "err", err)
			return false
		}
		return re.MatchString(resolveVar(m[1], ctx))
	}
	if m := condGlobRegex.FindStringSubmatch(trimmed); m != nil {
		re, err := compileGlob(m[2])
		if err != nil {
			// TS catches the invalid RegExp, logs, and evaluates to false.
			log.Error("hooks operation failed", "err", err)
			return false
		}
		return re.MatchString(resolveVar(m[1], ctx))
	}
	// A bare tool name is the shorthand used by the example configuration.
	return bareWordRegex.MatchString(trimmed) && trimmed == ctx.ToolName
}

// compileGlob translates a TS-style glob into an anchored regex:
// `**/` → `(?:.*/)?`, `**` → `.*`, `*` → `[^/]*`, `?` → `[^/]`;
// every other character is quoted verbatim.
func compileGlob(pattern string) (*regexp.Regexp, error) {
	var sb strings.Builder
	last := 0
	for _, loc := range globTokenRegex.FindAllStringIndex(pattern, -1) {
		sb.WriteString(regexp.QuoteMeta(pattern[last:loc[0]]))
		switch pattern[loc[0]:loc[1]] {
		case "**/":
			sb.WriteString("(?:.*/)?")
		case "**":
			sb.WriteString(".*")
		case "*":
			sb.WriteString("[^/]*")
		case "?":
			sb.WriteString("[^/]")
		}
		last = loc[1]
	}
	sb.WriteString(regexp.QuoteMeta(pattern[last:]))
	return regexp.Compile("^" + sb.String() + "$")
}

// resolveVar maps a condition key to its context value (TS: getContextValue).
// Any other key is looked up literally in the tool args; non-string arg
// values resolve to "" exactly like TS strArg.
func resolveVar(name string, ctx HookContext) string {
	switch name {
	case "tool":
		return ctx.ToolName
	case "event":
		return string(ctx.EventName)
	case "file_path":
		return ctx.FilePath
	case "message":
		return ctx.Message
	}
	if v, ok := ctx.ToolArgs[name]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func (e *Engine) executeAction(h Hook, ctx HookContext, opts RuntimeOptions) HookResult {
	switch h.Action.Type {
	case ActionCommand:
		return runCommand(h, ctx, opts)
	case ActionPrompt:
		return HookResult{
			HookID:  h.ID,
			Output:  h.Action.Prompt,
			Success: true,
			Reject:  h.Reject,
		}
	case ActionHTTP:
		return runHTTP(h, ctx, opts)
	case ActionAgent:
		return e.runAgent(h, ctx)
	default:
		// TS executeAction default branch: an unknown action type is a
		// successful no-op with empty output (Validate rejects it at load).
		return HookResult{HookID: h.ID, Output: "", Success: true}
	}
}

// runAgent invokes the optional AgentRunner with the hook's Prompt as a
// one-shot prompt. Returns a clear error when no runner is configured so
// users learn they need to wire up agent-type hooks in their main entry.
func (e *Engine) runAgent(h Hook, ctx HookContext) HookResult {
	if e.AgentRunner == nil {
		return HookResult{
			HookID:  h.ID,
			Output:  "agent-type hook configured but no AgentRunner registered",
			Success: false,
			Reject:  h.Reject,
		}
	}
	prompt := h.Action.Prompt
	if prompt == "" {
		prompt = h.Action.Command
	}
	output, err := e.AgentRunner(prompt, ctx)
	if err != nil {
		// TS executeAction's agent catch logs before rethrowing. (The
		// missing-runner throw above sits OUTSIDE the TS try, so it is only
		// logged by the sync fire() catch, not here.)
		log.Error("hooks operation failed", "err", err)
		return HookResult{HookID: h.ID, Output: err.Error(), Success: false, Reject: h.Reject}
	}
	return HookResult{HookID: h.ID, Output: output, Success: true, Reject: h.Reject}
}

// maxHookOutputBytes mirrors the TS execHookAsync maxBuffer (10MB): output
// beyond the cap fails the hook instead of growing without bound.
const maxHookOutputBytes = 10 * 1024 * 1024

// cappedBuffer collects process output up to maxHookOutputBytes and reports
// overflow, mirroring Node's exec maxBuffer semantics.
type cappedBuffer struct {
	buf      []byte
	overflow bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if room := maxHookOutputBytes - len(b.buf); room > 0 {
		if len(p) > room {
			b.overflow = true
			p = p[:room]
		}
		b.buf = append(b.buf, p...)
	} else {
		b.overflow = true
	}
	return len(p), nil
}

func (b *cappedBuffer) String() string { return string(b.buf) }

func runCommand(h Hook, ctx HookContext, opts RuntimeOptions) HookResult {
	timeout := h.Action.Timeout
	if timeout <= 0 {
		timeout = defaultHookTimeout
	}
	parent := opts.Ctx
	if parent == nil {
		parent = context.Background()
	}
	execCtx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	cmd := exec.CommandContext(execCtx, "bash", "-c", h.Action.Command)
	if opts.WorkDir != "" {
		cmd.Dir = opts.WorkDir
	}
	cmd.Env = append(cmd.Environ(),
		"YUKINO_EVENT="+string(ctx.EventName),
		"YUKINO_TOOL="+ctx.ToolName,
		"YUKINO_FILE_PATH="+ctx.FilePath,
	)
	var stdout, stderr cappedBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()

	// A deadline kill flows through the generic error branch below on purpose:
	// Node's exec timeout produces the very same `Command failed: <cmd>\n
	// <stderr>` message, so a bespoke "timed out" wording would be a Go-only
	// divergence (the parent context is still canceled by defer cancel()).
	if stdout.overflow || stderr.overflow {
		// Node's exec fails with this message when maxBuffer is exceeded.
		msg := "stdout maxBuffer length exceeded"
		log.Error("hooks operation failed", "err", errors.New(msg))
		return HookResult{
			HookID:  h.ID,
			Output:  msg,
			Success: false,
			Reject:  h.Reject,
		}
	}
	if err != nil {
		// Node's exec error message is `Command failed: <cmd>\n<stderr>`;
		// asErrorString surfaces it verbatim, and the on_error policy decides
		// whether it reaches the model.
		msg := "Command failed: " + h.Action.Command
		if s := strings.TrimSpace(stderr.String()); s != "" {
			msg += "\n" + s
		}
		// TS executeAction's command catch logs before rethrowing (the sync
		// fire() catch then logs the same failure a second time).
		log.Error("hooks operation failed", "err", errors.New(msg))
		return HookResult{
			HookID:  h.ID,
			Output:  msg,
			Success: false,
			Reject:  h.Reject,
		}
	}
	// Success returns stdout only; TS does not merge stderr into the output.
	return HookResult{
		HookID:  h.ID,
		Output:  strings.TrimSpace(stdout.String()),
		Success: true,
		Reject:  h.Reject,
	}
}

// hookHTTPBody is the serialized HookContext posted to HTTP hooks. The field
// order mirrors the TS object literals (event, toolName, args, filePath,
// message) so the JSON bytes match JSON.stringify(context); pointer fields
// reproduce JSON.stringify's treatment of undefined (nil → omitted) while
// defined-but-empty values ("" / {}) stay included.
type hookHTTPBody struct {
	Event    string  `json:"event"`
	ToolName *string `json:"toolName,omitempty"`
	// Args is a pointer so omitempty keys off nil only: a defined-but-empty
	// map serializes as {} (JSON.stringify includes it), matching the TS
	// pre_tool_use site where args is always a Record.
	Args     *map[string]any `json:"args,omitempty"`
	FilePath *string         `json:"filePath,omitempty"`
	Message  *string         `json:"message,omitempty"`
}

// httpBody derives which HookContext fields JSON.stringify would include for
// the given event. The TS library trigger sites fix the presence per event:
//   - firePreToolHooks (pre_tool_use): toolName/args/filePath are always
//     defined (args is a required parameter, filePath defaults to ""), and
//     message is never set.
//   - the agent's post_tool_use site: toolName/filePath/message are always
//     defined (message is the tool output, possibly ""); args is defined only
//     when the originating tool call was found (nil map ≈ undefined).
//   - fireLifecycle("post_receive", fullText): message is always defined.
//   - the remaining lifecycle events: only {event} is built; the Go agent
//     passes "" for an absent message, so a non-empty message is the only
//     signal that one was given.
func httpBody(ctx HookContext) hookHTTPBody {
	body := hookHTTPBody{Event: string(ctx.EventName)}
	switch ctx.EventName {
	case EventPreToolUse:
		toolName, filePath := ctx.ToolName, ctx.FilePath
		body.ToolName = &toolName
		body.FilePath = &filePath
		args := ctx.ToolArgs
		if args == nil {
			args = map[string]any{}
		}
		body.Args = &args
	case EventPostToolUse:
		toolName, filePath, message := ctx.ToolName, ctx.FilePath, ctx.Message
		body.ToolName = &toolName
		body.FilePath = &filePath
		body.Message = &message
		if ctx.ToolArgs != nil {
			args := ctx.ToolArgs
			body.Args = &args // nil → omitted (TS: find()?.arguments)
		}
	case EventPostReceive:
		message := ctx.Message
		body.Message = &message
	default:
		if ctx.Message != "" {
			message := ctx.Message
			body.Message = &message
		}
	}
	return body
}

func runHTTP(h Hook, ctx HookContext, opts RuntimeOptions) HookResult {
	method := strings.ToUpper(h.Action.Method)
	if method == "" {
		method = "POST"
	}
	timeout := h.Action.Timeout
	if timeout <= 0 {
		// TS uses AbortSignal.timeout(30000) for HTTP hooks.
		timeout = 30 * time.Second
	}

	// GET/HEAD carry no body (TS: only non-GET/HEAD requests get the
	// serialized context). The body is JSON.stringify(context): undefined
	// fields are omitted, defined-but-empty ones are included, and
	// JSON.stringify does not HTML-escape. A configured body overrides it
	// (Go extension).
	var body string
	if method != "GET" && method != "HEAD" {
		body = h.Action.Body
		if body == "" {
			var buf bytes.Buffer
			enc := json.NewEncoder(&buf)
			enc.SetEscapeHTML(false)
			if err := enc.Encode(httpBody(ctx)); err != nil {
				// Unreachable for this payload shape; TS has no equivalent
				// failure mode (JSON.stringify of a plain object).
				log.Error("hooks operation failed", "err", err)
				return HookResult{HookID: h.ID, Output: err.Error(), Success: false, Reject: h.Reject}
			}
			body = strings.TrimSuffix(buf.String(), "\n")
		}
	}

	parent := opts.Ctx
	if parent == nil {
		parent = context.Background()
	}
	cctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, method, h.Action.URL, strings.NewReader(body))
	if err != nil {
		log.Error("hooks operation failed", "err", err)
		return HookResult{HookID: h.ID, Output: err.Error(), Success: false, Reject: h.Reject}
	}
	// TS always sends Content-Type: application/json for HTTP hooks, even on
	// bodiless GET/HEAD; custom headers are a Go-only extension and win when
	// both are configured.
	req.Header.Set("Content-Type", "application/json")
	for k, v := range h.Action.Headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Error("hooks operation failed", "err", err)
		return HookResult{HookID: h.ID, Output: err.Error(), Success: false, Reject: h.Reject}
	}
	defer resp.Body.Close()
	// TS reads the whole body (await resp.text()); a capped read would silently
	// truncate a large hook response.
	respBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// TS throws exactly `HTTP hook failed with status N` (no body); the
		// throw happens inside the try, so the http catch logs it.
		msg := fmt.Sprintf("HTTP hook failed with status %d", resp.StatusCode)
		log.Error("hooks operation failed", "err", errors.New(msg))
		return HookResult{
			HookID:  h.ID,
			Output:  msg,
			Success: false,
			Reject:  h.Reject,
		}
	}
	// TS returns the response text verbatim (only command hooks trim).
	return HookResult{
		HookID:  h.ID,
		Output:  string(respBytes),
		Success: true,
		Reject:  h.Reject,
	}
}
