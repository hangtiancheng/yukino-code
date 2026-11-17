package teams

import (
	"context"
	"fmt"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/tools"
)

func teamToolSchema(name, description string, properties map[string]any, required ...string) map[string]any {
	if required == nil {
		required = []string{}
	}
	return map[string]any{"name": name, "description": description, "input_schema": map[string]any{"type": "object", "properties": properties, "required": required}}
}
func stringProperty(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}
func teamResult(err error, output string) tools.ToolResult {
	if err != nil {
		return tools.ToolResult{Output: err.Error(), IsError: true}
	}
	return tools.ToolResult{Output: output}
}

type TeamCreateTool struct{ TeamMgr *TeamManager }

func (t *TeamCreateTool) Name() string                 { return "TeamCreate" }
func (t *TeamCreateTool) Description() string          { return TeamCreateToolDescription }
func (t *TeamCreateTool) Category() tools.ToolCategory { return tools.CategoryCommand }
func (t *TeamCreateTool) Schema() map[string]any {
	return teamToolSchema(t.Name(), t.Description(), map[string]any{"name": stringProperty(TeamCreateNameParamDescription), "description": stringProperty(TeamDescriptionParamDescription)})
}
func (t *TeamCreateTool) Execute(_ context.Context, args map[string]any) tools.ToolResult {
	name, _ := args["name"].(string)
	description, _ := args["description"].(string)
	team, err := t.TeamMgr.CreateTeam(strings.TrimSpace(name), LeadName, description)
	if err != nil {
		return teamResult(err, "")
	}
	return teamResult(nil, fmt.Sprintf("Team '%s' created. Use Agent with kind=\"teammate\" and team_name=\"%s\" to add teammates.", team.Name, team.Name))
}

type TeamDeleteTool struct{ TeamMgr *TeamManager }

func (t *TeamDeleteTool) Name() string                 { return "TeamDelete" }
func (t *TeamDeleteTool) Description() string          { return TeamDeleteToolDescription }
func (t *TeamDeleteTool) Category() tools.ToolCategory { return tools.CategoryCommand }
func (t *TeamDeleteTool) Schema() map[string]any {
	return teamToolSchema(t.Name(), t.Description(), map[string]any{"team_name": stringProperty(teamNameParamDescription)})
}
func (t *TeamDeleteTool) Execute(_ context.Context, args map[string]any) tools.ToolResult {
	name, _ := args["team_name"].(string)
	team, err := t.TeamMgr.ResolveTeam(name)
	if err != nil {
		return teamResult(err, "")
	}
	if team == nil {
		return teamResult(nil, "No active team.")
	}
	t.TeamMgr.DeleteTeam(team.Name)
	return teamResult(nil, fmt.Sprintf("Team '%s' deleted.", team.Name))
}

type TeamListTool struct{ TeamMgr *TeamManager }

func (t *TeamListTool) Name() string                 { return "TeamList" }
func (t *TeamListTool) Description() string          { return ListTeamToolDescription }
func (t *TeamListTool) Category() tools.ToolCategory { return tools.CategoryRead }
func (t *TeamListTool) Schema() map[string]any {
	return teamToolSchema(t.Name(), t.Description(), map[string]any{})
}
func (t *TeamListTool) Execute(_ context.Context, _ map[string]any) tools.ToolResult {
	lines := []string{}
	for _, name := range t.TeamMgr.ListTeams() {
		team := t.TeamMgr.GetTeam(name)
		members := []string{}
		team.mu.Lock()
		for _, m := range team.membersInOrder() {
			label := m.Name
			if m.Active {
				label += " (active)"
			}
			members = append(members, label)
		}
		team.mu.Unlock()
		listing := strings.Join(members, ", ")
		if listing == "" {
			listing = "(no members)"
		}
		lines = append(lines, name+": "+listing)
	}
	if len(lines) == 0 {
		return teamResult(nil, "No active team.")
	}
	return teamResult(nil, strings.Join(lines, "\n"))
}

type SendMessageTool struct {
	TeamName   string
	TeamMgr    *TeamManager
	SenderName string
}

