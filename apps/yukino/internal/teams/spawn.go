package teams

import (
	"context"
	"fmt"

	"github.com/yukino-js/yukino/yukino/internal/permissions"
)

// TeammateProgressEvent mirrors the SubagentProgressEvent union the reference
// team layer observes through a type-only import: tool_use, tool_result,
// usage and turn_complete progress events.
type TeammateProgressEvent struct {
	Type         string
	ToolID       string
	ToolName     string
	Args         map[string]any
	InputTokens  int
	OutputTokens int
}

// RunTeammateAgent mirrors the reference RunAgent callback: it runs one task
// turn to completion and returns the final output. Injected so the team layer
// stays decoupled from the LLM/agent layer (and is unit-testable). The optional
// onEvent callback lets the team layer observe progress events.
type RunTeammateAgent func(ctx context.Context, task string, onEvent func(TeammateProgressEvent)) (string, error)

// TeammateSpawnConfig mirrors the spawnTeammate parameter list: name, task,
// runAgent, checker, originToolCallId, memberCwd and the role metadata
// (agentType, model, planApprovalRequired, cleanup).
type TeammateSpawnConfig struct {
	Team                 *Team
	MemberName           string
	Task                 string
	RunAgent             RunTeammateAgent
	Checker              *permissions.Checker
	Workdir              string
	PlanApprovalRequired bool
	AgentType            string
	Model                string
	OriginToolCallID     string
	Cleanup              func()
}

func SpawnTeammate(ctx context.Context, cfg TeammateSpawnConfig) error {
	if cfg.Team == nil {
		return fmt.Errorf("SpawnTeammate: team is required")
	}
	return startInProcessMember(ctx, cfg)
}
