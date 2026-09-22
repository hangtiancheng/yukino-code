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
	"github.com/hangtiancheng/yukino-code/yukino/utils"
)

// SendMessageTool allows agents to send messages to named teammates (TS:
// teams/tools.ts SendMessageTool).
type SendMessageTool struct {
	TeamMgr    *TeamManager
	SenderName string
}

func (t *SendMessageTool) Name() string { return "SendMessage" }

// Category is read: orchestration tools are auto-allowed in default mode
// (TS: teams/tools.ts category = "read").
func (t *SendMessageTool) Category() tools.ToolCategory { return tools.CategoryRead }
func (t *SendMessageTool) Description() string {
	return "Send a message to a teammate's mailbox. Use to='*' to broadcast to all teammates."
}

func (t *SendMessageTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"to": map[string]any{
					"type":        "string",
					"description": "Teammate name, or '*' to broadcast",
				},
				"content": map[string]any{
					"type": "string",
					"description": "Message content. For shutdown_request this is the reason; for " +
						"plan_approval_response this is your feedback when rejecting.",
				},
				"type": map[string]any{
					"type": "string",
					"enum": []string{
						MsgText, MsgShutdownRequest, MsgShutdownResponse, MsgPlanApprovalResponse,
					},
					"description": "Message kind, defaults to 'text'. Use 'shutdown_request' to ask a teammate " +
						"to wrap up (it replies with shutdown_response). Use 'plan_approval_response' " +
						"to answer a teammate's plan, together with 'approve' and, when rejecting, " +
						"feedback in 'content'.",
				},
				"request_id": map[string]any{
					"type": "string",
					"description": "Required for plan_approval_response: copy the requestId from the teammate's " +
						"plan approval request so it knows which plan you are answering.",
				},
				"approve": map[string]any{
					"type": "boolean",
					"description": "Required for plan_approval_response: true to let the teammate start " +
						"executing, false to send it back to revise.",
				},
			},
			"required": []string{"to", "content"},
		},
	}
}

func (t *SendMessageTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	to := utils.StrArg(args, "to")
	message := utils.StrArg(args, "content")
	team := t.senderTeam()
	if team == nil {
		return tools.ToolResult{Output: "No active team found for this sender.", IsError: true}
	}

	// Structured messages use a dedicated channel: they carry a requestId and
	// an explicit stance. Embedding them in free-form text would force the
	// recipient to guess intent from natural language — regressing to
	// "coordination by prose parsing" (TS tools.ts:247-302).
	// TS: `typeof args.type === "string" ? args.type : MSG_TEXT` — an explicit
	// empty string is a value, not an absent key, and falls through to the
	// unsupported-type branch below.
	msgType, hasType := args["type"].(string)
	if !hasType {
		msgType = MsgText
	}
	if msgType != MsgText {
		requestID, _ := args["request_id"].(string)
		approve, hasApprove := args["approve"].(bool)
		var msg FileMailMessage
		switch msgType {
		case MsgShutdownRequest:
			msg = NewShutdownRequest(t.SenderName, message)
		case MsgShutdownResponse:
			if !hasApprove {
				return tools.ToolResult{Output: "shutdown_response requires 'approve'.", IsError: true}
			}
			msg = NewShutdownResponse(t.SenderName, requestID, approve, message)
		case MsgPlanApprovalResponse:
			if requestID == "" || !hasApprove {
				return tools.ToolResult{
					Output:  "plan_approval_response requires both 'request_id' and 'approve'.",
					IsError: true,
				}
			}
			msg = NewPlanApprovalResponse(t.SenderName, requestID, approve, message)
		default:
			return tools.ToolResult{Output: fmt.Sprintf("Unsupported message type %s.", msgType), IsError: true}
		}
		// The lead is not a registered member (it runs in the parent process
		// and only reads its own mailbox); anyone else must be on the roster.
		if to != LeadName && team.GetMember(to) == nil {
			return tools.ToolResult{Output: fmt.Sprintf("Teammate '%s' not found.", to), IsError: true}
		}
		if err := team.MailBox.Send(to, msg); err != nil {
			return tools.ToolResult{Output: "Error sending message: " + err.Error(), IsError: true}
		}
		return tools.ToolResult{Output: fmt.Sprintf("%s sent to '%s'.", msgType, to)}
	}

	// Broadcast: send to all members in the team except the sender.
	if to == "*" {
		count := 0
		for _, member := range team.ListMembers() {
			if member.Name == t.SenderName {
				continue
			}
			if err := team.SendMessage(t.SenderName, member.Name, message); err != nil {
				log.Error("teams operation failed", "err", err)
			}
			count++
		}
		return tools.ToolResult{Output: fmt.Sprintf("Message broadcast to %d teammate(s).", count)}
	}

	// The lead is not a registered member, so route plain text to it directly
	// — mirroring the structured-message path above (TS tools.ts:319-325). A
	// delivery failure surfaces as a tool error (TS: the send throw propagates
	// out of execute).
	if to == LeadName {
		if err := team.MailBox.Send(LeadName, NewFileMailMessage(t.SenderName, message)); err != nil {
			return tools.ToolResult{Output: "Error: " + utils.AsErrorString(err), IsError: true}
		}
		return tools.ToolResult{Output: fmt.Sprintf("Message sent to '%s'.", to)}
	}

	// Resolve the recipient name to a delivery identifier via the global name
	// registry; fall back to the original name if unresolved.
	recipient := to
	if resolved := GetNameRegistry().Resolve(to); resolved != "" {
		recipient = resolved
	}
	if err := team.SendMessage(t.SenderName, recipient, message); err != nil {
		// TS tools.ts:332 — the catch logs before returning the error result.
		log.Error("teams operation failed", "err", err)
		return tools.ToolResult{Output: "Error: " + utils.AsErrorString(err), IsError: true}
	}
	return tools.ToolResult{Output: fmt.Sprintf("Message sent to '%s'.", to)}
}

