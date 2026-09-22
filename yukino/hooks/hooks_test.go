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
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

func TestEvaluateConditionLeafOps(t *testing.T) {
	ctx := HookContext{
		EventName: EventPreToolUse,
		ToolName:  "Bash",
		FilePath:  "src/foo.go",
		ToolArgs: map[string]any{
			"command": "rm -rf /",
			"note":    "a || b",
			"count":   3,
		},
	}
	cases := map[string]bool{
		`tool == "Bash"`:           true,
		`tool == "Read"`:           false,
		`tool != "Read"`:           true,
		`event =~ "^pre_"`:         true,
		`args.command =~ "rm -rf"`: false, // TS keys are `\w+`; a dotted key never matches
		`command =~ "rm -rf"`:      true,  // bare key falls back to tool args (TS getContextValue)
		`count == "3"`:             false, // non-string args resolve to "" (TS strArg)
		`file_path =* "src/*.go"`:  true,
		`file_path =* "src/*.py"`:  false,
		`file_path =* "**/*.go"`:   true, // ** spans directories (TS glob)
		`file_path =* "src/**"`:    true,
		`Bash`:                     true, // bare tool-name shorthand (TS hooks/index.ts:386-388)
		`Read`:                     false,
		`args.note == "a || b"`:    false, // dotted key: no comparison form matches it (TS)
		`note == "a || b"`:         true,  // bare key + quoted operator
		`tool == "Bash" && file_path =* "src/*.go"`: true,
		`tool == "Bash" && file_path =* "src/*.py"`: false,
		`tool == "Read" || tool == "Bash"`:          true,
		`tool == "Read" || tool == "Write"`:         false,
		// && binds tighter than ||: true || (false && false) → true
		// (old left-to-right evaluation gave false here)
		`tool == "Bash" || tool == "Read" && file_path =* "src/*.py"`: true,
		// (false && true) || true → true
		`tool == "Read" && file_path =* "src/*.go" || tool == "Bash"`: true,
		`!(tool == "Read")`: true,  // parens are not special; bare word check fails, negated
		`!tool == "Read"`:   true,  // ! applied to leaf
		`tool == "Bash`:     false, // unbalanced quotes → false (TS)
	}
	for cond, want := range cases {
		if got := evaluateCondition(cond, ctx); got != want {
			t.Errorf("evaluateCondition(%q) = %v, want %v", cond, got, want)
		}
	}
}

func TestRunPreToolHooksReject(t *testing.T) {
	eng := NewEngine()
	eng.LoadHooks([]Hook{{
		ID:        "block-rm-rf",
		Event:     EventPreToolUse,
		Condition: `tool == "Bash" && command =~ "rm -rf"`,
		Action:    Action{Type: ActionPrompt, Prompt: "destructive command blocked"},
		Reject:    true,
	}})

	ctx := HookContext{
		EventName: EventPreToolUse,
		ToolName:  "Bash",
		ToolArgs:  map[string]any{"command": "rm -rf /tmp/x"},
	}
	rejected, msg := eng.RunPreToolHooks(ctx, RuntimeOptions{})
	if !rejected {
		t.Fatal("expected rejection")
	}
	if !strings.Contains(msg, "destructive command blocked") {
		t.Errorf("unexpected reject message: %q", msg)
	}
}

func TestRunPreToolHooksAllowsWhenConditionFails(t *testing.T) {
	eng := NewEngine()
	eng.LoadHooks([]Hook{{
		ID:        "block-go",
		Event:     EventPreToolUse,
		Condition: `file_path =* "**/*.go"`,
		Action:    Action{Type: ActionPrompt, Prompt: "blocked"},
		Reject:    true,
	}})
	rejected, _ := eng.RunPreToolHooks(HookContext{
		EventName: EventPreToolUse,
		ToolName:  "WriteFile",
		FilePath:  "src/foo.py",
	}, RuntimeOptions{})
	if rejected {
		t.Fatal("expected allow for non-matching path")
	}
}

