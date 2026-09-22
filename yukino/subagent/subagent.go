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

package subagent

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/agent"
	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

type TaskStatus string

const (
	TaskPending   TaskStatus = "pending"
	TaskRunning   TaskStatus = "running"
	TaskCompleted TaskStatus = "completed"
	TaskFailed    TaskStatus = "failed"
	TaskCancelled TaskStatus = "cancelled"
)

type Task struct {
	ID        string
	Name      string
	Status    TaskStatus
	Output    string
	Error     string
	CreatedAt time.Time
	DoneAt    time.Time
	Cancel    context.CancelFunc
	// Kind is what the task wraps ("agent" or "shell"; TS TaskKind). Empty means
	// "agent". Hosts use it to wait selectively (e.g. block on agent tasks but
	// not on long-running shell tasks).
	Kind string
	// OriginToolCallID links the task to the tool_use that spawned it (TS
	// originToolCallId), so hosts can attribute results back to the call.
	OriginToolCallID string
	// Done is closed when the task reaches a terminal state (completed, failed,
	// or cancelled). Waiters block on it (TS: the task's done promise).
	Done      chan struct{}
	closeOnce sync.Once

	// settled reports that the runner finished (TS: the id left
	// pendingTaskIds). DrainNotifications only surfaces settled tasks, so a
	// cancelled task is notified once its runner's post-kill cleanup ran.
	settled bool
	// notified marks the task surfaced by DrainNotifications (TS
	// notifiedTaskIds) so each task is announced exactly once.
	notified bool
}

type TaskManager struct {
	mu        sync.Mutex
	tasks     map[string]*Task
	taskOrder []string // insertion order, mirroring the TS Map
	nextID    int
	// listeners are notified with a snapshot of all tasks on every state change
	// (TS subscribe/emitChange). Keyed by an incrementing id so Subscribe can
	// return a working unsubscribe (Go funcs are not comparable).
	listeners      map[int]func([]*Task)
	nextListenerID int
}

type TaskNotification struct {
	TaskID string
	Name   string
	Status TaskStatus
	Output string
}

// FormatAgentTaskNotification renders one drained background-task
// notification (TS: formatAgentTaskNotification, task-manager.ts:228-235).
func FormatAgentTaskNotification(n TaskNotification) string {
	return strings.Join([]string{
		`<task-notification task_id="` + n.TaskID + `" status="` + string(n.Status) + `">`,
		"name=" + n.Name,
		n.Output,
		"</task-notification>",
	}, "\n")
}

// SubagentInterruptedMarker is appended to a subagent's output when its run
// was interrupted (TS: SUBAGENT_INTERRUPTED_MARKER, spawn.ts:49). Shared with
// the host so restored transcripts can render interrupted Agent cards with the
// same "stopped" styling as live ones.
const SubagentInterruptedMarker = "[Interrupted]"

// attachPerRunTaskManager creates the per-run background task registry (TS
// spawn.ts:141-160: every subagent run gets its own TaskManager) and wires it
// onto the agent: shells backgrounded inside this run register here and
// notify this run's own loop, not the host's. The caller must invoke StopAll
// on the returned manager when the run settles (TS: await
// taskManager?.stopAll()).
func attachPerRunTaskManager(ag *agent.Agent) *TaskManager {
	runMgr := NewTaskManager()
	ag.BackgroundTaskManager = runMgr
	ag.NotificationFn = func() []string {
		notes := runMgr.DrainNotifications()
		out := make([]string, 0, len(notes))
		for _, n := range notes {
			out = append(out, FormatAgentTaskNotification(n))
		}
		return out
	}
	return runMgr
}

func NewTaskManager() *TaskManager {
	return &TaskManager{
		tasks:     make(map[string]*Task),
		listeners: make(map[int]func([]*Task)),
	}
}

