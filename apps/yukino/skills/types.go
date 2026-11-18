package skills

import "context"

// SkillMeta is the parsed SKILL.md frontmatter. Mode is "inline" or "fork"
// after parsing.
type SkillMeta struct {
	Name        string
	Description string
	Mode        string
	Model       string
	ForkContext string
}

func (m SkillMeta) IsFork() bool { return m.Mode == "fork" }

type Skill struct {
	Meta      SkillMeta
	Body      string
	SourceDir string
}

type SkillHost interface {
	ActivateSkill(name, body string)
}

type SkillForkHost interface {
	SkillHost
	RunSubagent(ctx context.Context, prompt string) (string, error)
	SnapshotParentMessages(count int) string
}
