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

package teams

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

// Single-team invariant (TS: TeamCreateTool calls mgr.deleteAll() before
// create): creating a team sweeps every other team from memory and disk, so
// the requested name is always free and never gets a disambiguation suffix.
func TestTeamCreateSweepsOtherTeams(t *testing.T) {
	base := t.TempDir()
	tm := NewTeamManager(base, base)
	old := tm.CreateTeam("alpha")
	old.AddMember("alice")

	// Residual team directory from a previous session: on disk but not in
	// memory, so it never appears in ListTeams.
	residualDir := filepath.Join(base, sanitizeTeamName("leftover"))
	if err := os.MkdirAll(filepath.Join(residualDir, "inboxes"), 0o755); err != nil {
		t.Fatalf("seed residual dir: %v", err)
	}

	tool := &TeamCreateTool{TeamMgr: tm}
	res := tool.Execute(context.Background(), map[string]any{"team_name": "beta"})
	if res.IsError {
		t.Fatalf("TeamCreate errored: %s", res.Output)
	}
	if !strings.Contains(res.Output, "Team 'beta' created (mode: in-process)") {
		t.Errorf("unexpected output: %s", res.Output)
	}

	if names := tm.ListTeams(); len(names) != 1 || names[0] != "beta" {
		t.Errorf("ListTeams = %v, want [beta] only", names)
	}
	if _, err := os.Stat(old.dir()); !os.IsNotExist(err) {
		t.Errorf("old team dir should be removed, stat err = %v", err)
	}
	if _, err := os.Stat(residualDir); !os.IsNotExist(err) {
		t.Errorf("residual team dir should be removed, stat err = %v", err)
	}
}

// Recreating the same name must reuse it verbatim — the sweep frees the name,
// so no "-2" suffix may appear (TS: no suffix disambiguation needed).
func TestTeamCreateSameNameNoSuffix(t *testing.T) {
	tm := newTmpManager(t)
	tm.CreateTeam("squad")

	tool := &TeamCreateTool{TeamMgr: tm}
	res := tool.Execute(context.Background(), map[string]any{"team_name": "squad"})
	if res.IsError {
		t.Fatalf("TeamCreate errored: %s", res.Output)
	}
	if names := tm.ListTeams(); len(names) != 1 || names[0] != "squad" {
		t.Errorf("ListTeams = %v, want [squad] (no suffix)", names)
	}
}