// CreateTask creates a background task (TS task-manager create()). The id is
// `<prefix>-<n>` with the prefix defaulting to "agent"; shell tools pass
// "bash"/"ps" together with kind "shell" and the spawning tool_use id.
func (tm *TaskManager) CreateTask(name string, opts tools.BackgroundTaskOptions) string {
	tm.mu.Lock()
	tm.nextID++
	prefix := opts.IDPrefix
	if prefix == "" {
		prefix = "agent"
	}
	id := fmt.Sprintf("%s-%d", prefix, tm.nextID)
	tm.tasks[id] = &Task{
		ID:   id,
		Name: name,
		// TS create() sets status "running" synchronously; its internal
		// pendingTaskIds set tracks the unsettled runner, not a visible
		// "pending" status (which TS never produces).
		Status:           TaskRunning,
		CreatedAt:        time.Now(),
		Kind:             opts.Kind,
		OriginToolCallID: opts.OriginToolCallID,
		Done:             make(chan struct{}),
	}
	tm.taskOrder = append(tm.taskOrder, id)
	tm.mu.Unlock()
	tm.emitChange()
	return id
}

func (tm *TaskManager) GetTask(id string) *Task {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	return tm.tasks[id]
}

// ListTasks returns all tasks in creation order (TS: [...this.tasks.values()]
// over the Map's insertion order).
func (tm *TaskManager) ListTasks() []*Task {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	return tm.snapshotLocked()
}

func (tm *TaskManager) SetRunning(id string, cancel context.CancelFunc) {
	tm.mu.Lock()
	if t, ok := tm.tasks[id]; ok {
		t.Status = TaskRunning
		t.Cancel = cancel
	}
	tm.mu.Unlock()
	tm.emitChange()
}

// settleLocked marks the runner finished, closes Done and stamps DoneAt (TS:
// the task promise's finally block removes the id from pendingTaskIds and
// emits). Callers must hold tm.mu.
func (tm *TaskManager) settleLocked(t *Task) {
	if t.settled {
		return
	}
	t.settled = true
	t.DoneAt = time.Now()
	t.closeOnce.Do(func() { close(t.Done) })
}

// SetCompleted records a successful runner result. A late result after
// cancellation is discarded (TS): the task stays cancelled with its "Stopped
// by user" output.
func (tm *TaskManager) SetCompleted(id, output string) {
	tm.mu.Lock()
	t, ok := tm.tasks[id]
	if ok {
		if t.Status == TaskRunning {
			t.Status = TaskCompleted
			t.Output = output
		}
		tm.settleLocked(t)
	}
	tm.mu.Unlock()
	if ok {
		tm.emitChange()
	}
}

// SetFailed records a plain runner failure (TS: a non-TaskFailure rejection —
// the task carries "Error: <message>"). A failure arriving after cancellation
// is discarded: the task keeps its "Stopped by user" output.
func (tm *TaskManager) SetFailed(id, errMsg string) {
	tm.mu.Lock()
	t, ok := tm.tasks[id]
	if ok {
		if t.Status == TaskRunning {
			t.Status = TaskFailed
			t.Error = errMsg
			t.Output = errMsg
		}
		tm.settleLocked(t)
	}
	tm.mu.Unlock()
	if ok {
		tm.emitChange()
	}
}

// SetTaskFailure stores a runner failure that carries its own pre-formatted
// output (TS: TaskFailure). On a running task it behaves like SetFailed; on a
// cancelled task it replaces the generic "Stopped by user" placeholder with
// the deliberately formatted output — e.g. a killed background shell's
// captured output and exit facts — because the status attribute already says
// "cancelled" (TS task-manager.ts catch branch).
func (tm *TaskManager) SetTaskFailure(id, output string) {
	tm.mu.Lock()
	t, ok := tm.tasks[id]
	if ok {
		switch t.Status {
		case TaskRunning:
			t.Status = TaskFailed
			t.Error = output
			t.Output = output
		case TaskCancelled:
			t.Output = output
		}
		tm.settleLocked(t)
	}
	tm.mu.Unlock()
	if ok {
		tm.emitChange()
	}
}

// DrainNotifications returns every settled task not yet announced (TS
// drainNotifications: status !== "running", not pending, not notified).
// Cancelled tasks are included once their runner settled, so a stopped
// background shell's final output reaches the model.
func (tm *TaskManager) DrainNotifications() []TaskNotification {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	var out []TaskNotification
	for _, id := range tm.taskOrder {
		t := tm.tasks[id]
		if t == nil || t.settled == false || t.notified {
			continue
		}
		if t.Status == TaskRunning || t.Status == TaskPending {
			continue
		}
		t.notified = true
		out = append(out, TaskNotification{
			TaskID: t.ID,
			Name:   t.Name,
			Status: t.Status,
			Output: t.Output,
		})
	}
	return out
}

