// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package subagent

import (
	"os"
	"path/filepath"
	"strings"
)

type AgentLoader struct {
	workDir string
	agents  map[string]*AgentDefinition
	// order preserves the TS definitions-array order: built-ins first, then
	// user-level, then project-level files in directory order; a same-name
	// override replaces the definition but keeps its original position
	// (loader.ts:70-75).
	order []string
}

func NewAgentLoader(workDir string) *AgentLoader {
	return &AgentLoader{
		workDir: workDir,
		agents:  make(map[string]*AgentDefinition),
	}
}

// builtinOrder lists the built-in agents in the TS BUILTIN_AGENTS array order
// (definition.ts:43-64). The verification agent is a Go extension, gated by
// YUKINO_VERIFICATION_AGENT, and appended after the TS built-ins.
var builtinOrder = []string{"general-purpose", "plan", "explore"}

// getBuiltinSpecs returns the built-in agent definitions in load order. The
// verification agent is off by default; it is gated by the
// YUKINO_VERIFICATION_AGENT environment variable and only added when enabled.
func getBuiltinSpecs() []SubAgentSpec {
	result := make([]SubAgentSpec, 0, len(builtinOrder)+1)
	for _, name := range builtinOrder {
		result = append(result, BuiltinSpecs[name])
	}
	if os.Getenv("YUKINO_VERIFICATION_AGENT") == "true" {
		result = append(result, verificationSpec)
	}
	return result
}

func (l *AgentLoader) LoadAll() error {
	l.agents = make(map[string]*AgentDefinition)
	l.order = nil
	for _, spec := range getBuiltinSpecs() {
		l.set(spec.Name, &AgentDefinition{
			AgentType:       spec.Name,
			WhenToUse:       spec.Description,
			DisallowedTools: spec.DisallowedTools,
			Model:           spec.Model,
			MaxTurns:        spec.MaxTurns,
			PermissionMode:  spec.PermissionMode,
			SystemPrompt:    spec.SystemPromptOverride,
			InitialPrompt:   spec.InitialPrompt,
			Background:      spec.Background,
			Isolation:       spec.Isolation,
			Source:          "built-in",
		})
	}

	home, _ := os.UserHomeDir()
	if home != "" {
		l.loadDir(filepath.Join(home, ".yukino", "agents"), "user")
	}

	if l.workDir != "" {
		l.loadDir(filepath.Join(l.workDir, ".yukino", "agents"), "project")
	}

	return nil
}

// set stores a definition, preserving the first-inserted position on override
// (TS: definitions[existing] = def keeps the array slot).
func (l *AgentLoader) set(name string, def *AgentDefinition) {
	if _, exists := l.agents[name]; !exists {
		l.order = append(l.order, name)
	}
	l.agents[name] = def
}

func (l *AgentLoader) loadDir(dir, source string) {
	// TS loader.ts:64 uses readdirSync order (raw directory order), not a
	// sorted listing.
	f, err := os.Open(dir)
	if err != nil {
		return
	}
	names, err := f.Readdirnames(-1)
	f.Close()
	if err != nil {
		return
	}
	for _, name := range names {
		if !strings.HasSuffix(name, ".md") {
			continue
		}
		path := filepath.Join(dir, name)
		def, err := ParseAgentFile(path)
		if err != nil {
			// TS loader.ts:77-79 / 124-126 — a read or parse failure logs one
			// `subagent operation failed` per file and the file is skipped.
			log.Error("subagent operation failed", "err", err)
			continue
		}
		if def == nil {
			// Not a definition file (no frontmatter) — TS parseAgentDefinition
			// returns null and the file is skipped without a warning.
			continue
		}
		def.Source = source
		l.set(def.AgentType, def)
	}
}

func (l *AgentLoader) Get(agentType string) *AgentDefinition {
	return l.agents[agentType]
}

// ListNames returns the definition names in load order (TS: definitions.map(d
// => d.name) over the array).
func (l *AgentLoader) ListNames() []string {
	names := make([]string, len(l.order))
	copy(names, l.order)
	return names
}
