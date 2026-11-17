package subagent

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

type AgentLoader struct {
	order  []string
	agents map[string]*AgentDefinition

	FailedFiles []string

	ErrorWriter io.Writer
}

func NewAgentLoader() *AgentLoader {
	return &AgentLoader{
		agents:      make(map[string]*AgentDefinition),
		ErrorWriter: os.Stderr,
	}
}

func (l *AgentLoader) LoadAll() error {
	l.FailedFiles = l.FailedFiles[:0]
	clear(l.agents)
	l.order = []string{"general-purpose", "plan", "explore", "review"}
	for _, name := range l.order {
		spec := BuiltinSpecs[name]
		l.agents[name] = &AgentDefinition{
			AgentType:       spec.Name,
			WhenToUse:       spec.Description,
			DisallowedTools: spec.DisallowedTools,
			Model:           spec.Model,
			MaxTurns:        spec.MaxTurns,
			SystemPrompt:    spec.SystemPromptOverride,
			Background:      spec.Background,
			PermissionMode:  spec.PermissionMode,
			ReadOnly:        spec.ReadOnly,
			Source:          "built-in",
		}
	}

	l.loadDir(storage.YukinoPath("agents"), "user")

	return nil
}

func (l *AgentLoader) loadDir(dir, source string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		def, err := ParseAgentFile(path)
		if err != nil {
			msg := fmt.Sprintf("%s: %v", path, err)
			l.FailedFiles = append(l.FailedFiles, msg)
			if l.ErrorWriter != nil {
				fmt.Fprintf(l.ErrorWriter, "[yukino] agent definition skipped — %s\n", msg)
			}
			continue
		}
		def.Source = source
		if l.agents[def.AgentType] == nil {
			l.order = append(l.order, def.AgentType)
		}
		l.agents[def.AgentType] = def
	}
}

func (l *AgentLoader) Get(agentType string) *AgentDefinition {
	return l.agents[agentType]
}

func (l *AgentLoader) ListNames() []string { return append([]string{}, l.order...) }