func (tm *TaskManager) AdoptRunning(name string, eventCh <-chan agent.AgentEvent, cancel context.CancelFunc) string {
	taskID := tm.CreateTask("adopted: "+truncate(name, 40), tools.BackgroundTaskOptions{})
	tm.SetRunning(taskID, cancel)

	go func() {
		var output strings.Builder
		for ev := range eventCh {
			switch e := ev.(type) {
			case agent.StreamText:
				output.WriteString(e.Text)
			case agent.ErrorEvent:
				tm.SetFailed(taskID, e.Message)
				return
			}
		}
		tm.SetCompleted(taskID, output.String())
	}()

	return taskID
}

func (tm *TaskManager) FindByName(name string) *Task {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	for _, id := range tm.taskOrder {
		t := tm.tasks[id]
		if t != nil && (t.Name == name || strings.HasPrefix(t.Name, name+":")) {
			return t
		}
	}
	return nil
}

// CancelTask stops a running (or not-yet-started) task (TS: stop). The
// notification is not emitted here: like TS, the task is surfaced by
// DrainNotifications once its runner settles, so a SetTaskFailure arriving
// after the cancel still shapes the announced output.
func (tm *TaskManager) CancelTask(id string) bool {
	tm.mu.Lock()
	t, ok := tm.tasks[id]
	if !ok || (t.Status != TaskRunning && t.Status != TaskPending) || t.Cancel == nil {
		tm.mu.Unlock()
		return false
	}
	t.Cancel()
	t.Status = TaskCancelled
	t.Output = "Stopped by user"
	tm.mu.Unlock()
	tm.emitChange()
	return true
}

// TaskState adapts the manager to teams.BackgroundTaskBoard, letting TaskStop
// resolve a task_id (TS: TaskManager.get(id)?.status). teams cannot import
// this package, so the host links the two through the interface.
func (tm *TaskManager) TaskState(id string) (string, bool) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	t, ok := tm.tasks[id]
	if !ok {
		return "", false
	}
	return string(t.Status), true
}

// StopTask adapts the manager to teams.BackgroundTaskBoard. TS task-stop.ts
// awaits stopAndWait, so the stop blocks until the task settles.
func (tm *TaskManager) StopTask(id string) bool { return tm.StopAndWait(id) }

// snapshotLocked returns all tasks in creation order. Callers must hold tm.mu.
func (tm *TaskManager) snapshotLocked() []*Task {
	out := make([]*Task, 0, len(tm.taskOrder))
	for _, id := range tm.taskOrder {
		if t := tm.tasks[id]; t != nil {
			out = append(out, t)
		}
	}
	return out
}

// emitChange notifies subscribers with a snapshot of all tasks (TS emitChange).
// Listeners are invoked outside the lock so they may call back into the manager.
func (tm *TaskManager) emitChange() {
	tm.mu.Lock()
	tasks := tm.snapshotLocked()
	listeners := make([]func([]*Task), 0, len(tm.listeners))
	for _, l := range tm.listeners {
		listeners = append(listeners, l)
	}
	tm.mu.Unlock()
	for _, l := range listeners {
		l(tasks)
	}
}

// Subscribe registers a listener notified with the full task list on every
// state change (and immediately with the current list). It returns an
// unsubscribe function (TS subscribe).
func (tm *TaskManager) Subscribe(listener func([]*Task)) func() {
	tm.mu.Lock()
	id := tm.nextListenerID
	tm.nextListenerID++
	tm.listeners[id] = listener
	tasks := tm.snapshotLocked()
	tm.mu.Unlock()
	listener(tasks)
	return func() {
		tm.mu.Lock()
		defer tm.mu.Unlock()
		delete(tm.listeners, id)
	}
}

// HasRunning reports whether any task is still running (TS hasRunning).
func (tm *TaskManager) HasRunning() bool {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	for _, t := range tm.tasks {
		if t.Status == TaskRunning {
			return true
		}
	}
	return false
}

// StopAndWait cancels a running task and blocks until it settles (TS
// stopAndWait). Returns false when the task does not exist.
func (tm *TaskManager) StopAndWait(id string) bool {
	tm.mu.Lock()
	t, ok := tm.tasks[id]
	tm.mu.Unlock()
	if !ok {
		return false
	}
	stopped := tm.CancelTask(id)
	<-t.Done
	return stopped
}