func (t *SendMessageTool) Name() string                 { return "SendMessage" }
func (t *SendMessageTool) Description() string          { return SendMessageToolDescription }
func (t *SendMessageTool) Category() tools.ToolCategory { return tools.CategoryCommand }
func (t *SendMessageTool) sender() string {
	if t.SenderName == "" {
		return LeadName
	}
	return t.SenderName
}
func (t *SendMessageTool) Schema() map[string]any {
	kinds := []string{MsgText, MsgShutdownRequest, MsgShutdownResponse}
	description := "Message kind, defaults to 'text'. Use 'shutdown_request' to ask a teammate to wrap up (it replies with shutdown_response). "
	if t.TeamMgr.CoordinatorMode {
		kinds = append(kinds, MsgPlanApprovalResponse)
		description += "The leader must review each plan_approval_request and reply with plan_approval_response, approve, request_id, and substantive feedback in content."
	} else {
		description += "Teammate plans are automatically approved by the runtime."
	}
	return teamToolSchema(t.Name(), t.Description(), map[string]any{"team_name": stringProperty(teamNameParamDescription), "to": stringProperty(SendMessageToDescription), "content": stringProperty(SendMessageContentDescription), "type": map[string]any{"type": "string", "enum": kinds, "description": description}, "request_id": stringProperty(SendMessageRequestIdDescription), "approve": map[string]any{"type": "boolean", "description": SendMessageApproveDescription}}, "to", "content")
}
func (t *SendMessageTool) Execute(ctx context.Context, args map[string]any) tools.ToolResult {
	to, _ := args["to"].(string)
	content, _ := args["content"].(string)
	name, _ := args["team_name"].(string)
	sender := t.sender()
	if t.TeamName != "" {
		if name != "" && sanitizeTeamName(name) != sanitizeTeamName(t.TeamName) {
			return teamResult(fmt.Errorf("Teammates can only access their own team."), "")
		}
		name = t.TeamName
	}
	member := ""
	if sender != LeadName {
		member = sender
	}
	team, err := t.TeamMgr.ResolveTeamForMember(name, member)
	if err != nil {
		return teamResult(err, "")
	}
	if team == nil {
		return teamResult(fmt.Errorf("No active team found for this sender."), "")
	}
	kind, ok := args["type"].(string)
	if !ok {
		kind = MsgText
	}
	if kind != MsgText {
		id, _ := args["request_id"].(string)
		approve, hasApprove := args["approve"].(bool)
		var msg FileMailMessage
		switch kind {
		case MsgPlanApprovalResponse:
			plan := tools.PlanningContext(ctx)
			if sender != LeadName || plan != nil && (plan.IsTeammate || plan.IsSubagent) {
				return teamResult(fmt.Errorf("Only the leader can approve or reject teammate plans."), "")
			}
			if id == "" || !hasApprove || strings.TrimSpace(content) == "" {
				return teamResult(fmt.Errorf("plan_approval_response requires request_id, approve, and review feedback in content."), "")
			}
			if err := team.RespondToPlan(to, id, approve, content); err != nil {
				return teamResult(err, "")
			}
			decision := "revision feedback"
			if approve {
				decision = "approval"
			}
			return teamResult(nil, fmt.Sprintf("Plan %s sent to '%s'.", decision, to))
		case MsgShutdownRequest:
			if sender != LeadName {
				return teamResult(fmt.Errorf("Only the leader can request teammate shutdown."), "")
			}
			msg = NewShutdownRequest(sender, content)
		case MsgShutdownResponse:
			if !hasApprove {
				return teamResult(fmt.Errorf("shutdown_response requires 'approve'."), "")
			}
			msg = NewShutdownResponse(sender, id, approve, content)
		default:
			return teamResult(fmt.Errorf("Unsupported message type %s.", kind), "")
		}
		if to != LeadName && !team.HasMember(to) {
			return teamResult(fmt.Errorf("Teammate '%s' not found.", to), "")
		}
		return teamResult(team.MailBox.Send(to, msg), fmt.Sprintf("%s sent to '%s'.", kind, to))
	}
	if to == "*" {
		count := 0
		for _, m := range team.ListMembers() {
			team.mu.Lock()
			skip := m.Name == sender || !m.Active && m.Progress != nil
			team.mu.Unlock()
			if skip {
				continue
			}
			if err := team.SendMessage(sender, m.Name, content); err != nil {
				return teamResult(err, "")
			}
			count++
		}
		return teamResult(nil, fmt.Sprintf("Message broadcast to %d teammate(s).", count))
	}
	if to == LeadName {
		return teamResult(team.MailBox.Send(to, NewFileMailMessage(sender, content)), fmt.Sprintf("Message sent to '%s'.", to))
	}
	recipient := to
	for _, m := range team.ListMembers() {
		if m.Name == to || m.AgentID == to {
			recipient = m.Name
			break
		}
	}
	if err := team.SendMessage(sender, recipient, content); err != nil {
		return tools.ToolResult{Output: "Error: " + err.Error(), IsError: true}
	}
	return teamResult(nil, fmt.Sprintf("Message sent to '%s'.", to))
}