func TestHookOnceOnlyFiresOnce(t *testing.T) {
	eng := NewEngine()
	eng.LoadHooks([]Hook{{
		ID:     "greet",
		Event:  EventSessionStart,
		Action: Action{Type: ActionPrompt, Prompt: "hello"},
		Once:   true,
	}})

	res1 := eng.RunHooks(HookContext{EventName: EventSessionStart}, RuntimeOptions{})
	res2 := eng.RunHooks(HookContext{EventName: EventSessionStart}, RuntimeOptions{})
	if len(res1) != 1 {
		t.Errorf("first run should produce 1 result, got %d", len(res1))
	}
	if len(res2) != 0 {
		t.Errorf("second run should produce 0 results (once), got %d", len(res2))
	}
}

func TestHookOnceWithoutIDFiresOnce(t *testing.T) {
	// TS falls back to an `index:N` once-key when the hook has no id, so an
	// id-less once hook must still fire exactly once.
	eng := NewEngine()
	eng.LoadHooks([]Hook{{
		Event:  EventSessionStart,
		Action: Action{Type: ActionPrompt, Prompt: "hello"},
		Once:   true,
	}})

	res1 := eng.RunHooks(HookContext{EventName: EventSessionStart}, RuntimeOptions{})
	res2 := eng.RunHooks(HookContext{EventName: EventSessionStart}, RuntimeOptions{})
	if len(res1) != 1 {
		t.Errorf("first run should produce 1 result, got %d", len(res1))
	}
	if len(res2) != 0 {
		t.Errorf("second run should produce 0 results (once, index fallback), got %d", len(res2))
	}
}

func TestHookHTTPAction(t *testing.T) {
	var hits int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		if r.Method != "POST" {
			t.Errorf("want POST, got %s", r.Method)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("missing JSON content-type")
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	eng := NewEngine()
	eng.LoadHooks([]Hook{{
		ID:    "notify",
		Event: EventPostToolUse,
		Action: Action{
			Type: ActionHTTP,
			URL:  server.URL,
		},
	}})
	results := eng.RunHooks(HookContext{EventName: EventPostToolUse, ToolName: "Bash"}, RuntimeOptions{})
	if len(results) != 1 || !results[0].Success {
		t.Fatalf("expected one successful HTTP result, got %#v", results)
	}
	if atomic.LoadInt32(&hits) != 1 {
		t.Errorf("server expected 1 hit, got %d", hits)
	}
}

func TestHookAsyncIsNonBlocking(t *testing.T) {
	eng := NewEngine()
	eng.LoadHooks([]Hook{{
		ID:    "slow",
		Event: EventTurnEnd,
		Async: true,
		Action: Action{
			Type:    ActionCommand,
			Command: "sleep 0.2",
		},
	}})
	start := time.Now()
	res := eng.RunHooks(HookContext{EventName: EventTurnEnd}, RuntimeOptions{})
	elapsed := time.Since(start)
	if elapsed > 100*time.Millisecond {
		t.Errorf("async hook blocked the caller for %v", elapsed)
	}
	// TS appends nothing for async hooks; they only post notifications in the
	// background.
	if len(res) != 0 {
		t.Errorf("async hooks must not produce result entries, got %#v", res)
	}
}

func TestHookOnErrorReject(t *testing.T) {
	eng := NewEngine()
	eng.LoadHooks([]Hook{{
		ID:      "fail",
		Event:   EventPreToolUse,
		OnError: "reject",
		Action: Action{
			Type:    ActionCommand,
			Command: "exit 7",
		},
	}})
	rejected, msg := eng.RunPreToolHooks(HookContext{EventName: EventPreToolUse, ToolName: "Bash"}, RuntimeOptions{})
	if !rejected {
		t.Fatal("expected reject on command failure with on_error=reject")
	}
	_ = msg
}

func TestValidateCatchesMissingFields(t *testing.T) {
	cases := []struct {
		name string
		hook Hook
		want string // substring that must appear in the error
	}{
		{
			name: "command missing command field",
			hook: Hook{ID: "no-cmd", Event: EventPreToolUse, Action: Action{Type: ActionCommand}},
			want: "action.command must be non-empty",
		},
		{
			name: "prompt missing prompt",
			hook: Hook{ID: "no-msg", Event: EventSessionStart, Action: Action{Type: ActionPrompt}},
			want: "action.prompt must be non-empty",
		},
		{
			name: "http missing url",
			hook: Hook{ID: "no-url", Event: EventPostToolUse, Action: Action{Type: ActionHTTP}},
			want: "action.url must be non-empty",
		},
		{
			name: "missing event",
			hook: Hook{ID: "no-evt", Action: Action{Type: ActionPrompt, Prompt: "hi"}},
			want: "event is required",
		},
		{
			name: "unknown event",
			hook: Hook{ID: "unknown-evt", Event: "made_up_event", Action: Action{Type: ActionPrompt, Prompt: "hi"}},
			want: `invalid event 'made_up_event'`,
		},
		{
			name: "unknown action type",
			hook: Hook{ID: "unknown-act", Event: EventPreToolUse, Action: Action{Type: "weird"}},
			want: `invalid action type 'weird'`,
		},
		{
			name: "missing action type",
			hook: Hook{ID: "no-type", Event: EventPreToolUse, Action: Action{Command: "echo"}},
			want: "action.type is required",
		},
		{
			name: "negative timeout",
			hook: Hook{ID: "neg-to", Event: EventPostToolUse, Action: Action{Type: ActionCommand, Command: "echo ok", Timeout: -time.Second}},
			want: "action.timeout must be >= 0",
		},
		{
			name: "reject with async",
			hook: Hook{ID: "ra", Event: EventPostToolUse, Action: Action{Type: ActionCommand, Command: "echo ok"}, Reject: true, Async: true},
			want: "reject and async are mutually exclusive",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := Validate([]Hook{c.hook})
			if err == nil {
				t.Fatalf("expected error for %s, got nil", c.name)
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("expected error to contain %q, got %q", c.want, err.Error())
			}
		})
	}
}

