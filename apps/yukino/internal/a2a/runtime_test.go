package a2a

import (
	"context"
	"testing"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/compact"
	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/file_history"
	"github.com/yukino-js/yukino/yukino/internal/goal"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/memory"
	"github.com/yukino-js/yukino/yukino/internal/memory/background"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/skills"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type runtimeMockClient struct{}

func (runtimeMockClient) SetSystemPrompt(string) {}

func (runtimeMockClient) Stream(context.Context, *conversation.Manager, []map[string]any) (<-chan llm.StreamEvent, <-chan error) {
	events := make(chan llm.StreamEvent, 2)
	errs := make(chan error)
	events <- llm.TextDelta{Text: "done"}
	events <- llm.StreamEnd{StopReason: "end_turn"}
	close(events)
	close(errs)
	return events, errs
}

func newTestRuntime(t *testing.T) *agentRuntime {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	wd := t.TempDir()
	sessionID := session.NewID()
	return &agentRuntime{
		sessionID:      sessionID,
		cwd:            wd,
		provider:       &config.ProviderConfig{Name: "p", Protocol: "openai", Model: "m"},
		client:         runtimeMockClient{},
		conv:           conversation.NewManager(),
		registry:       tools.NewRegistry(),
		checker:        permissions.NewChecker(permissions.NewPathSandbox(wd, true), permissions.NewRuleEngine(wd), permissions.ModeDefault),
		fileHistory:    file_history.New(sessionID),
		fileStateCache: tools.NewFileStateCache(),
		recoveryState:  &compact.RecoveryState{},
		goalManager:    goal.NewGoalManager(wd, sessionID),
		skillCatalog:   skills.LoadCatalog(wd),
		activeSkills:   map[string]string{},
		memoryMgr:      memory.NewManager(wd, nil),
		memoryEnabled:  true,
		contextWindow:  200000,
		mcpAnnounced:   map[string]bool{},
	}
}

func (r *agentRuntime) tasks() *background.Tasks {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.memoryTasks
}

func (r *agentRuntime) loopComplete() func(*conversation.Manager) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.currentAgent == nil {
		return nil
	}
	return r.currentAgent.OnLoopComplete
}

// TestRuntimeMemoryTasksLazyAndDisposed pins the reference onLoopComplete
// contract on the a2a runtime: the background memory tasks are created lazily
// on the first loop completion (not per run), later completions reuse the live
// instance, Dispose disposes and clears it, and a late completion after
// dispose must not recreate it.
func TestRuntimeMemoryTasksLazyAndDisposed(t *testing.T) {
	r := newTestRuntime(t)

	if r.tasks() != nil {
		t.Fatal("memory tasks must be created lazily")
	}
	out, err := r.Run("hello")
	if err != nil {
		t.Fatal(err)
	}
	for range out {
	}

	// OnLoopComplete fires on its own goroutine at loop end; wait for it.
	deadline := time.Now().Add(2 * time.Second)
	for r.tasks() == nil {
		if time.Now().After(deadline) {
			t.Fatal("loop completion did not create the memory tasks")
		}
		time.Sleep(10 * time.Millisecond)
	}
	first := r.tasks()

	// A later loop completion reuses the live instance (reference `??=`).
	onLoop := r.loopComplete()
	if onLoop == nil {
		t.Fatal("runAgent must keep the current agent for the loop hook")
	}
	onLoop(r.conv)
	if r.tasks() != first {
		t.Fatal("loop completion must reuse the live memory tasks")
	}

	if err := r.Dispose(); err != nil {
		t.Fatal(err)
	}
	if r.tasks() != nil {
		t.Fatal("Dispose must clear the memory tasks")
	}
	onLoop(r.conv)
	if r.tasks() != nil {
		t.Fatal("a late loop completion must not recreate tasks after dispose")
	}
}
