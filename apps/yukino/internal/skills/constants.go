package skills

import "regexp"

const (
	AgentsDirName = ".agents"
	SkillsDirName = "skills"
	SkillFileName = "SKILL.md"

	MaxSkillDownloadBytes     = 1024 * 1024
	SkillDownloadTimeoutMS    = 30_000
	MaxSkillDescriptionChars  = 200
	ForkContextRecentMessages = 5
	ForkContextFullMessages   = 100

	ArgumentsPlaceholder = "$ARGUMENTS"

	SkillDownloadTimeoutError  = "Skill download timed out after 30 seconds"
	SkillDownloadTooLargeError = "Skill download exceeds the 1 MiB size limit"
	SkillDownloadInvalidStream = "Skill download returned an invalid response stream"
	SkillDownloadInvalidChunk  = "Skill download returned a non-byte response chunk"
	SourceRequiredError        = "Error: source is required"
	InvalidSkillSourceError    = "Error: source must be a valid SKILL.md with a frontmatter name"
	InvalidSkillNameError      = "Error: invalid skill name; use letters, digits, dots, underscores and hyphens"
)

var SkillNameRe = regexp.MustCompile(`^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$`)
