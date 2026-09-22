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
	"fmt"
	"strings"

	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

// BackgroundTaskBoard abstracts the host's background-task registry so
// TaskStop can also stop task_id tasks (TS: TaskStopTool takes an optional
// TaskManager). teams cannot import the subagent package — subagent already
// imports teams — so the wiring layer adapts its TaskManager to this
// interface.
type BackgroundTaskBoard interface {
	// TaskState reports a background task's status ("pending", "running",
	// "completed", ...) and whether it exists.
	TaskState(id string) (state string, ok bool)
	// StopTask aborts a background task and reports whether it was stopped.
	StopTask(id string) bool
}

// TaskStopTool stops a running teammate or one-shot background task. Pass
// exactly one of teammate or task_id (TS: teams/task-stop.ts TaskStopTool).
//
// Teammates hang off the TeamManager (the Lead dispatches them via the Agent
// tool with team_name and the Team holds their Cancel functions); one-shot
// background tasks live on the BackgroundTaskBoard.
type TaskStopTool struct {
	TeamMgr *TeamManager
	// TaskBoard serves the task_id path; nil disables it.
	TaskBoard BackgroundTaskBoard
}

func (t *TaskStopTool) Name() string                 { return "TaskStop" }
func (t *TaskStopTool) Category() tools.ToolCategory { return tools.CategoryCommand }

func (t *TaskStopTool) Description() string {
	return "Stop a running teammate or background task (Agent, Bash, PowerShell). Pass exactly one of teammate or task_id."
}

func (t *TaskStopTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"teammate": map[string]any{
					"type":        "string",
					"description": "Name of the teammate to stop, exactly as it appears in the from= field of a task-notification",
				},
				"task_id": map[string]any{
					"type":        "string",
					"description": "ID of a background task (Agent, Bash, PowerShell)",
				},
			},
		},
	}
}

func (t *TaskStopTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	name, _ := args["teammate"].(string)
	taskID, _ := args["task_id"].(string)
	if (name == "" && taskID == "") || (name != "" && taskID != "") {
		return tools.ToolResult{Output: "Error: pass exactly one of teammate or task_id", IsError: true}
	}

	if taskID != "" {
		// TS task-stop.ts: the task registry of the loop running this call
		// takes precedence — task ids are per-manager counters, so a fork's
		// background tasks live in its per-run manager and the same id on the
		// host-level board may be a different task. Fall back to the injected
		// board so a fork can still stop tasks from its pre-fork snapshot.
		board := t.TaskBoard
		if mgr, ok := tools.BackgroundTaskManagerFromContext(ctx); ok && mgr != nil {
			if b, isBoard := mgr.(BackgroundTaskBoard); isBoard {
				if _, exists := b.TaskState(taskID); exists {
					board = b
				}
			}
		}
		if board == nil {
			return tools.ToolResult{
				Output:  fmt.Sprintf("Error: background task '%s' not found", taskID),
				IsError: true,
			}
		}
		state, ok := board.TaskState(taskID)
		if !ok {
			return tools.ToolResult{
				Output:  fmt.Sprintf("Error: background task '%s' not found", taskID),
				IsError: true,
			}
		}
		if state != "running" {
			return tools.ToolResult{
				Output: fmt.Sprintf("Background task '%s' is %s, nothing to stop", taskID, state),
			}
		}
		board.StopTask(taskID)
		return tools.ToolResult{Output: fmt.Sprintf("Background task '%s' stopped.", taskID)}
	}

	if t.TeamMgr == nil {
		return tools.ToolResult{Output: "Error: team manager unavailable", IsError: true}
	}

	// Teammate names may be duplicated across teams; only stop in the team
	// that actually contains this member to avoid killing a same-named
	// teammate in another team.
	for _, teamName := range t.TeamMgr.ListTeams() {
		team := t.TeamMgr.GetTeam(teamName)
		if team == nil {
			continue
		}
		if !team.HasMember(name) {
			continue
		}
		if !team.IsMemberActive(name) {
			return tools.ToolResult{
				Output: fmt.Sprintf("Teammate '%s' in team '%s' is not running, nothing to stop", name, teamName),
			}
		}
		team.StopMember(name)
		return tools.ToolResult{
			Output: fmt.Sprintf("Teammate '%s' in team '%s' stopped.", name, teamName),
		}
	}

	return tools.ToolResult{
		Output:  fmt.Sprintf("Error: teammate '%s' not found. Known teammates: %s", name, t.knownMembers()),
		IsError: true,
	}
}

// knownMembers lists all current teammate names for the model, preventing it
// from retrying endlessly with a misremembered name.
func (t *TaskStopTool) knownMembers() string {
	var names []string
	for _, teamName := range t.TeamMgr.ListTeams() {
		team := t.TeamMgr.GetTeam(teamName)
		if team == nil {
			continue
		}
		names = append(names, team.MemberNames()...)
	}
	if len(names) == 0 {
		return "(none)"
	}
	return strings.Join(names, ", ")
}
