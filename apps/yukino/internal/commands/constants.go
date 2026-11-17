package commands

import "regexp"

const (
	PromptsDirName             = "prompts"
	CommandFileExtension       = ".md"
	CustomCommandTag           = "[custom]"
	CommandRecencyHalfLifeDays = 7
	CommandMinRecencyWeight    = 0.1
	MillisecondsPerDay         = 86_400_000

	SubagentCommandUnavailable      = "Agent tool is not available."
	SessionActiveMessage            = "Session is active. Use /resume to list past sessions."
	ThinkingLevelControlUnavailable = "Thinking level control is not available in this context."
	ReviewCommandDescription        = "Review a pull request: /review [PR number or URL]"
)

var CommandFileExtensionRe = regexp.MustCompile(`\.md$`)

var ArgumentPlaceholderRe = regexp.MustCompile(
	`\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)`)
