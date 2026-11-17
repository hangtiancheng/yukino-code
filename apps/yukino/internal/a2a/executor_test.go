package a2a

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	a2alib "github.com/a2aproject/a2a-go/a2a"
	"github.com/a2aproject/a2a-go/a2asrv"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
)

// fakeRuntime is a scripted Runtime for executor tests.
type fakeRuntime struct {
	sessionID string
	cwd       string
	script    func(text string, emit func(agent.AgentEvent), aborted func() bool)

	mu       sync.Mutex
	runs     []string
	aborted  bool
	disposed bool
}

func (f *fakeRuntime) SessionID() string { return f.sessionID }
func (f *fakeRuntime) Cwd() string       { return f.cwd }

func (f *fakeRuntime) Run(text string) (<-chan agent.AgentEvent, error) {
	f.mu.Lock()
	f.runs = append(f.runs, text)
	f.mu.Unlock()
	out := make(chan agent.AgentEvent, 64)
	go func() {
		defer close(out)
		f.script(text, func(ev agent.AgentEvent) { out <- ev }, func() bool {
			f.mu.Lock()
			defer f.mu.Unlock()
			return f.aborted
		})
	}()
	return out, nil
}

func (f *fakeRuntime) Abort() {
	f.mu.Lock()
	f.aborted = true
	f.mu.Unlock()
}

func (f *fakeRuntime) Dispose() error {
	f.mu.Lock()
	f.disposed = true
	f.mu.Unlock()
	return nil
}

func simpleScript(events ...agent.AgentEvent) func(string, func(agent.AgentEvent), func() bool) {
	return func(_ string, emit func(agent.AgentEvent), _ func() bool) {
		for _, event := range events {
			emit(event)
		}
	}
}

func collect(t *testing.T, exec *Executor, execCtx *a2asrv.ExecutorContext) []a2alib.Event {
	t.Helper()
	var events []a2alib.Event
	for event, err := range exec.Execute(context.Background(), execCtx) {
		if err != nil {
			t.Fatalf("execute error: %v", err)
		}
		events = append(events, event)
	}
	return events
}

func textMessage(text string) *a2alib.Message {
	return &a2alib.Message{
		ID:    a2alib.NewMessageID(),
		Role:  a2alib.MessageRoleUser,
		Parts: []*a2alib.Part{TextPart(text)},
	}
}

func TestExecutorCompletedRun(t *testing.T) {
	runtime := &fakeRuntime{
		sessionID: "sess-1",
		cwd:       t.TempDir(),
		script: simpleScript(
			agent.StreamText{Text: "hello "},
			agent.StreamText{Text: "world"},
			agent.TurnComplete{},
			agent.LoopComplete{StopReason: "end_turn"},
		),
	}
	exec := NewExecutor(func(cwd, sessionID string) (Runtime, error) { return runtime, nil }, runtime.cwd, time.Hour)

	events := collect(t, exec, &a2asrv.ExecutorContext{TaskID: "task-1", ContextID: "ctx-1", Message: textMessage("hi")})

	if len(events) < 4 {
		t.Fatalf("events = %d, want >= 4", len(events))
	}
	submitted, ok := events[0].(*a2alib.Task)
	if !ok || submitted.Status.State != a2alib.TaskStateSubmitted {
		t.Fatalf("first event = %#v", events[0])
	}
	first, ok := events[1].(*a2alib.TaskArtifactUpdateEvent)
	if !ok || first.Append || first.LastChunk || first.Artifact.Parts[0].Text() != "hello " {
		t.Fatalf("first artifact = %#v", events[1])
	}
	second, ok := events[2].(*a2alib.TaskArtifactUpdateEvent)
	if !ok || !second.Append || second.Artifact.ID != first.Artifact.ID || second.Artifact.Parts[0].Text() != "world" {
		t.Fatalf("second artifact = %#v", events[2])
	}
	finalArtifact, ok := events[3].(*a2alib.TaskArtifactUpdateEvent)
	if !ok || finalArtifact.Append || !finalArtifact.LastChunk || finalArtifact.Artifact.Parts[0].Text() != "hello world" {
		t.Fatalf("final artifact = %#v", events[3])
	}
	working, ok := events[4].(*a2alib.TaskStatusUpdateEvent)
	if !ok || working.Status.State != a2alib.TaskStateWorking || working.Status.Message == nil {
		t.Fatalf("working update = %#v", events[4])
	}
	if working.Status.Message.ID != string(first.Artifact.ID) {
		t.Errorf("flushed answer message id = %q, artifact id = %q", working.Status.Message.ID, first.Artifact.ID)
	}
	completed, ok := events[len(events)-1].(*a2alib.TaskStatusUpdateEvent)
	if !ok || completed.Status.State != a2alib.TaskStateCompleted {
		t.Fatalf("terminal event = %#v", events[len(events)-1])
	}
	if len(runtime.runs) != 1 || runtime.runs[0] != "hi" {
		t.Errorf("runs = %v", runtime.runs)
	}
}

