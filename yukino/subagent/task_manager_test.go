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
	"strings"
	"testing"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

// The tool's description field and the schema description mirror the TS
// AgentTool (agent-tool.ts:75 + buildDescription).
func TestAgentToolDescriptionMatchesTS(t *testing.T) {
	tool := &AgentTool{}
	if got := tool.Description(); got != "Launch a subagent to handle complex, multi-step tasks." {
		t.Errorf("Description() = %q", got)
	}

	schema := tool.Schema()
	desc, _ := schema["description"].(string)
	for _, want := range []string{
		"Delegate a bounded task to a subagent.",
		"Omitting subagent_type forks a snapshot of the current conversation.",
		"Available roles (pass a role as subagent_type, not as a tool name):",
		"- general-purpose: General-purpose agent for researching complex questions, exploring codebase, and executing multi-step tasks.",
		"Foreground calls return results inline.",
		"Worktree isolation separates edits but does not merge them.",
	} {
		if !strings.Contains(desc, want) {
			t.Errorf("schema description missing %q", want)
		}
	}

	// forkDisabled switches the context sentence and the subagent_type help.
	disabled := &AgentTool{ForkDisabled: true}
	ddesc, _ := disabled.Schema()["description"].(string)
	if !strings.Contains(ddesc, "Omitting subagent_type selects general-purpose.") {
		t.Errorf("forkDisabled schema description missing the general-purpose sentence")
	}
}

// The fork boilerplate must be byte-identical to the TS FORK_BOILERPLATE
// (agent-tool.ts:68-71): it is model-visible text injected into every fork.
func TestForkBoilerplateMatchesTS(t *testing.T) {
	want := "<fork_boilerplate>\n" +
		"You are a forked Yukino worker, not the parent agent. The inherited conversation is background context; work only on the assignment that follows.\n" +
		"Do not fork again or ask the user for confirmation. Respect current permissions and report blockers to the parent. Return a concise account of findings or changes, relevant paths, checks actually run, and remaining work.\n" +
		"</fork_boilerplate>"
	if forkBoilerplate != want {
		t.Errorf("forkBoilerplate diverged from TS:\n%s", forkBoilerplate)
	}
}

// startBackground names the task after the tool's description argument and
// returns the TS startBackground message (agent-tool.ts:396-399); a failing
// runner surfaces as "Error: <output>" (task-manager.ts catch branch).
func TestStartBackgroundNamesTaskAfterDescription(t *testing.T) {
	tm := NewTaskManager()
	tool := &AgentTool{TaskMgr: tm}

	res := tool.startBackground("verify the build", context.Background(), func(ctx context.Context) tools.ToolResult {
		return tools.ToolResult{Output: "all green"}
	})
	want := "Background agent 'verify the build' started (task_id: agent-1). Its result will arrive as a task notification."
	if res.Output != want {
		t.Errorf("output = %q, want %q", res.Output, want)
	}

	task := tm.GetTask("agent-1")
	if task == nil {
		t.Fatal("task agent-1 not registered")
	}
	if task.Name != "verify the build" {
		t.Errorf("task name = %q, want the description argument", task.Name)
	}
	<-task.Done
	notes := tm.DrainNotifications()
	if len(notes) != 1 || notes[0].Output != "all green" || notes[0].Status != TaskCompleted {
		t.Errorf("unexpected notifications: %+v", notes)
	}

	// A failing runner is wrapped as "Error: <output>" (TS: throw
	// Error(result.output) → task-manager catch).
	res = tool.startBackground("doomed", context.Background(), func(ctx context.Context) tools.ToolResult {
		return tools.ToolResult{Output: "Agent error: boom", IsError: true}
	})
	if !strings.Contains(res.Output, "task_id: agent-2") {
		t.Errorf("second task id missing: %q", res.Output)
	}
	task2 := tm.GetTask("agent-2")
	<-task2.Done
	notes = tm.DrainNotifications()
	if len(notes) != 1 || notes[0].Output != "Error: Agent error: boom" || notes[0].Status != TaskFailed {
		t.Errorf("unexpected failure notifications: %+v", notes)
	}
}

// Cancelled tasks are drained once their runner settles, carrying the
// "Stopped by user" output (TS: stop() + drainNotifications).
func TestTaskManagerDrainsCancelledAfterSettle(t *testing.T) {
	tm := NewTaskManager()
	id := tm.CreateTask("bg", tools.BackgroundTaskOptions{})
	release := make(chan struct{})
	tm.SetRunning(id, func() {})

	go func() {
		<-release
		tm.SetCompleted(id, "late result")
	}()

	if !tm.CancelTask(id) {
		t.Fatal("CancelTask on a running task should succeed")
	}
	// Not yet settled: nothing to drain.
	if notes := tm.DrainNotifications(); len(notes) != 0 {
		t.Fatalf("unsettled task must not be drained yet: %+v", notes)
	}
	close(release)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if notes := tm.DrainNotifications(); len(notes) == 1 {
			if notes[0].Status != TaskCancelled || notes[0].Output != "Stopped by user" {
				t.Fatalf("cancelled notification = %+v", notes[0])
			}
			// Late results after cancellation are discarded (TS).
			if got := tm.GetTask(id).Output; got != "Stopped by user" {
				t.Fatalf("late result overwrote the stopped output: %q", got)
			}
			// Each task is announced exactly once.
			if again := tm.DrainNotifications(); len(again) != 0 {
				t.Fatalf("task drained twice: %+v", again)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("cancelled task was never drained")
}

// SetTaskFailure replaces the generic "Stopped by user" placeholder on a
// cancelled task (TS: the TaskFailure catch branch) so a killed background
// shell's captured output reaches the notification intact.
func TestTaskManagerSetTaskFailureReplacesCancelledOutput(t *testing.T) {
	tm := NewTaskManager()
	id := tm.CreateTask("shell", tools.BackgroundTaskOptions{})
	tm.SetRunning(id, func() {})
	tm.CancelTask(id)

	tm.SetTaskFailure(id, "exit code 137 (SIGKILL)\npartial output")
	notes := tm.DrainNotifications()
	if len(notes) != 1 {
		t.Fatalf("expected 1 notification, got %+v", notes)
	}
	if notes[0].Status != TaskCancelled {
		t.Errorf("status = %q, want cancelled", notes[0].Status)
	}
	if !strings.Contains(notes[0].Output, "exit code 137") {
		t.Errorf("TaskFailure output must replace the placeholder: %q", notes[0].Output)
	}
}

// DrainNotifications preserves creation order (TS: list() over the Map's
// insertion order).
func TestTaskManagerDrainKeepsCreationOrder(t *testing.T) {
	tm := NewTaskManager()
	for _, name := range []string{"first", "second", "third"} {
		id := tm.CreateTask(name, tools.BackgroundTaskOptions{})
		tm.SetRunning(id, func() {})
		tm.SetCompleted(id, name+" done")
	}
	notes := tm.DrainNotifications()
	if len(notes) != 3 {
		t.Fatalf("expected 3 notifications, got %d", len(notes))
	}
	for i, want := range []string{"first", "second", "third"} {
		if notes[i].Name != want {
			t.Errorf("notes[%d].Name = %q, want %q", i, notes[i].Name, want)
		}
	}
}
