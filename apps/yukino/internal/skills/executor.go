package skills

import "context"

// RunInline activates a skill through the host so its existing skill cache and
// permissions remain authoritative, and returns the rendered prompt.
func RunInline(skill *Skill, args string, host SkillHost) string {
	prompt := BuildSkillPrompt(skill, args)
	host.ActivateSkill(skill.Meta.Name, prompt)
	return prompt
}

// RunFork runs a skill in an isolated subagent and returns its result
// unchanged.
func RunFork(ctx context.Context, skill *Skill, args string, host SkillForkHost) (string, error) {
	prompt := BuildSkillPrompt(skill, args)
	contextMode := skill.Meta.ForkContext
	if contextMode == "" {
		contextMode = "none"
	}
	if contextMode != "none" {
		count := ForkContextFullMessages
		if contextMode == "recent" {
			count = ForkContextRecentMessages
		}
		prompt = WrapParentContext(host.SnapshotParentMessages(count), prompt)
	}
	return host.RunSubagent(ctx, prompt)
}
