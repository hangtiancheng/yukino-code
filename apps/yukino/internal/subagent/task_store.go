package subagent

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

type storedBackgroundTask struct {
	tools.BackgroundTask
	Notified bool `json:"notified"`
}
type backgroundTaskStore struct{ directory string }

var backgroundTaskIDPattern = regexp.MustCompile(`^[\w-]+-[1-9]\d*$`)

func newBackgroundTaskStore(sessionID string) (*backgroundTaskStore, error) {
	dir, err := storage.SessionPath(sessionID, "background-tasks")
	if err != nil {
		return nil, err
	}
	return &backgroundTaskStore{dir}, nil
}
func validateTaskRecord(data []byte) (storedBackgroundTask, error) {
	var record storedBackgroundTask
	if err := json.Unmarshal(data, &record); err != nil {
		return record, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return record, err
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		return record, err
	}
	for _, key := range []string{"id", "name", "status", "output"} {
		if _, ok := decoded[key].(string); !ok {
			return record, fmt.Errorf("Invalid background task record: %s must be a string", key)
		}
	}
	if _, ok := decoded["startedAt"].(float64); !ok {
		return record, fmt.Errorf("Invalid background task record: startedAt must be a number")
	}
	if _, ok := decoded["notified"].(bool); !ok {
		return record, fmt.Errorf("Invalid background task record: notified must be a boolean")
	}
	for _, key := range []string{"kind", "originToolCallId", "error", "transcriptPath"} {
		if value, exists := decoded[key]; exists {
			if _, ok := value.(string); !ok {
				return record, fmt.Errorf("Invalid background task record: %s must be a string", key)
			}
		}
	}
	for _, key := range []string{"id", "name", "status", "output", "startedAt", "notified"} {
		if _, ok := fields[key]; !ok {
			return record, fmt.Errorf("Invalid background task record: missing %s", key)
		}
	}
	if !backgroundTaskIDPattern.MatchString(record.ID) || record.Status != "running" && record.Status != "completed" && record.Status != "failed" && record.Status != "cancelled" || record.Kind != "" && record.Kind != "agent" && record.Kind != "shell" && record.Kind != "workflow" {
		return record, fmt.Errorf("Invalid background task record")
	}
	return record, nil
}
func (s *backgroundTaskStore) get(id string) (*storedBackgroundTask, error) {
	if !backgroundTaskIDPattern.MatchString(id) {
		return nil, nil
	}
	data, err := storage.ReadPrivateFileSync(filepath.Join(s.directory, id+".json"))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	record, err := validateTaskRecord(data)
	if err != nil {
		return nil, err
	}
	if record.ID != id {
		return nil, fmt.Errorf("Background task ID does not match its file: %s", id)
	}
	return &record, nil
}
func (s *backgroundTaskStore) load() ([]storedBackgroundTask, error) {
	entries, err := os.ReadDir(s.directory)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []storedBackgroundTask
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		record, err := s.get(strings.TrimSuffix(entry.Name(), ".json"))
		if err != nil {
			return nil, err
		}
		if record != nil {
			out = append(out, *record)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StartedAt != out[j].StartedAt {
			return out[i].StartedAt < out[j].StartedAt
		}
		return taskIDNumber(out[i].ID) < taskIDNumber(out[j].ID)
	})
	return out, nil
}
func taskIDNumber(id string) uint64 {
	parts := strings.Split(id, "-")
	n, _ := strconv.ParseUint(parts[len(parts)-1], 10, 64)
	return n
}
func (s *backgroundTaskStore) save(record storedBackgroundTask) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if _, err := validateTaskRecord(data); err != nil {
		return err
	}
	if err := storage.MkdirPrivateSync(s.directory); err != nil {
		return err
	}
	target := filepath.Join(s.directory, record.ID+".json")
	temporary := target + "." + uuid.NewString() + ".tmp"
	defer os.Remove(temporary)
	if err := storage.WritePrivateFileSync(temporary, data, os.O_WRONLY|os.O_CREATE|os.O_EXCL); err != nil {
		return err
	}
	return os.Rename(temporary, target)
}
