package hooks

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/config"
)

func waitForNotifications(t *testing.T, engine *Engine, want []string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		got := engine.DrainNotifications()
		if len(got) == 0 {
			time.Sleep(10 * time.Millisecond)
			continue
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("notifications = %v, want %v", got, want)
		}
		return
	}
	t.Fatalf("timed out waiting for notifications %v", want)
}

func TestHookExecutionBoundaries(t *testing.T) {
	t.Run("consumes each anonymous once hook only after its condition matches", func(t *testing.T) {
		var hooks []config.HookConfig
		for _, prompt := range []string{"first", "second"} {
			hooks = append(hooks, config.HookConfig{
				Event:     "pre_tool_use",
				Condition: `tool === "WriteFile"`,
				Once:      true,
				Action:    config.HookActionConfig{Type: "prompt", Prompt: prompt},
			})
		}
		engine := NewEngine(hooks)
		engine.FirePreToolHooks("ReadFile", nil, HookRuntimeOptions{})
		if got := engine.DrainNotifications(); len(got) != 0 {
			t.Fatalf("notifications = %v, want none", got)
		}
		engine.FirePreToolHooks("WriteFile", nil, HookRuntimeOptions{})
		if got := engine.DrainNotifications(); !reflect.DeepEqual(got, []string{"first", "second"}) {
			t.Fatalf("notifications = %v", got)
		}
		engine.FirePreToolHooks("WriteFile", nil, HookRuntimeOptions{})
		if got := engine.DrainNotifications(); len(got) != 0 {
			t.Fatalf("notifications = %v, want none", got)
		}
	})
	t.Run("honors prompt rejection for a matching tool condition", func(t *testing.T) {
		engine := NewEngine([]config.HookConfig{{
			Event:     "pre_tool_use",
			Condition: `tool === "Bash"`,
			Reject:    true,
			Action:    config.HookActionConfig{Type: "prompt", Prompt: "blocked"},
		}})
		rejected, reason := engine.FirePreToolHooks("Bash", nil, HookRuntimeOptions{})
		if !rejected || reason != "blocked" {
			t.Fatalf("rejected=%v reason=%q", rejected, reason)
		}
		rejected, reason = engine.FirePreToolHooks("ReadFile", nil, HookRuntimeOptions{})
		if rejected || reason != "" {
			t.Fatalf("rejected=%v reason=%q", rejected, reason)
		}
	})
	conditions := []struct {
		condition string
		filePath  string
		matched   bool
	}{
		{`/\.ts$/.test(filePath)`, "src/file.ts", true},
		{`/\.ts$/.test(filePath)`, "src/fileXts", false},
		{`filePath.startsWith("src/") && filePath.endsWith(".ts")`, "src/a/b/file.ts", true},
		{`filePath === "a && b"`, "a && b", true},
		{`tool === "ReadFile" || (tool === "WriteFile" && filePath === "x")`, "y", true},
		{`args.file_path === "x"`, "x", true},
		{`undefinedVariable === true`, "x", false},
	}
	for _, tc := range conditions {
		t.Run("matches condition "+tc.condition, func(t *testing.T) {
			engine := NewEngine([]config.HookConfig{{
				Event:     "pre_tool_use",
				Condition: tc.condition,
				Reject:    true,
				Action:    config.HookActionConfig{Type: "prompt", Prompt: "matched"},
			}})
			rejected, _ := engine.FirePreToolHooks("ReadFile", map[string]any{"file_path": tc.filePath}, HookRuntimeOptions{})
			if rejected != tc.matched {
				t.Fatalf("condition %q against %q: rejected=%v, want %v", tc.condition, tc.filePath, rejected, tc.matched)
			}
		})
	}
	t.Run("runs commands in the agent work directory", func(t *testing.T) {
		cwd := t.TempDir()
		engine := NewEngine([]config.HookConfig{{
			Event:  "pre_send",
			Action: config.HookActionConfig{Type: "command", Command: "pwd -P"},
		}})
		results := engine.Fire("pre_send", HookContext{Event: "pre_send"}, HookRuntimeOptions{Cwd: cwd})
		want, err := filepath.EvalSymlinks(cwd)
		if err != nil {
			t.Fatal(err)
		}
		if len(results) != 1 || results[0].Output != want {
			t.Fatalf("results = %+v, want output %s", results, want)
		}
	})
	t.Run("uses Bash for command hooks on POSIX", func(t *testing.T) {
		engine := NewEngine([]config.HookConfig{{
			Event:  "pre_send",
			Action: config.HookActionConfig{Type: "command", Command: `[[ -n "$BASH_VERSION" ]] && printf bash`},
		}})
		results := engine.Fire("pre_send", HookContext{Event: "pre_send"}, HookRuntimeOptions{})
		if len(results) != 1 || results[0].Output != "bash" || !results[0].Success {
			t.Fatalf("results = %+v", results)
		}
	})
	t.Run("sends no body for GET and applies on_error to non-success HTTP status", func(t *testing.T) {
		var gotMethod atomic.Value
		var gotBodyLen atomic.Int64
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			gotMethod.Store(r.Method)
			body, _ := io.ReadAll(r.Body)
			gotBodyLen.Store(int64(len(body)))
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("unavailable"))
		}))
		defer server.Close()
		engine := NewEngine([]config.HookConfig{{
			Event:   "pre_tool_use",
			OnError: "reject",
			Action:  config.HookActionConfig{Type: "http", URL: server.URL, Method: "get"},
		}})
		rejected, reason := engine.FirePreToolHooks("WriteFile", nil, HookRuntimeOptions{})
		if !rejected || !strings.Contains(reason, "503") {
			t.Fatalf("rejected=%v reason=%q", rejected, reason)
		}
		if gotMethod.Load() != "GET" {
			t.Fatalf("method = %v, want GET", gotMethod.Load())
		}
		if gotBodyLen.Load() != 0 {
			t.Fatalf("body length = %d, want 0", gotBodyLen.Load())
		}
	})
	t.Run("rejects agent hooks during production configuration validation", func(t *testing.T) {
		err := Validate([]config.HookConfig{{
			Event:  "pre_send",
			Action: config.HookActionConfig{Type: "agent", Prompt: "inspect"},
		}})
		if err == nil || !strings.Contains(err.Error(), `action.type "agent" is not supported`) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("accepts a broken condition at validation and skips it silently at runtime", func(t *testing.T) {
		hooks := []config.HookConfig{{
			Event:     "pre_tool_use",
			Condition: "tool ===",
			Reject:    true,
			Action:    config.HookActionConfig{Type: "prompt", Prompt: "never"},
		}}
		if err := Validate(hooks); err != nil {
			t.Fatalf("validate = %v, want nil", err)
		}
		rejected, _ := NewEngine(hooks).FirePreToolHooks("Bash", nil, HookRuntimeOptions{})
		if rejected {
			t.Fatal("broken condition must skip the hook")
		}
	})
	t.Run("applies on_error to agent hook failures and stops the rejected chain", func(t *testing.T) {
		marker := filepath.Join(t.TempDir(), "ran")
		engine := NewEngine([]config.HookConfig{
			{
				Event:   "pre_tool_use",
				OnError: "reject",
				Action:  config.HookActionConfig{Type: "agent", Prompt: "inspect"},
			},
			{
				Event:  "pre_tool_use",
				Action: config.HookActionConfig{Type: "command", Command: "touch " + marker},
			},
		})
		rejected, _ := engine.FirePreToolHooks("WriteFile", nil, HookRuntimeOptions{})
		if !rejected {
			t.Fatal("missing agent runner with on_error=reject must reject")
		}
		if _, err := os.Stat(marker); !os.IsNotExist(err) {
			t.Fatal("the rejected chain must not run later hooks")
		}
		engine.AgentRunner = func(prompt string, ctx HookContext) (string, error) {
			return "", &hookTestError{"runner failed"}
		}
		rejected, reason := engine.FirePreToolHooks("WriteFile", nil, HookRuntimeOptions{})
		if !rejected || !strings.Contains(reason, "runner failed") {
			t.Fatalf("rejected=%v reason=%q", rejected, reason)
		}
	})
	t.Run("does not launch hooks after cancellation or enqueue synthetic async output", func(t *testing.T) {
		var requests atomic.Int64
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requests.Add(1)
			_, _ = w.Write([]byte("finished"))
		}))
		defer server.Close()
		engine := NewEngine([]config.HookConfig{{
			Event:  "pre_send",
			Async:  true,
			Action: config.HookActionConfig{Type: "http", URL: server.URL},
		}})
		cancelled, cancel := context.WithCancel(context.Background())
		cancel()
		if results := engine.Fire("pre_send", HookContext{Event: "pre_send"}, HookRuntimeOptions{Abort: cancelled}); len(results) != 0 {
			t.Fatalf("results = %+v, want none", results)
		}
		if requests.Load() != 0 {
			t.Fatal("cancelled fire must not call the hook")
		}
		if results := engine.Fire("pre_send", HookContext{Event: "pre_send"}, HookRuntimeOptions{}); len(results) != 0 {
			t.Fatalf("async hooks must not enqueue sync results, got %+v", results)
		}
		waitForNotifications(t, engine, []string{"finished"})
	})
	t.Run("releases a once slot when an async hook fails", func(t *testing.T) {
		var calls atomic.Int64
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if calls.Add(1) == 1 {
				conn, _, err := w.(http.Hijacker).Hijack()
				if err == nil {
					conn.Close()
				}
				return
			}
			_, _ = w.Write([]byte("retried"))
		}))
		defer server.Close()
		engine := NewEngine([]config.HookConfig{{
			Event:   "pre_send",
			Once:    true,
			Async:   true,
			OnError: "fail",
			Action:  config.HookActionConfig{Type: "http", URL: server.URL},
		}})
		engine.Fire("pre_send", HookContext{Event: "pre_send"}, HookRuntimeOptions{})
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if got := engine.DrainNotifications(); len(got) > 0 {
				if !strings.Contains(got[0], "Async hook error") {
					t.Fatalf("first notification = %v", got)
				}
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		engine.Fire("pre_send", HookContext{Event: "pre_send"}, HookRuntimeOptions{})
		waitForNotifications(t, engine, []string{"retried"})
		if calls.Load() != 2 {
			t.Fatalf("calls = %d, want 2", calls.Load())
		}
	})
}

type hookTestError struct{ msg string }

func (e *hookTestError) Error() string { return e.msg }
