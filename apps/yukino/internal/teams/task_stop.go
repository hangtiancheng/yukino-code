package teams

import (
	"context"
	"fmt"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type TaskStopTool struct {
	TeamMgr     *TeamManager
	TaskManager tools.BackgroundTaskManager
	Delegated   bool
}

func (t *TaskStopTool) Name() string { return "TaskStop" }
func (t *TaskStopTool) Category() tools.ToolCategory {
	if t.Delegated {
		return tools.CategoryRead
	}
	return tools.CategoryCommand
}

func (t *TaskStopTool) Description() string {
	if t.Delegated {
		return "Stop one of this agent's own background tasks (Agent, Bash, PowerShell). Pass task_id."
	}
	return "Stop a running teammate or stop a background tool call early (subagent, Bash, PowerShell). Pass exactly one of teammate or task_id. Cancellation waits for cleanup; terminal background tasks leave the active UI while their results remain available through TaskOutput."
}
func (t *TaskStopTool) ForSubagent() tools.Tool {
	return &TaskStopTool{TeamMgr: t.TeamMgr, Delegated: true}
}
func (t *TaskStopTool) Schema() map[string]any {
	// The delegated (subagent) form scopes task_id to the agent's own tasks,
	// mirroring TASK_STOP_SUBAGENT_TASK_ID_DESCRIPTION vs TASK_STOP_TASK_ID_DESCRIPTION.
	taskIDDescription := "ID of a background task (Agent, Bash, PowerShell)"
	if t.Delegated {
		taskIDDescription = "ID of this agent's background task"
	}
	properties := map[string]any{"task_id": map[string]any{"type": "string", "description": taskIDDescription}}
	schema := map[string]any{"type": "object", "properties": properties}
	if t.Delegated {
		schema["required"] = []string{"task_id"}
		schema["additionalProperties"] = false
	} else {
		properties["teammate"] = map[string]any{"type": "string", "description": "Name of the teammate to stop, exactly as it appears in the from= field of a task-notification"}
		properties["team_name"] = stringProperty(teamNameParamDescription)
	}
	return map[string]any{"name": t.Name(), "description": t.Description(), "input_schema": schema}
}

func (t *TaskStopTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	name, _ := args["teammate"].(string)
	id, _ := args["task_id"].(string)
	if (name == "") == (id == "") {
		return tools.ToolResult{Output: "Error: pass exactly one of teammate or task_id", IsError: true}
	}
	if id != "" {
		manager := tools.TaskManagerForContext(ctx, t.TaskManager)
		if manager == nil {
			return tools.ToolResult{Output: fmt.Sprintf("Error: background task '%s' not found", id), IsError: true}
		}
		task := manager.Get(id)
		if task == nil {
			return tools.ToolResult{Output: fmt.Sprintf("Error: background task '%s' not found", id), IsError: true}
		}
		if task.Status != "running" {
			select {
			case <-task.Done:
			case <-ctx.Done():
				return tools.ToolResult{Output: ctx.Err().Error(), IsError: true}
			}
			return tools.ToolResult{Output: fmt.Sprintf("Background task '%s' is %s, nothing to stop", id, task.Status)}
		}
		if _, err := manager.StopAndWait(ctx, id); err != nil {
			return tools.ToolResult{Output: err.Error(), IsError: true}
		}
		return tools.ToolResult{Output: fmt.Sprintf("Background task '%s' stopped.", id)}
	}
	if t.Delegated {
		return tools.ToolResult{Output: "Only the leader can stop teammates.", IsError: true}
	}
	if t.TeamMgr == nil {
		return tools.ToolResult{Output: "Error: team manager unavailable", IsError: true}
	}

	requestedTeam, _ := args["team_name"].(string)
	team, err := t.TeamMgr.ResolveTeamForMember(requestedTeam, name)
	if err != nil {
		return teamResult(err, "")
	}
	if team != nil {
		team.mu.Lock()
		member := team.Members[name]
		active := member != nil && member.Active
		team.mu.Unlock()
		if member != nil {
			if !active {
				return teamResult(nil, fmt.Sprintf("Teammate '%s' in team '%s' is not running, nothing to stop", name, team.Name))
			}
			team.StopMember(name)
			return teamResult(nil, fmt.Sprintf("Teammate '%s' in team '%s' stopped.", name, team.Name))
		}
	}

	return tools.ToolResult{
		Output:  fmt.Sprintf("Error: teammate '%s' not found. Known teammates: %s", name, t.knownMembers()),
		IsError: true,
	}
}

func (t *TaskStopTool) knownMembers() string {
	var names []string
	for _, teamName := range t.TeamMgr.ListTeams() {
		team := t.TeamMgr.GetTeam(teamName)
		if team == nil {
			continue
		}
		for _, member := range team.ListMembers() {
			names = append(names, member.Name)
		}
	}
	if len(names) == 0 {
		return "(none)"
	}
	return strings.Join(names, ", ")
}