func TestValidateAggregatesAllErrors(t *testing.T) {
	hooks := []Hook{
		{ID: "bad1", Event: "nope", Action: Action{Type: ActionCommand}},     // 2 errors: unknown event + missing command
		{ID: "bad2", Event: EventPostToolUse, Action: Action{Type: "weird"}}, // 1 error: unknown action type
	}
	err := Validate(hooks)
	if err == nil {
		t.Fatal("expected aggregated errors")
	}
	msg := err.Error()
	for _, want := range []string{`invalid event 'nope'`, "action.command must be non-empty", `invalid action type 'weird'`} {
		if !strings.Contains(msg, want) {
			t.Errorf("aggregated error missing %q, got: %s", want, msg)
		}
	}
	// TS joins all problems with "; ".
	if !strings.Contains(msg, "; ") {
		t.Errorf("expected '; '-joined errors, got: %s", msg)
	}
}

func TestValidateAcceptsGoodConfig(t *testing.T) {
	hooks := []Hook{
		{ID: "fmt", Event: EventPostToolUse, Action: Action{Type: ActionCommand, Command: "echo ok"}},
		{ID: "ctx", Event: EventSessionStart, Action: Action{Type: ActionPrompt, Prompt: "hello"}},
		{ID: "slack", Event: EventPostToolUse, Action: Action{Type: ActionHTTP, URL: "https://hooks.slack.com/services/xxx"}},
		{ID: "review", Event: EventPostToolUse, Action: Action{Type: ActionAgent, Prompt: "review the change"}},
	}
	if err := Validate(hooks); err != nil {
		t.Fatalf("expected no error, got: %s", err)
	}
}

func TestRunCommandTimeout(t *testing.T) {
	h := Hook{
		ID: "slow",
		Action: Action{
			Type:    ActionCommand,
			Command: "sleep 2",
			Timeout: 100 * time.Millisecond,
		},
	}
	start := time.Now()
	result := runCommand(h, HookContext{EventName: EventPostToolUse, ToolName: "Bash"}, RuntimeOptions{})
	elapsed := time.Since(start)

	if result.Success {
		t.Fatalf("expected timed-out command to report Success=false, output=%q", result.Output)
	}
	// A timeout surfaces through Node's generic exec failure shape
	// ("Command failed: <cmd>" plus any stderr), not a bespoke "timed out"
	// wording — Node's exec reports timeouts identically to other failures.
	if !strings.HasPrefix(result.Output, "Command failed: sleep 2") {
		t.Fatalf("expected the Node exec failure wording, got: %q", result.Output)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("expected command to be killed near 100ms, but took %s", elapsed)
	}
}

