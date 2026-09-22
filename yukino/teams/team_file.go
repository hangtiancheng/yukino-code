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

package teams

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// TeamFile is the on-disk representation of team configuration, stored at
// <teamsBaseDir>/<slug>/config.json.
//
// The in-memory Member holds agent instances, conversations, and cancel
// functions — none of which are serializable — so the persisted form is a
// separate metadata-only structure. The two are correlated by member name.
//
// This file solves the cross-restart concern: a restarted server must be
// able to resume previously created teams.
type TeamFile struct {
	Name        string           `json:"name"`
	Description string           `json:"description,omitempty"`
	CreatedAt   int64            `json:"createdAt"`
	LeadAgentID string           `json:"leadAgentId"`
	Members     []TeamMemberFile `json:"members"`
}

// TeamMemberFile is the metadata for a single member. IsActive uses a pointer
// to distinguish three states: nil means just registered and not yet started,
// true means running, false means idle.
type TeamMemberFile struct {
	AgentID      string `json:"agentId"`
	Name         string `json:"name"`
	AgentType    string `json:"agentType,omitempty"`
	Model        string `json:"model,omitempty"`
	JoinedAt     int64  `json:"joinedAt"`
	WorktreePath string `json:"worktreePath,omitempty"`
	// BackendType mirrors the TS backendType field (the team manager's
	// mode). The Go host only implements the in-process backend.
	BackendType string `json:"backendType,omitempty"`
	IsActive    *bool  `json:"isActive,omitempty"`
}

var nonAlnum = regexp.MustCompile(`[^a-zA-Z0-9]`)

// sanitizeTeamName compresses a team name into a form usable as a directory
// name: all non-alphanumeric characters are replaced with hyphens and
// lowercased. Team names are chosen by the LLM and may contain spaces,
// non-ASCII characters, and punctuation; without sanitization, various
// filesystem issues would arise.
func sanitizeTeamName(name string) string {
	return strings.ToLower(nonAlnum.ReplaceAllString(name, "-"))
}

func teamFilePath(baseDir, name string) string {
	return filepath.Join(baseDir, sanitizeTeamName(name), "config.json")
}

// TeamsBaseDir mirrors the TS teamsBaseDir (team-file.ts:81): team files
// persist under ~/.yukino/teams. Hosts running the multi-user chat-server
// mode (config `concurrent: true`) pass a per-session workspace to
// NewTeamManager instead, so users cannot see each other's teams.
func TeamsBaseDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(".yukino", "teams")
	}
	return filepath.Join(home, ".yukino", "teams")
}

// ReadTeamFile reads team configuration, or nil when there is none. TS wraps
// the read in a try/catch after an existsSync guard, so a missing file, an I/O
// failure, malformed JSON and a TeamFileSchema violation all collapse to null.
func ReadTeamFile(baseDir, name string) *TeamFile {
	data, err := os.ReadFile(teamFilePath(baseDir, name))
	if err != nil {
		return nil
	}
	if !isValidTeamFile(data) {
		return nil
	}
	var tf TeamFile
	if err := json.Unmarshal(data, &tf); err != nil {
		return nil
	}
	return &tf
}

// isValidTeamFile applies TeamFileSchema's required fields (name, createdAt,
// leadAgentId, members) and each member's required fields (agentId, name,
// joinedAt). An incomplete record makes the whole file invisible, exactly like
// a zod parse failure.
func isValidTeamFile(data []byte) bool {
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return false
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return false
	}
	if _, ok := obj["name"].(string); !ok {
		return false
	}
	if _, ok := obj["createdAt"].(float64); !ok {
		return false
	}
	if _, ok := obj["leadAgentId"].(string); !ok {
		return false
	}
	members, ok := obj["members"].([]any)
	if !ok {
		return false
	}
	for _, entry := range members {
		member, ok := entry.(map[string]any)
		if !ok {
			return false
		}
		if _, ok := member["agentId"].(string); !ok {
			return false
		}
		if _, ok := member["name"].(string); !ok {
			return false
		}
		if _, ok := member["joinedAt"].(float64); !ok {
			return false
		}
	}
	return true
}

// WriteTeamFile writes team configuration, creating the directory if needed.
// The bytes mirror TS writeTeamFile's JSON.stringify(file, null, 2): no HTML
// escaping of `<`/`>`/`&`.
func WriteTeamFile(baseDir, name string, tf *TeamFile) error {
	dir := filepath.Dir(teamFilePath(baseDir, name))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(tf); err != nil {
		return err
	}
	return os.WriteFile(teamFilePath(baseDir, name), bytes.TrimSuffix(buf.Bytes(), []byte("\n")), 0o644)
}

// ListTeamNames enumerates the team directories present on disk under baseDir.
// Used by DeleteAll to sweep residuals from previous sessions that never appear
// in the in-memory team map (TS: team-file.ts listTeamNames).
func ListTeamNames(baseDir string) []string {
	entries, err := os.ReadDir(baseDir)
	if err != nil {
		return nil
	}
	var names []string
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	return names
}

// snapshot exports the in-memory Team into a persistable TeamFile.
// The caller must hold t.mu.
func (t *Team) snapshot() *TeamFile {
	tf := &TeamFile{
		Name:        t.Name,
		Description: t.Description,
		CreatedAt:   t.CreatedAt,
		LeadAgentID: t.LeadAgentID,
		Members:     make([]TeamMemberFile, 0, len(t.members)),
	}
	if tf.CreatedAt == 0 {
		tf.CreatedAt = time.Now().Unix()
	}
	// Iterate the insertion-ordered name list: TS spreads [...this.members]
	// (Map order), so a map-range here would shuffle config.json between
	// writes and randomize the order a restarted GetTeam restores.
	for _, name := range t.memberOrder {
		m := t.members[name]
		if m == nil {
			continue
		}
		active := m.Active
		tf.Members = append(tf.Members, TeamMemberFile{
			AgentID:      m.AgentID,
			Name:         m.Name,
			AgentType:    m.AgentType,
			Model:        m.Model,
			JoinedAt:     m.JoinedAt,
			WorktreePath: m.WorktreePath,
			BackendType:  "in-process",
			IsActive:     &active,
		})
	}
	return tf
}

// persist writes the current state back to disk. Write failures do not affect
// the in-memory team's continued operation, so errors are swallowed here:
// persistence serves cross-process and cross-restart needs, not runtime
// correctness. The caller must hold t.mu.
func (t *Team) persist() {
	if err := WriteTeamFile(t.baseDir, t.Name, t.snapshot()); err != nil {
		log.Error("teams operation failed", "err", err)
	}
}
