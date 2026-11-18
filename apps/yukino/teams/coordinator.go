package teams

// CoordinatorAllowedTools mirrors COORDINATOR_ALLOWED_TOOLS: the Leader's
// toolset is narrowed to pure orchestration in CoordinatorMode. Read/search/shell
// tools are excluded so large volumes of content cannot flood the Leader's
// context; such work is delegated to teammates.
var CoordinatorAllowedTools = map[string]bool{
	"Workflow":        true,
	"Goal":            true,
	"Agent":           true,
	"SendMessage":     true,
	"TaskStop":        true,
	"SyntheticOutput": true,
	"TeamCreate":      true,
	"TeamDelete":      true,
	"TeamList":        true,
	"TodoWrite":       true,
}

func IsCoordinatorTool(name string) bool {
	return CoordinatorAllowedTools[name]
}

func CoordinatorToolFilter(enabled bool) func(name string) bool {
	if !enabled {
		return nil
	}
	return IsCoordinatorTool
}

func CoordinatorActiveFn(enabled bool) func() bool {
	if !enabled {
		return nil
	}
	return func() bool { return true }
}