// senderTeam infers the sender's team: a teammate can look itself up in the
// roster; the Lead is not in the roster, so fall back to the current team
// (only one is active at a time) — TS tools.ts senderTeam.
func (t *SendMessageTool) senderTeam() *Team {
	teams := t.TeamMgr.Teams()
	for _, team := range teams {
		if team.GetMember(t.SenderName) != nil {
			return team
		}
	}
	if len(teams) > 0 {
		return teams[0]
	}
	return nil
}

// TeamCreateTool creates a new agent team.
type TeamCreateTool struct {
	TeamMgr *TeamManager
}

func (t *TeamCreateTool) Name() string { return "TeamCreate" }

// Category is read: orchestration tools are auto-allowed in default mode
// (TS: teams/tools.ts category = "read").
func (t *TeamCreateTool) Category() tools.ToolCategory { return tools.CategoryRead }
func (t *TeamCreateTool) Description() string {
	return "Create a team for coordinating multiple agents. At most one team exists at a time: creating a team deletes any other team, stopping its members."
}

func (t *TeamCreateTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"team_name": map[string]any{
					"type":        "string",
					"description": "Name for the team",
				},
				"description": map[string]any{
					"type":        "string",
					"description": "What this team will work on",
				},
			},
			"required": []string{"team_name"},
		},
	}
}

func (t *TeamCreateTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	name := utils.StrArg(args, "team_name")
	if name == "" {
		return tools.ToolResult{Output: "Error: team_name is required", IsError: true}
	}

	// Single-team semantics: at most one team exists at any moment. Creating a
	// team sweeps every other team — running ones are stopped, and residuals
	// from previous sessions are removed from disk — so the requested name is
	// always free and no suffix disambiguation is needed (TS: TeamCreateTool
	// calls mgr.deleteAll() before create).
	t.TeamMgr.DeleteAll()

	desc := utils.StrArg(args, "description")
	team := t.TeamMgr.CreateTeamFull(name, LeadName, desc)
	return tools.ToolResult{
		Output: fmt.Sprintf("Team '%s' created (mode: %s). Use Agent tool with team_name='%s' to add teammates.",
			team.Name, team.Mode, team.Name),
	}
}

// TeamDeleteTool deletes an agent team and stops all members.
type TeamDeleteTool struct {
	TeamMgr *TeamManager
}

func (t *TeamDeleteTool) Name() string { return "TeamDelete" }

// Category is read: orchestration tools are auto-allowed in default mode
// (TS: teams/tools.ts category = "read").
func (t *TeamDeleteTool) Category() tools.ToolCategory { return tools.CategoryRead }
func (t *TeamDeleteTool) Description() string {
	return "Delete a team and stop its members."
}

func (t *TeamDeleteTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"name": map[string]any{"type": "string"},
			},
			"required": []string{"name"},
		},
	}
}