func TestDeleteAllRemovesMemoryAndDisk(t *testing.T) {
	base := t.TempDir()
	tm := NewTeamManager(base, base)
	tm.CreateTeam("one")
	tm.CreateTeam("two")
	if err := os.MkdirAll(filepath.Join(base, "three"), 0o755); err != nil {
		t.Fatalf("seed residual dir: %v", err)
	}

	tm.DeleteAll()

	if names := tm.ListTeams(); len(names) != 0 {
		t.Errorf("ListTeams = %v, want empty", names)
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		t.Fatalf("read base dir: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("team dirs remain on disk: %v", entries)
	}
}

// TeamDelete takes `name`, not `team_name` (TS: TeamDeleteTool schema). The
// TS tool deletes unconditionally — a missing (or empty) name is a no-op that
// still reports success.
func TestTeamDeleteUsesNameParam(t *testing.T) {
	tm := newTmpManager(t)
	tm.CreateTeam("doomed")
	tool := &TeamDeleteTool{TeamMgr: tm}

	res := tool.Execute(context.Background(), map[string]any{"team_name": "doomed"})
	if res.IsError {
		t.Fatalf("TS TeamDelete never errors on an unknown name: %s", res.Output)
	}
	if want := "Team '' deleted."; res.Output != want {
		t.Errorf("legacy team_name param should delete the empty name, got %q", res.Output)
	}
	if tm.GetTeam("doomed") == nil {
		t.Error("the doomed team must survive a delete keyed on the wrong param")
	}

	res = tool.Execute(context.Background(), map[string]any{"name": "doomed"})
	if res.IsError {
		t.Fatalf("TeamDelete(name) errored: %s", res.Output)
	}
	if want := "Team 'doomed' deleted."; res.Output != want {
		t.Errorf("output = %q, want %q", res.Output, want)
	}
	if tm.GetTeam("doomed") != nil {
		t.Error("team should be gone after TeamDelete")
	}
}

// Orchestration tools are category read so default/acceptEdits modes
// auto-allow them (TS: teams/tools.ts category = "read"); TaskStop stays a
// command (TS: teams/task-stop.ts category = "command").
func TestOrchestrationToolCategories(t *testing.T) {
	readTools := []tools.Tool{
		&TeamCreateTool{},
		&SendMessageTool{},
		&TeamDeleteTool{},
		&SpawnTeammateTool{},
		&ListTeamsTool{},
	}
	for _, tool := range readTools {
		if tool.Category() != tools.CategoryRead {
			t.Errorf("%s category = %q, want %q", tool.Name(), tool.Category(), tools.CategoryRead)
		}
	}
	if got := (&TaskStopTool{}).Category(); got != tools.CategoryCommand {
		t.Errorf("TaskStop category = %q, want %q", got, tools.CategoryCommand)
	}
}

func TestSpawnTeammateToolValidation(t *testing.T) {
	tm := newTmpManager(t)
	tool := &SpawnTeammateTool{TeamMgr: tm, Spawn: func(*Team, string, string) error { return nil }}
	for _, args := range []map[string]any{
		{"name": "w", "task": "t"},
		{"team": "x", "task": "t"},
		{"team": "x", "name": "w"},
		{},
	} {
		res := tool.Execute(context.Background(), args)
		if !res.IsError {
			t.Errorf("args %v should error, got: %s", args, res.Output)
		}
	}
}

// A missing team is created on the fly, and creating it sweeps every other
// team first (TS: SpawnTeammateTool deleteAll + create).
func TestSpawnTeammateToolCreatesMissingTeamWithSweep(t *testing.T) {
	base := t.TempDir()
	tm := NewTeamManager(base, base)
	old := tm.CreateTeam("old")

	var spawnedOn *Team
	tool := &SpawnTeammateTool{TeamMgr: tm, Spawn: func(team *Team, name, task string) error {
		spawnedOn = team
		return nil
	}}
	res := tool.Execute(context.Background(), map[string]any{
		"team": "fresh", "name": "worker", "task": "do it",
	})
	if res.IsError {
		t.Fatalf("SpawnTeammate errored: %s", res.Output)
	}
	if spawnedOn == nil || spawnedOn.Name != "fresh" {
		t.Fatalf("Spawn hook got team %v, want fresh", spawnedOn)
	}
	if names := tm.ListTeams(); len(names) != 1 || names[0] != "fresh" {
		t.Errorf("ListTeams = %v, want [fresh] only", names)
	}
	if _, err := os.Stat(old.dir()); !os.IsNotExist(err) {
		t.Errorf("old team dir should be swept, stat err = %v", err)
	}
	want := "Teammate 'worker' spawned in team 'fresh'. Its result will arrive on the team channel; keep working and watch for it."
	if res.Output != want {
		t.Errorf("output = %q, want %q", res.Output, want)
	}
}

// An existing team is reused as-is: no sweep, no recreation.
func TestSpawnTeammateToolReusesExistingTeam(t *testing.T) {
	tm := newTmpManager(t)
	keep := tm.CreateTeam("keep")

	var spawnedOn *Team
	tool := &SpawnTeammateTool{TeamMgr: tm, Spawn: func(team *Team, name, task string) error {
		spawnedOn = team
		return nil
	}}
	res := tool.Execute(context.Background(), map[string]any{
		"team": "keep", "name": "worker", "task": "do it",
	})
	if res.IsError {
		t.Fatalf("SpawnTeammate errored: %s", res.Output)
	}
	if spawnedOn != keep {
		t.Error("existing team should be reused, not recreated")
	}
	if names := tm.ListTeams(); len(names) != 1 || names[0] != "keep" {
		t.Errorf("ListTeams = %v, want [keep]", names)
	}
}

func TestListTeamsTool(t *testing.T) {
	tm := newTmpManager(t)
	tool := &ListTeamsTool{TeamMgr: tm}

	if res := tool.Execute(context.Background(), nil); res.Output != "No teams." {
		t.Errorf("empty output = %q, want %q", res.Output, "No teams.")
	}

	team := tm.CreateTeam("squad")
	scout := team.AddMember("scout")
	team.mu.Lock()
	scout.Active = true
	team.mu.Unlock()
	team.AddMember("writer")

	res := tool.Execute(context.Background(), nil)
	if res.IsError {
		t.Fatalf("ListTeams errored: %s", res.Output)
	}
	want := "squad [in-process]: scout (active), writer"
	if res.Output != want {
		t.Errorf("output = %q, want %q", res.Output, want)
	}
}

// fakeTaskBoard is a minimal BackgroundTaskBoard for the task_id path.
type fakeTaskBoard map[string]string

func (b fakeTaskBoard) TaskState(id string) (string, bool) {
	state, ok := b[id]
	return state, ok
}

func (b fakeTaskBoard) StopTask(id string) bool {
	if state, ok := b[id]; ok && state == "running" {
		b[id] = "cancelled"
		return true
	}
	return false
}

// TaskStop supports the task_id path for one-shot background tasks
// (TS: teams/task-stop.ts).
func TestTaskStopTaskID(t *testing.T) {
	board := fakeTaskBoard{"task_1": "running", "task_2": "completed"}
	tool := &TaskStopTool{TeamMgr: newTmpManager(t), TaskBoard: board}

	res := tool.Execute(context.Background(), map[string]any{"task_id": "task_1"})
	if res.IsError || !strings.Contains(res.Output, "Background task 'task_1' stopped.") {
		t.Errorf("stopping a running task: %q (err=%v)", res.Output, res.IsError)
	}
	if board["task_1"] != "cancelled" {
		t.Errorf("board state = %q, want cancelled", board["task_1"])
	}

	res = tool.Execute(context.Background(), map[string]any{"task_id": "task_2"})
	if res.IsError || !strings.Contains(res.Output, "Background task 'task_2' is completed, nothing to stop") {
		t.Errorf("stopping a finished task: %q (err=%v)", res.Output, res.IsError)
	}

	res = tool.Execute(context.Background(), map[string]any{"task_id": "task_3"})
	if !res.IsError || !strings.Contains(res.Output, "not found") {
		t.Errorf("unknown task should error: %q (err=%v)", res.Output, res.IsError)
	}
}

// Exactly one of teammate / task_id must be passed (TS: task-stop.ts).
func TestTaskStopRequiresExactlyOneTarget(t *testing.T) {
	tool := &TaskStopTool{TeamMgr: newTmpManager(t), TaskBoard: fakeTaskBoard{}}
	for _, args := range []map[string]any{
		{},
		{"teammate": "x", "task_id": "task_1"},
	} {
		res := tool.Execute(context.Background(), args)
		if !res.IsError || !strings.Contains(res.Output, "exactly one of teammate or task_id") {
			t.Errorf("args %v: got %q (err=%v)", args, res.Output, res.IsError)
		}
	}
}

// Without a wired board the task_id path reports the task as not found
// rather than silently succeeding.
func TestTaskStopTaskIDWithoutBoard(t *testing.T) {
	tool := &TaskStopTool{TeamMgr: newTmpManager(t)}
	res := tool.Execute(context.Background(), map[string]any{"task_id": "task_1"})
	if !res.IsError || !strings.Contains(res.Output, "not found") {
		t.Errorf("got %q (err=%v), want not-found error", res.Output, res.IsError)
	}
}