func TestExecutorErrorRun(t *testing.T) {
	runtime := &fakeRuntime{
		sessionID: "sess-1",
		cwd:       t.TempDir(),
		script:    simpleScript(agent.ErrorEvent{Message: "boom"}),
	}
	exec := NewExecutor(func(cwd, sessionID string) (Runtime, error) { return runtime, nil }, runtime.cwd, time.Hour)
	events := collect(t, exec, &a2asrv.ExecutorContext{TaskID: "task-1", ContextID: "ctx-1", Message: textMessage("hi")})
	terminal, ok := events[len(events)-1].(*a2alib.TaskStatusUpdateEvent)
	if !ok || terminal.Status.State != a2alib.TaskStateFailed || terminal.Status.Message.Parts[0].Text() != "boom" {
		t.Fatalf("terminal = %#v", events[len(events)-1])
	}
}

func TestExecutorPermissionHandshake(t *testing.T) {
	permCh := make(chan agent.PermissionReply, 1)
	runtime := &fakeRuntime{
		sessionID: "sess-1",
		cwd:       t.TempDir(),
		script: func(_ string, emit func(agent.AgentEvent), _ func() bool) {
			emit(agent.StreamText{Text: "before"})
			emit(agent.TurnComplete{})
			emit(agent.PermissionRequestEvent{
				AgentName:  "main",
				Cwd:        "/srv/a2a",
				ToolID:     "tc-1",
				ToolName:   "Bash",
				Args:       map[string]any{"command": "ls"},
				Decision:   permissions.Decision{Effect: permissions.Ask, Reason: "Mode: default"},
				ResponseCh: permCh,
			})
			reply := <-permCh
			if reply.Response == agent.PermAllow {
				emit(agent.StreamText{Text: "allowed"})
			} else {
				emit(agent.StreamText{Text: "denied"})
			}
			emit(agent.TurnComplete{})
			emit(agent.LoopComplete{StopReason: "end_turn"})
		},
	}
	exec := NewExecutor(func(cwd, sessionID string) (Runtime, error) { return runtime, nil }, runtime.cwd, time.Hour)

	first := collect(t, exec, &a2asrv.ExecutorContext{TaskID: "task-1", ContextID: "ctx-1", Message: textMessage("run ls")})
	// SUBMITTED, artifact "before", artifact last-chunk + working flush, INPUT_REQUIRED
	inputRequired, ok := first[len(first)-1].(*a2alib.TaskStatusUpdateEvent)
	if !ok || inputRequired.Status.State != a2alib.TaskStateInputRequired {
		t.Fatalf("expected INPUT_REQUIRED, got %#v", first[len(first)-1])
	}
	requestData, ok := inputRequired.Status.Message.Parts[0].Content.(a2alib.Data)
	if !ok {
		t.Fatalf("permission part = %#v", inputRequired.Status.Message.Parts[0])
	}
	request, ok := requestData.Value.(PermissionRequestData)
	if !ok || request.Yukino != PermissionRequestKind || request.ToolName != "Bash" || request.PermissionID == "" || request.Reason != "Mode: default" {
		t.Fatalf("permission request = %#v", requestData.Value)
	}
	if request.Source == nil || request.Source.AgentName != "main" || request.Source.Cwd != "/srv/a2a" {
		t.Fatalf("permission source = %#v", request.Source)
	}

	// Answer with a permission-response data part on the same task.
	response := &a2alib.Message{
		ID:   a2alib.NewMessageID(),
		Role: a2alib.MessageRoleUser,
		Parts: []*a2alib.Part{DataPart(map[string]any{
			"yukino":       PermissionResponseKind,
			"permissionId": request.PermissionID,
			"decision":     "allow",
		})},
		TaskID: "task-1",
	}
	second := collect(t, exec, &a2asrv.ExecutorContext{TaskID: "task-1", ContextID: "ctx-1", Message: response})

	working, ok := second[0].(*a2alib.Task)
	if !ok || working.Status.State != a2alib.TaskStateWorking {
		t.Fatalf("resume snapshot = %#v", second[0])
	}
	terminal, ok := second[len(second)-1].(*a2alib.TaskStatusUpdateEvent)
	if !ok || terminal.Status.State != a2alib.TaskStateCompleted {
		t.Fatalf("terminal = %#v", second[len(second)-1])
	}
	select {
	case reply := <-permCh:
		t.Fatalf("permission channel must be consumed, got %+v", reply)
	default:
	}
	// The "allowed" text flowed through after the decision.
	sawAllowed := false
	for _, event := range second {
		if artifact, ok := event.(*a2alib.TaskArtifactUpdateEvent); ok {
			for _, part := range artifact.Artifact.Parts {
				if strings.Contains(part.Text(), "allowed") {
					sawAllowed = true
				}
			}
		}
	}
	if !sawAllowed {
		t.Error("expected the post-permission text in the resumed events")
	}
}