func (t *TeamDeleteTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	name := utils.StrArg(args, "name")
	// TS deletes unconditionally — an unknown name is a no-op, not an error.
	t.TeamMgr.DeleteTeam(name)
	return tools.ToolResult{Output: fmt.Sprintf("Team '%s' deleted.", name)}
}

// SpawnTeammateTool spawns a teammate in a team to work on a task in the
// background (TS: teams/tools.ts SpawnTeammateTool). The actual launch is
// delegated to the Spawn hook because building a runnable teammate requires
// the host's client/registry/checker wiring; teams cannot import the subagent
// package (subagent already imports teams).
type SpawnTeammateTool struct {
	TeamMgr *TeamManager
	// Spawn launches a teammate named name on team with task. Required.
	Spawn func(team *Team, name, task string) error
}

func (t *SpawnTeammateTool) Name() string { return "SpawnTeammate" }

// Category is read: orchestration tools are auto-allowed in default mode
// (TS: teams/tools.ts category = "read").
func (t *SpawnTeammateTool) Category() tools.ToolCategory { return tools.CategoryRead }
func (t *SpawnTeammateTool) Description() string {
	return "Spawn a teammate in a team to work on a task in the background. Its result is delivered back to you on the team channel when it finishes."
}

func (t *SpawnTeammateTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"team": map[string]any{
					"type":        "string",
					"description": "Team name (created if missing)",
				},
				"name": map[string]any{
					"type":        "string",
					"description": "Teammate name",
				},
				"task": map[string]any{
					"type":        "string",
					"description": "The task for the teammate",
				},
			},
			"required": []string{"team", "name", "task"},
		},
	}
}

func (t *SpawnTeammateTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	teamName := utils.StrArg(args, "team")
	name := utils.StrArg(args, "name")
	task := utils.StrArg(args, "task")
	if teamName == "" || name == "" || task == "" {
		return tools.ToolResult{Output: "Error: team, name and task are required", IsError: true}
	}

	team := t.TeamMgr.GetTeam(teamName)
	if team == nil {
		// Single-team invariant: creating a team sweeps every other team
		// first, matching TeamCreate semantics (TS: deleteAll before create).
		t.TeamMgr.DeleteAll()
		team = t.TeamMgr.CreateTeam(teamName)
	}
	if t.Spawn == nil {
		return tools.ToolResult{Output: "Error: spawn hook unavailable", IsError: true}
	}
	if err := t.Spawn(team, name, task); err != nil {
		return tools.ToolResult{Output: "Error spawning teammate: " + err.Error(), IsError: true}
	}
	return tools.ToolResult{
		Output: fmt.Sprintf("Teammate '%s' spawned in team '%s'. Its result will arrive on the team channel; keep working and watch for it.", name, teamName),
	}
}

// ListTeamsTool lists teams and their members (TS: teams/tools.ts
// ListTeamsTool).
type ListTeamsTool struct {
	TeamMgr *TeamManager
}

func (t *ListTeamsTool) Name() string { return "ListTeams" }

// Category is read: orchestration tools are auto-allowed in default mode
// (TS: teams/tools.ts category = "read").
func (t *ListTeamsTool) Category() tools.ToolCategory { return tools.CategoryRead }
func (t *ListTeamsTool) Description() string {
	return "List teams and their members."
}

func (t *ListTeamsTool) Schema() map[string]any {
	return map[string]any{
		"name":        t.Name(),
		"description": t.Description(),
		"input_schema": map[string]any{
			"type":       "object",
			"properties": map[string]any{},
			"required":   []string{},
		},
	}
}

func (t *ListTeamsTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	teams := t.TeamMgr.Teams()
	if len(teams) == 0 {
		return tools.ToolResult{Output: "No teams."}
	}
	lines := make([]string, 0, len(teams))
	for _, team := range teams {
		memberParts := make([]string, 0)
		for _, member := range team.ListMembers() {
			if member.Active {
				memberParts = append(memberParts, member.Name+" (active)")
			} else {
				memberParts = append(memberParts, member.Name)
			}
		}
		members := strings.Join(memberParts, ", ")
		if members == "" {
			members = "(no members)"
		}
		lines = append(lines, fmt.Sprintf("%s [%s]: %s", team.Name, team.Mode, members))
	}
	return tools.ToolResult{Output: strings.Join(lines, "\n")}
}
