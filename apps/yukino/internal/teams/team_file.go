package teams

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/storage"
)

type TeamFile struct {
	Name           string                     `json:"name"`
	Description    string                     `json:"description,omitempty"`
	CreatedAt      int64                      `json:"createdAt"`
	LeadAgentID    string                     `json:"leaderAgentId"`
	PermissionMode permissions.PermissionMode `json:"permissionMode"`
	Members        []TeamMemberFile           `json:"members"`
}

type TeamMemberFile struct {
	AgentID      string `json:"agentId"`
	Name         string `json:"name"`
	AgentType    string `json:"agentType,omitempty"`
	Model        string `json:"model,omitempty"`
	JoinedAt     int64  `json:"joinedAt"`
	WorktreePath string `json:"worktreePath,omitempty"`
	IsActive     bool   `json:"isActive"`
}

var nonAlnum = regexp.MustCompile(`[^a-zA-Z0-9]`)

func sanitizeTeamName(name string) string {
	return strings.ToLower(nonAlnum.ReplaceAllString(name, "-"))
}

const TeamConfigFilename = "config.json"

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%0*x", n*2, 0)
	}
	return hex.EncodeToString(buf)
}

func teamConfigPath(cwd, name string) string {
	return filepath.Join(teamDir(cwd, name), TeamConfigFilename)
}

// ReadTeamFile reads team configuration. It returns nil when the file does
// not exist or fails to parse, allowing the caller to treat it as "team not
// found" rather than propagating an exception.
func ReadTeamFile(cwd, name string) *TeamFile {
	return ReadTeamFileAtPath(teamConfigPath(cwd, name))
}

func ReadTeamFileAtPath(path string) *TeamFile {
	if _, err := os.Stat(path); err != nil {
		return nil
	}
	data, err := storage.ReadPrivateFileSync(path)
	if err != nil {
		return nil
	}
	tf, ok := parseTeamFile(data)
	if !ok {
		return nil
	}
	return tf
}

// parseTeamFile validates the on-disk document exactly like the reference's
// TeamFileSchema.parse: required fields with exact JSON types, permissionMode
// from the four-value enum, and per-member required agentId/name/joinedAt/
// isActive with optional string agentType/model/worktreePath. Unknown keys are
// stripped like zod's default object behavior.
func parseTeamFile(data []byte) (*TeamFile, bool) {
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, false
	}
	if _, ok := raw["name"].(string); !ok {
		return nil, false
	}
	if description, present := raw["description"]; present {
		if _, ok := description.(string); !ok {
			return nil, false
		}
	}
	if _, ok := raw["createdAt"].(float64); !ok {
		return nil, false
	}
	if _, ok := raw["leaderAgentId"].(string); !ok {
		return nil, false
	}
	mode, ok := raw["permissionMode"].(string)
	if !ok {
		return nil, false
	}
	switch permissions.PermissionMode(mode) {
	case permissions.ModeDefault, permissions.ModeAcceptEdits, permissions.ModePlan, permissions.ModeBypass:
	default:
		return nil, false
	}
	members, ok := raw["members"].([]any)
	if !ok {
		return nil, false
	}
	for _, entry := range members {
		member, ok := entry.(map[string]any)
		if !ok {
			return nil, false
		}
		if _, ok := member["agentId"].(string); !ok {
			return nil, false
		}
		if _, ok := member["name"].(string); !ok {
			return nil, false
		}
		if _, ok := member["joinedAt"].(float64); !ok {
			return nil, false
		}
		if _, ok := member["isActive"].(bool); !ok {
			return nil, false
		}
		for _, key := range []string{"agentType", "model", "worktreePath"} {
			if value, present := member[key]; present {
				if _, ok := value.(string); !ok {
					return nil, false
				}
			}
		}
	}
	var tf TeamFile
	if err := json.Unmarshal(data, &tf); err != nil {
		return nil, false
	}
	return &tf, true
}

// WriteTeamFile writes team configuration under the same cross-process lock
// used by other shared team files. The temporary file is in the destination
// directory, so rename publishes a complete JSON document atomically to
// unlocked readers. Persistence remains best-effort for the in-memory team.
func WriteTeamFile(cwd, name string, file *TeamFile, removedMembers ...string) {
	path := teamConfigPath(cwd, name)
	if err := storage.MkdirPrivateSync(filepath.Dir(path)); err != nil {
		return
	}
	_ = storage.WithFileSyncLock(path, func() error {
		next := file
		if current := ReadTeamFileAtPath(path); current != nil {
			incoming := map[string]bool{}
			for _, member := range file.Members {
				incoming[member.Name] = true
			}
			removed := map[string]bool{}
			for _, member := range removedMembers {
				removed[member] = true
			}
			merged := make([]TeamMemberFile, 0, len(current.Members)+len(file.Members))
			for _, member := range current.Members {
				if !incoming[member.Name] && !removed[member.Name] {
					merged = append(merged, member)
				}
			}
			merged = append(merged, file.Members...)
			nextFile := *file
			nextFile.Members = merged
			next = &nextFile
		}
		data, err := json.MarshalIndent(next, "", "  ")
		if err != nil {
			return err
		}
		tmpPath := fmt.Sprintf("%s.%d.%s.tmp", path, os.Getpid(), randomHex(8))
		defer os.Remove(tmpPath)
		if err := storage.WritePrivateFileSync(tmpPath, data, os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
			return err
		}
		return os.Rename(tmpPath, path)
	})
}

func (t *Team) snapshot() *TeamFile {
	tf := &TeamFile{
		Name:           t.Name,
		Description:    t.Description,
		CreatedAt:      t.CreatedAt,
		LeadAgentID:    t.LeadAgentID,
		PermissionMode: t.PermissionMode,
		Members:        make([]TeamMemberFile, 0, len(t.Members)),
	}
	// The reference serializes its insertion-ordered member Map; memberOrder
	// is the Go equivalent, keeping the on-disk order stable.
	for _, name := range t.memberOrder {
		m := t.Members[name]
		if m == nil {
			continue
		}
		agentID := m.AgentID
		if agentID == "" {
			agentID = m.Name
		}
		tf.Members = append(tf.Members, TeamMemberFile{
			AgentID:      agentID,
			Name:         m.Name,
			AgentType:    m.AgentType,
			Model:        m.Model,
			JoinedAt:     m.JoinedAt,
			WorktreePath: m.WorktreePath,
			IsActive:     m.Active,
		})
	}
	return tf
}

func (t *Team) persist() {
	WriteTeamFile(t.Cwd, t.Name, t.snapshot())
}
