package workflow

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

// canonical sorts object keys recursively so the agent-call key is stable.
// encoding/json marshals maps in byte-sorted key order, matching the
// reference canonicalization for ASCII keys.
func canonical(value any) any {
	switch v := value.(type) {
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = canonical(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = canonical(item)
		}
		return out
	default:
		return value
	}
}

// AgentCallKey hashes the replay identity of an agent call: the prompt plus
// the canonical JSON of the params without label/phase.
func AgentCallKey(prompt string, params *AgentRunParams) string {
	rest := map[string]any{"prompt": params.Prompt}
	if params.Schema != nil {
		rest["schema"] = canonical(params.Schema)
	}
	if params.Model != "" {
		rest["model"] = params.Model
	}
	if params.MaxTokens != 0 {
		rest["maxTokens"] = params.MaxTokens
	}
	if params.AgentType != "" {
		rest["agentType"] = params.AgentType
	}
	if params.Isolation != "" {
		rest["isolation"] = params.Isolation
	}
	if params.AllowedTools != nil {
		rest["allowedTools"] = params.AllowedTools
	}
	encoded, err := json.Marshal(canonical(rest))
	if err != nil {
		encoded = []byte("{}")
	}
	sum := sha256.Sum256(append([]byte(prompt+"\n"), encoded...))
	return hex.EncodeToString(sum[:])
}

// JournalStore persists per-run agent call journals.
type JournalStore interface {
	Read(runID string) ([]JournalEntry, error)
	Append(runID string, entry JournalEntry) error
	Replace(runID string, entries []JournalEntry) error
}

type fileJournalStore struct {
	runsDir string
	mu      sync.Mutex
}

// CreateFileJournalStore builds the file-backed journal store rooted at
// runsDir; operations are serialized like the reference promise queue.
func CreateFileJournalStore(runsDir string) JournalStore {
	return &fileJournalStore{runsDir: runsDir}
}

func (s *fileJournalStore) pathOf(runID string) (string, error) {
	if !RunIDRe.MatchString(runID) {
		return "", errors.New("Invalid workflow run ID")
	}
	return filepath.Join(s.runsDir, runID, JournalFilename), nil
}

func (s *fileJournalStore) Read(runID string) ([]JournalEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	path, err := s.pathOf(runID)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var entries []JournalEntry
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var value map[string]any
		if err := json.Unmarshal([]byte(line), &value); err != nil {
			return nil, err
		}
		entry, err := ParseJournalEntry(value)
		if err != nil {
			return nil, err
		}
		entries = append(entries, *entry)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Seq < entries[j].Seq })
	return entries, nil
}

func (s *fileJournalStore) Append(runID string, entry JournalEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	path, err := s.pathOf(runID)
	if err != nil {
		return err
	}
	if err := storage.MkdirPrivateSync(filepath.Dir(path)); err != nil {
		return err
	}
	encoded, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	return storage.AppendPrivateFileSync(path, append(encoded, '\n'))
}

func (s *fileJournalStore) Replace(runID string, entries []JournalEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	path, err := s.pathOf(runID)
	if err != nil {
		return err
	}
	if err := storage.MkdirPrivateSync(filepath.Dir(path)); err != nil {
		return err
	}
	var sb strings.Builder
	for _, entry := range entries {
		encoded, err := json.Marshal(entry)
		if err != nil {
			return err
		}
		sb.Write(encoded)
		sb.WriteByte('\n')
	}
	if err := storage.WritePrivateFileSync(path+".tmp", []byte(sb.String()), os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
		return err
	}
	if err := os.Rename(path+".tmp", path); err != nil {
		_ = os.Remove(path + ".tmp")
		return fmt.Errorf("journal replace: %w", err)
	}
	return nil
}
