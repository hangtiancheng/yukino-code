package permissions

import "regexp"

const (
	PermissionsRulesFilename = "permissions.yaml"

	// Truncation cap for a single argument value in HITL action descriptions.
	MaxActionArgValueChars = 80

	PathPatternTraversalError  = "Permission path patterns cannot traverse after a wildcard"
	RulesParseError            = "Cannot parse permission rules"
	IsolatedWorktreeClaimError = "Cannot claim an existing worktree for an isolated agent"
)

// Per-tool argument field used for command checks and permission rule
// matching.
var ContentFields = map[string]string{
	"Bash":         "command",
	"PowerShell":   "command",
	"ComputerUse":  "action",
	"ReadFile":     "file_path",
	"WebFetch":     "url",
	"TaskOutput":   "task_id",
	"WriteFile":    "file_path",
	"EditFile":     "file_path",
	"Glob":         "pattern",
	"Grep":         "pattern",
	"InstallSkill": "source",
}

var FileTools = map[string]bool{
	"ReadFile":  true,
	"WriteFile": true,
	"EditFile":  true,
}

var PlanCoordinationTools = map[string]bool{
	"AskUserQuestion": true,
	"EnterPlanMode":   true,
	"ExitPlanMode":    true,
	"Agent":           true,
	"Goal":            true,
	"TodoWrite":       true,
	"TaskStop":        true,
	"TeamCreate":      true,
	"TeamDelete":      true,
	"SendMessage":     true,
}

// TeammateCoordinationTools mirrors teams constants: internal team messaging
// and the shared task board.
var TeammateCoordinationTools = map[string]bool{
	"SendMessage": true,
	"TodoWrite":   true,
}

var RuleRE = regexp.MustCompile(`(?s)^(\w+|\*)\((.+)\)$`)

var ComplexCommands = map[string]bool{
	"if": true, "then": true, "else": true, "elif": true, "fi": true,
	"for": true, "while": true, "until": true, "do": true, "done": true,
	"case": true, "esac": true, "function": true, "select": true, "coproc": true,
	"!": true, "time": true, "eval": true, "exec": true, "source": true, ".": true,
	"command": true, "builtin": true, "env": true, "sudo": true,
	"bash": true, "sh": true, "zsh": true, "dash": true, "ksh": true, "fish": true,
	"pwsh": true, "powershell": true, "xargs": true, "find": true,
}
