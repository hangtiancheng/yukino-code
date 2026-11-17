package remote

import (
	"context"
	"fmt"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/skills"
	"github.com/yukino-js/yukino/yukino/internal/subagent"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type skillForkHost struct {
	*Server
	meta skills.SkillMeta
}

func (h skillForkHost) SnapshotParentMessages(count int) string {
	messages := h.conv.GetMessages()
	if len(messages) > count {
		messages = messages[len(messages)-count:]
	}
	lines := make([]string, 0, len(messages))
	for _, message := range messages {
		lines = append(lines, "["+message.Role+"] "+message.ContentText())
	}
	return strings.Join(lines, "\n")
}

func (h skillForkHost) RunSubagent(ctx context.Context, prompt string) (string, error) {
	definition := &subagent.AgentDefinition{AgentType: h.meta.Name, WhenToUse: h.meta.Description, Model: h.meta.Model}
	wd := h.ag.CurrentCwd()
	execution := tools.ExecutionContext{WorkDir: wd, SessionID: h.sessionID, RequestPermission: h.requestPermissionViaWS}
	return subagent.SpawnSubagent(tools.WithExecutionContext(ctx, execution), definition, prompt, h.client, h.registry, h.activeProvider(), wd, nil, nil, "", h.ag.Checker.ForCwd(wd), subagent.SubagentRunOptions{Background: false})
}

func (s *Server) runSkillFork(ctx context.Context, name, args string) {
	defer s.send(wsMessage{Type: "command_done", Data: nil})
	var skill *skills.Skill
	if s.skillCatalog != nil {
		skill = s.skillCatalog.Get(name)
	}
	if skill == nil {
		s.send(wsMessage{Type: "system", Data: map[string]string{"message": "Skill not found: " + name}})
		return
	}
	s.send(wsMessage{Type: "system", Data: map[string]string{"message": fmt.Sprintf("Running skill %q in fork mode…", name)}})
	result, err := skills.RunFork(ctx, skill, args, skillForkHost{Server: s, meta: skill.Meta})
	if err != nil {
		s.send(wsMessage{Type: "error", Data: map[string]string{"message": "Skill fork error: " + err.Error()}})
		return
	}
	s.send(wsMessage{Type: "stream_text", Data: map[string]string{"text": result}})
	s.send(wsMessage{Type: "stream_end", Data: map[string]string{"text": result}})
}