func TestExecutorPermissionDeniedOnCancel(t *testing.T) {
	permCh := make(chan agent.PermissionReply, 1)
	started := make(chan struct{})
	var replyMu sync.Mutex
	var receivedReply *agent.PermissionReply
	runtime := &fakeRuntime{
		sessionID: "sess-1",
		cwd:       t.TempDir(),
		script: func(_ string, emit func(agent.AgentEvent), aborted func() bool) {
			close(started)
			emit(agent.PermissionRequestEvent{
				ToolID:     "tc-1",
				ToolName:   "Bash",
				Decision:   permissions.Decision{Effect: permissions.Ask, Reason: "ask"},
				ResponseCh: permCh,
			})
			reply := <-permCh
			replyMu.Lock()
			receivedReply = &reply
			replyMu.Unlock()
			emit(agent.LoopComplete{StopReason: "interrupted"})
		},
	}
	exec := NewExecutor(func(cwd, sessionID string) (Runtime, error) { return runtime, nil }, runtime.cwd, time.Hour)

	done := make(chan []a2alib.Event, 1)
	go func() {
		events := make([]a2alib.Event, 0)
		for event, err := range exec.Execute(context.Background(), &a2asrv.ExecutorContext{TaskID: "task-1", ContextID: "ctx-1", Message: textMessage("hi")}) {
			if err != nil {
				panic(err)
			}
			events = append(events, event)
		}
		done <- events
	}()
	<-started
	// The first request returns once INPUT_REQUIRED settles, mirroring a
	// client that receives the response before sending CancelTask.
	var first []a2alib.Event
	select {
	case first = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("first request did not settle at INPUT_REQUIRED")
	}
	if len(first) == 0 {
		t.Fatal("first request must have produced events")
	}
	inputRequired, ok := first[len(first)-1].(*a2alib.TaskStatusUpdateEvent)
	if !ok || inputRequired.Status.State != a2alib.TaskStateInputRequired {
		t.Fatalf("expected INPUT_REQUIRED, got %#v", first[len(first)-1])
	}

	cancelEvents := collectCancel(t, exec, &a2asrv.ExecutorContext{TaskID: "task-1", ContextID: ""})
	terminal, ok := cancelEvents[len(cancelEvents)-1].(*a2alib.TaskStatusUpdateEvent)
	if !ok || terminal.Status.State != a2alib.TaskStateCanceled {
		t.Fatalf("cancel terminal = %#v", cancelEvents[len(cancelEvents)-1])
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		replyMu.Lock()
		reply := receivedReply
		replyMu.Unlock()
		if reply != nil {
			if reply.Response != agent.PermDeny {
				t.Errorf("pending permission must resolve to deny, got %+v", reply)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("pending permission was not resolved on cancel")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func collectCancel(t *testing.T, exec *Executor, execCtx *a2asrv.ExecutorContext) []a2alib.Event {
	t.Helper()
	var events []a2alib.Event
	for event, err := range exec.Cancel(context.Background(), execCtx) {
		if err != nil {
			t.Fatalf("cancel error: %v", err)
		}
		events = append(events, event)
	}
	return events
}

func TestExecutorCancelWithoutRun(t *testing.T) {
	exec := NewExecutor(func(cwd, sessionID string) (Runtime, error) {
		t.Fatal("no runtime must be created")
		return nil, nil
	}, t.TempDir(), time.Hour)
	events := collectCancel(t, exec, &a2asrv.ExecutorContext{TaskID: "task-x", ContextID: ""})
	update, ok := events[0].(*a2alib.TaskStatusUpdateEvent)
	if !ok || update.Status.State != a2alib.TaskStateCanceled || update.Status.Message.Parts[0].Text() != TaskCanceledText {
		t.Fatalf("cancel = %#v", events[0])
	}
}

func TestExecutorDispose(t *testing.T) {
	runtime := &fakeRuntime{
		sessionID: "sess-1",
		cwd:       t.TempDir(),
		script:    simpleScript(agent.LoopComplete{StopReason: "end_turn"}),
	}
	exec := NewExecutor(func(cwd, sessionID string) (Runtime, error) { return runtime, nil }, runtime.cwd, time.Hour)
	collect(t, exec, &a2asrv.ExecutorContext{TaskID: "task-1", ContextID: "ctx-1", Message: textMessage("hi")})
	exec.Dispose()
	runtime.mu.Lock()
	disposed := runtime.disposed
	runtime.mu.Unlock()
	if !disposed {
		t.Error("dispose must dispose the runtime")
	}
	if exec.getSession("ctx-1") != nil {
		t.Error("dispose must clear sessions")
	}
}

func TestExecutorContextMappingPersistence(t *testing.T) {
	cwd := t.TempDir()
	newRuntime := func(sessionID string) *fakeRuntime {
		return &fakeRuntime{sessionID: sessionID, cwd: cwd, script: simpleScript(agent.LoopComplete{StopReason: "end_turn"})}
	}
	factoryCalls := make(chan string, 2*MaxTrackedSessions+2)
	exec := NewExecutor(func(_, sessionID string) (Runtime, error) {
		factoryCalls <- sessionID
		if sessionID == "" {
			return newRuntime("sess-lru"), nil
		}
		return newRuntime(sessionID), nil
	}, cwd, time.Hour)

	// Fill the tracked-session map; the first session is the least recently
	// used one and gets evicted (with its mapping persisted) on overflow.
	for i := 0; i < MaxTrackedSessions; i++ {
		contextID := fmt.Sprintf("ctx-%03d", i)
		collect(t, exec, &a2asrv.ExecutorContext{TaskID: a2alib.TaskID(fmt.Sprintf("task-%03d", i)), ContextID: contextID, Message: textMessage("hi")})
	}
	collect(t, exec, &a2asrv.ExecutorContext{TaskID: "task-overflow", ContextID: "ctx-overflow", Message: textMessage("hi")})

	if exec.getSession("ctx-000") != nil {
		t.Fatal("the least-recently-used session must be evicted on overflow")
	}
	path, err := exec.contextMappingPath("ctx-000")
	if err != nil {
		t.Fatal(err)
	}
	data, err := readFileForTest(path)
	if err != nil {
		t.Fatalf("mapping not persisted: %v", err)
	}
	if string(data) != "sess-lru" {
		t.Errorf("mapping = %q, want sess-lru", data)
	}

	// A new executor for the same cwd restores the session id from the mapping.
	exec2 := NewExecutor(func(_, sessionID string) (Runtime, error) {
		factoryCalls <- sessionID
		return newRuntime(sessionID), nil
	}, cwd, time.Hour)
	collect(t, exec2, &a2asrv.ExecutorContext{TaskID: "task-restore", ContextID: "ctx-000", Message: textMessage("again")})
	drained := false
	for !drained {
		select {
		case id := <-factoryCalls:
			if id == "sess-lru" {
				drained = true
			}
		default:
			drained = true
		}
	}
	session := exec2.getSession("ctx-000")
	if session == nil {
		t.Fatal("session must be recreated")
	}
	session.mu.Lock()
	restored := session.sessionID
	session.mu.Unlock()
	if restored != "sess-lru" {
		t.Errorf("restored session id = %q, want sess-lru", restored)
	}
}

func TestExecutorIdleEviction(t *testing.T) {
	cwd := t.TempDir()
	runtime := &fakeRuntime{sessionID: "sess-1", cwd: cwd, script: simpleScript(agent.LoopComplete{StopReason: "end_turn"})}
	exec := NewExecutor(func(_, sessionID string) (Runtime, error) { return runtime, nil }, cwd, 30*time.Millisecond)
	collect(t, exec, &a2asrv.ExecutorContext{TaskID: "task-1", ContextID: "ctx-idle", Message: textMessage("hi")})

	deadline := time.Now().Add(3 * time.Second)
	for {
		runtime.mu.Lock()
		disposed := runtime.disposed
		runtime.mu.Unlock()
		if disposed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("idle runtime was not evicted")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// The session entry survives eviction so the transcript can be restored.
	if session := exec.getSession("ctx-idle"); session == nil {
		t.Error("eviction must keep the session entry")
	} else {
		session.mu.Lock()
		hasRuntime := session.runtime != nil
		session.mu.Unlock()
		if hasRuntime {
			t.Error("eviction must release the runtime")
		}
	}
}

func readFileForTest(path string) ([]byte, error) {
	return os.ReadFile(path)
}
