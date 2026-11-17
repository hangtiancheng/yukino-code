package todo

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"

	"github.com/google/uuid"
	"github.com/yukino-js/yukino/yukino/internal/storage"
)

const TasksFilename = "tasks.json"

var listIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type Snapshot struct {
	NextID int     `json:"nextId"`
	Tasks  []*Task `json:"tasks"`
}
type Store struct {
	path    string
	boardID string
}

func NewStore(listID string) (*Store, error) {
	if !listIDPattern.MatchString(listID) {
		return nil, errors.New("Invalid task list ID")
	}
	path, err := storage.SessionPath(listID, TasksFilename)
	if err != nil {
		return nil, err
	}
	return &Store{path: path, boardID: "private:" + listID}, nil
}
func (s *Store) BoardID() string { return s.boardID }
func LoadSnapshot(path string, shared bool) (Snapshot, error) {
	data, err := storage.ReadPrivateFileSync(path)
	if os.IsNotExist(err) {
		return Snapshot{NextID: 1, Tasks: []*Task{}}, nil
	}
	if err != nil {
		return Snapshot{}, err
	}
	var raw struct {
		NextID json.RawMessage  `json:"nextId"`
		Tasks  []map[string]any `json:"tasks"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return Snapshot{}, err
	}
	var nextID int
	if err := json.Unmarshal(raw.NextID, &nextID); err != nil || nextID < 1 || float64(nextID) > 9007199254740991 {
		return Snapshot{}, errors.New("Invalid task ID counter")
	}
	if raw.Tasks == nil {
		return Snapshot{}, errors.New("Invalid task snapshot")
	}
	tasks := make([]*Task, 0, len(raw.Tasks))
	for _, fields := range raw.Tasks {
		for _, key := range []string{"id", "subject", "description", "status", "blocks", "blockedBy", "metadata"} {
			if fields[key] == nil {
				return Snapshot{}, fmt.Errorf("Invalid task field: %s", key)
			}
		}
		if shared {
			if _, ok := fields["createdBy"].(string); !ok {
				return Snapshot{}, errors.New("Invalid createdBy")
			}
		}
		for _, key := range []string{"owner", "priority"} {
			if value, exists := fields[key]; exists && value == nil {
				return Snapshot{}, fmt.Errorf("Invalid task field: %s", key)
			}
		}
		if value, exists := fields["priority"]; exists {
			priority, ok := value.(string)
			if !ok || !slices.Contains([]string{"high", "medium", "low"}, priority) {
				return Snapshot{}, errors.New("Invalid task priority")
			}
		}
		if !shared {
			delete(fields, "createdBy")
		}
		task := &Task{}
		if err := assignTaskFields(task, fields); err != nil {
			return Snapshot{}, err
		}
		task.ID, _ = fields["id"].(string)
		if !taskIDPattern.MatchString(task.ID) {
			return Snapshot{}, errors.New("Invalid task ID")
		}
		if !shared {
			task.CreatedBy = nil
		}
		if err := validateTask(task); err != nil {
			return Snapshot{}, err
		}
		tasks = append(tasks, task)
		if taskIDNumber(task.ID) >= float64(nextID) {
			// The shared board reports its own counter error text, mirroring
			// SHARED_TASK_INVALID_ID_COUNTER_ERROR in teams/shared-task.ts.
			if shared {
				return Snapshot{}, errors.New("Invalid shared task ID counter")
			}
			return Snapshot{}, errors.New("Invalid task ID counter")
		}
	}
	return Snapshot{NextID: nextID, Tasks: tasks}, nil
}
func (s *Store) Load() (Snapshot, error) {
	result, err := LoadSnapshot(s.path, false)
	if err != nil {
		return Snapshot{}, fmt.Errorf("Cannot load an unreadable task list: %w", err)
	}
	return result, nil
}
func SaveSnapshot(path string, tasks []*Task, nextID int) error {
	if err := storage.MkdirPrivateSync(filepath.Dir(path)); err != nil {
		return err
	}
	data, err := json.MarshalIndent(Snapshot{NextID: nextID, Tasks: tasks}, "", "  ")
	if err != nil {
		return err
	}
	temp := path + "." + uuid.NewString() + ".tmp"
	defer os.Remove(temp)
	if err := storage.WritePrivateFileSync(temp, data, os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
		return err
	}
	return os.Rename(temp, path)
}
func (s *Store) Save(tasks []*Task, nextID int) error { return SaveSnapshot(s.path, tasks, nextID) }