func TestRunCommandDefaultTimeoutAllowsFastCommand(t *testing.T) {
	// Timeout=0 should fall back to defaultHookTimeout (30s, matching the TS
	// reference) and not strangle a sub-second command.
	h := Hook{
		ID: "fast",
		Action: Action{
			Type:    ActionCommand,
			Command: "echo ok",
		},
	}
	result := runCommand(h, HookContext{EventName: EventPostToolUse, ToolName: "Bash"}, RuntimeOptions{})
	if !result.Success {
		t.Fatalf("expected fast command to succeed under default timeout, got output=%q", result.Output)
	}
	if !strings.Contains(result.Output, "ok") {
		t.Fatalf("expected output to contain stdout 'ok', got %q", result.Output)
	}
}

func TestRunCommandUsesRuntimeWorkDir(t *testing.T) {
	dir := t.TempDir()
	h := Hook{
		ID:     "pwd-hook",
		Action: Action{Type: ActionCommand, Command: "pwd"},
	}
	result := runCommand(h, HookContext{EventName: EventPostToolUse}, RuntimeOptions{WorkDir: dir})
	if !result.Success {
		t.Fatalf("command failed: %q", result.Output)
	}
	// macOS symlinks /var → /private/var; compare resolved paths.
	got, err := filepath.EvalSymlinks(strings.TrimSpace(result.Output))
	if err != nil {
		t.Fatal(err)
	}
	want, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("command ran in %q, want %q", got, want)
	}
}

func TestRunCommandHonorsParentContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled before the hook runs
	h := Hook{
		ID:     "sleep-hook",
		Action: Action{Type: ActionCommand, Command: "sleep 5", Timeout: 10 * time.Second},
	}
	start := time.Now()
	result := runCommand(h, HookContext{EventName: EventPostToolUse}, RuntimeOptions{Ctx: ctx})
	if result.Success {
		t.Fatal("cancelled parent context must fail the command")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("cancellation did not stop the command quickly: %v", elapsed)
	}
}

func TestUnmarshalHookIgnoresLegacyKeys(t *testing.T) {
	// The TS HookConfigSchema only knows `condition` / `action.prompt`; zod
	// strips unknown keys, so the legacy Go spellings `if` / `action.message`
	// must decode to nothing rather than being accepted as aliases.
	cases := []struct {
		name          string
		doc           string
		wantCondition string
		wantPrompt    string
	}{
		{
			name: "TS keys",
			doc: `
id: ts
event: pre_tool_use
condition: 'tool == "Bash"'
action:
  type: prompt
  prompt: ts prompt
`,
			wantCondition: `tool == "Bash"`,
			wantPrompt:    "ts prompt",
		},
		{
			name: "legacy keys are ignored",
			doc: `
id: legacy
event: pre_tool_use
if: 'tool == "Bash"'
action:
  type: prompt
  message: legacy prompt
`,
			wantCondition: "",
			wantPrompt:    "",
		},
		{
			name: "TS keys win because legacy keys are ignored",
			doc: `
event: pre_tool_use
condition: ts wins
if: legacy loses
action:
  type: prompt
  prompt: ts wins
  message: legacy loses
`,
			wantCondition: "ts wins",
			wantPrompt:    "ts wins",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var h Hook
			if err := yaml.Unmarshal([]byte(c.doc), &h); err != nil {
				t.Fatalf("unmarshal: %s", err)
			}
			if h.Condition != c.wantCondition {
				t.Errorf("Condition = %q, want %q", h.Condition, c.wantCondition)
			}
			if h.Action.Prompt != c.wantPrompt {
				t.Errorf("Action.Prompt = %q, want %q", h.Action.Prompt, c.wantPrompt)
			}
		})
	}
}

