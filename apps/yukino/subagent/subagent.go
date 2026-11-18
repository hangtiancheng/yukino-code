package subagent

type SubAgentSpec struct {
	Name                 string
	Description          string
	Tools                []string
	DisallowedTools      []string
	SystemPromptOverride string
	MaxTurns             int
	Model                string
	PermissionMode       string
	ReadOnly             bool
	Background           bool
	Worktree             bool
	InitialPrompt        string
}

var BuiltinSpecs = map[string]SubAgentSpec{
	"general-purpose": {Name: "general-purpose", Description: GeneralPurposeAgentDescription},
	"plan":            {Name: "plan", Description: PlanAgentDescription, DisallowedTools: []string{"EditFile", "WriteFile", "ExitPlanMode"}, PermissionMode: "plan", ReadOnly: true},
	"explore":         {Name: "explore", Description: ExploreAgentDescription, DisallowedTools: []string{"EditFile", "WriteFile", "ExitPlanMode"}, PermissionMode: "plan", ReadOnly: true},
	"review":          {Name: "review", Description: ReviewAgentDescription, DisallowedTools: []string{"EditFile", "WriteFile", "ExitPlanMode"}},
}