// StopAll cancels every not-yet-settled task and blocks until they all settle
// (TS stopAll: stop the pending tasks, then await allSettled). Used on
// teardown so backgrounded work cannot outlive its owner.
func (tm *TaskManager) StopAll() {
	tm.mu.Lock()
	var pending []*Task
	for _, id := range tm.taskOrder {
		if t := tm.tasks[id]; t != nil && !t.settled {
			pending = append(pending, t)
		}
	}
	tm.mu.Unlock()
	for _, t := range pending {
		tm.CancelTask(t.ID)
	}
	for _, t := range pending {
		<-t.Done
	}
}

// WaitAll blocks until every task settles. An optional filter selects which
// tasks to wait for (TS waitAll); e.g. wait only for agent-kind tasks while
// long-running shell tasks are stopped rather than awaited.
func (tm *TaskManager) WaitAll(filter func(*Task) bool) {
	tm.mu.Lock()
	var tasks []*Task
	for _, id := range tm.taskOrder {
		t := tm.tasks[id]
		if t != nil && (filter == nil || filter(t)) {
			tasks = append(tasks, t)
		}
	}
	tm.mu.Unlock()
	for _, t := range tasks {
		<-t.Done
	}
}

// Clear removes every task (TS clear).
func (tm *TaskManager) Clear() {
	tm.mu.Lock()
	tm.tasks = make(map[string]*Task)
	tm.taskOrder = nil
	tm.mu.Unlock()
	tm.emitChange()
}

// SubAgentSpec captures the runtime-relevant subset of BaseAgentDefinition. It is the bridge
// between the load layer (AgentDefinition) and the execution layer (runSync / runAsync / runFork).
// Built-in agents skip file parsing and instantiate this directly via BuiltinSpecs.
type SubAgentSpec struct {
	Name                 string
	Description          string
	Tools                []string
	DisallowedTools      []string
	SystemPromptOverride string
	MaxTurns             int
	Model                string

	// PermissionMode overrides the parent agent's permission mode while the sub-agent runs. Empty
	// string means inherit from parent.
	PermissionMode string

	// Background marks the definition as async: the spawn applies the async
	// tool allowlist (TS: `background || !!definition.background` feeds
	// spawnSubagent's isAsync), while only the call-level run_in_background
	// detaches the tool call into a background task.
	Background bool

	// Isolation selects a file-system isolation mode; "worktree" creates a temporary git worktree.
	Isolation IsolationMode

	// InitialPrompt is prepended to the first user turn.
	InitialPrompt string

	// OmitMarkdown drops the AGENTS.md hierarchy from the sub-agent's userContext.
	OmitMarkdown bool

	// Skills are skill names to preload when the sub-agent starts.
	Skills []string

	// Memory enables persistent memory in one of three scopes.
	Memory AgentMemoryScope

	// McpServers / RequiredMcpServers / Hooks / Effort carry frontmatter data forward so future
	// channels can consume it without another schema migration.
	McpServers         []any
	RequiredMcpServers []string
	Hooks              any
	Effort             any
}

// BuiltinSpecs mirrors the TS BUILTIN_AGENTS (definition.ts:43-64). plan and
// explore run in permissionMode "plan" so write commands are blocked at the
// permission layer, not just by the disallowed-tools list.
var BuiltinSpecs = map[string]SubAgentSpec{
	"general-purpose": {
		Name:        "general-purpose",
		Description: "General-purpose agent for researching complex questions, exploring codebase, and executing multi-step tasks.",
	},
	"plan": {
		Name:            "plan",
		Description:     "Investigate the existing architecture and propose a concrete implementation plan with relevant files, constraints, and verification steps. Read-only: do not create, edit, or delete files. Return unresolved questions to the parent agent.",
		DisallowedTools: []string{"EditFile", "WriteFile"},
		PermissionMode:  "plan",
	},
	"explore": {
		Name:            "explore",
		Description:     "Find code, trace relevant call paths, and report evidence with file paths and line numbers. Use Glob, Grep, ReadFile, and read-only shell commands. Do not modify files; return missing context or blockers to the parent agent.",
		DisallowedTools: []string{"EditFile", "WriteFile"},
		PermissionMode:  "plan",
		Model:           "haiku",
	},
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}