// The TS once-key checks id PRESENCE (`hook.id === undefined`), not
// truthiness: two config-decoded hooks with an explicit empty-string id
// share the single `id:` once slot, so only the first ever fires. Id-less
// once hooks keep their per-index keys.
func TestHookOnceEmptyStringIDIsAValue(t *testing.T) {
	doc := `
- id: ""
  event: session_start
  action:
    type: prompt
    prompt: first
  once: true
- id: ""
  event: session_start
  action:
    type: prompt
    prompt: second
  once: true
- event: session_start
  action:
    type: prompt
    prompt: third
  once: true
`
	var hooksCfg []Hook
	if err := yaml.Unmarshal([]byte(doc), &hooksCfg); err != nil {
		t.Fatalf("unmarshal: %s", err)
	}
	if len(hooksCfg) != 3 {
		t.Fatalf("expected 3 hooks, got %d", len(hooksCfg))
	}
	if !hooksCfg[0].hasID() || !hooksCfg[1].hasID() {
		t.Fatal(`a decoded empty-string id must count as present (TS: hook.id === undefined)`)
	}
	if hooksCfg[2].hasID() {
		t.Fatal("an absent id must not count as present")
	}

	eng := NewEngine()
	eng.LoadHooks(hooksCfg)
	res := eng.RunHooks(HookContext{EventName: EventSessionStart}, RuntimeOptions{})
	// Hook 2 shares hook 1's `id:` key and never fires; hook 3 fires on its
	// own `index:2` key.
	if len(res) != 2 {
		t.Fatalf("expected 2 results (first + third), got %d: %+v", len(res), res)
	}
	if res[0].Output != "first" || res[1].Output != "third" {
		t.Fatalf("unexpected outputs: %+v", res)
	}
	res2 := eng.RunHooks(HookContext{EventName: EventSessionStart}, RuntimeOptions{})
	if len(res2) != 0 {
		t.Fatalf("once hooks must not fire again, got %+v", res2)
	}
}

// The HTTP hook body is JSON.stringify(context): fields the TS trigger site
// leaves undefined are omitted, defined-but-empty ones are included, and the
// key order follows the TS object literals.
func TestHookHTTPBodyShape(t *testing.T) {
	cases := []struct {
		name string
		ctx  HookContext
		want string
	}{
		{
			name: "pre_tool_use includes empty filePath and args, never message",
			ctx: HookContext{
				EventName: EventPreToolUse,
				ToolName:  "Bash",
				ToolArgs:  map[string]any{},
				FilePath:  "",
				Message:   "ignored at this TS site",
			},
			want: `{"event":"pre_tool_use","toolName":"Bash","args":{},"filePath":""}`,
		},
		{
			name: "pre_tool_use without args sends an empty object",
			ctx: HookContext{
				EventName: EventPreToolUse,
				ToolName:  "Bash",
			},
			want: `{"event":"pre_tool_use","toolName":"Bash","args":{},"filePath":""}`,
		},
		{
			name: "post_tool_use includes an empty message and omits nil args",
			ctx: HookContext{
				EventName: EventPostToolUse,
				ToolName:  "ReadFile",
				FilePath:  "a.go",
				Message:   "",
			},
			want: `{"event":"post_tool_use","toolName":"ReadFile","filePath":"a.go","message":""}`,
		},
		{
			name: "post_receive always carries message (fireLifecycle passes fullText)",
			ctx:  HookContext{EventName: EventPostReceive, Message: ""},
			want: `{"event":"post_receive","message":""}`,
		},
		{
			name: "other lifecycle events send only the event",
			ctx:  HookContext{EventName: EventSessionStart},
			want: `{"event":"session_start"}`,
		},
		{
			name: "html characters stay unescaped like JSON.stringify",
			ctx:  HookContext{EventName: EventPostReceive, Message: "<a & b>"},
			want: `{"event":"post_receive","message":"<a & b>"}`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var gotBody string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				gotBody = string(b)
				w.WriteHeader(http.StatusOK)
			}))
			defer server.Close()

			eng := NewEngine()
			eng.LoadHooks([]Hook{{
				ID:    "body-check",
				Event: c.ctx.EventName,
				Action: Action{
					Type: ActionHTTP,
					URL:  server.URL,
				},
			}})
			results := eng.RunHooks(c.ctx, RuntimeOptions{})
			if len(results) != 1 || !results[0].Success {
				t.Fatalf("hook did not succeed: %+v", results)
			}
			if gotBody != c.want {
				t.Fatalf("body = %s, want %s", gotBody, c.want)
			}
		})
	}
}
