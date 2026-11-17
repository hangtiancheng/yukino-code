package workflow

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

// SavedWorkflow is the persisted launch request of a run.
type SavedWorkflow struct {
	WorkflowName   string `json:"workflowName"`
	Args           any    `json:"args,omitempty"`
	MaxConcurrency *int   `json:"maxConcurrency,omitempty"`
}

// ParseSavedWorkflow validates a persisted request.json.
func ParseSavedWorkflow(raw map[string]any) (*SavedWorkflow, error) {
	name, ok := raw["workflowName"].(string)
	if !ok {
		return nil, errors.New("saved workflow requires a workflowName string")
	}
	saved := &SavedWorkflow{WorkflowName: name}
	if value, ok := raw["args"]; ok {
		saved.Args = value
	}
	if value, ok := raw["maxConcurrency"]; ok && value != nil {
		number, err := toInt(value)
		if err != nil || number <= 0 {
			return nil, errors.New("saved workflow maxConcurrency must be a positive integer")
		}
		saved.MaxConcurrency = &number
	}
	return saved, nil
}

// WorkflowPersistence stores per-run script/request/state files under the
// project's workflow-runs directory.
type WorkflowPersistence struct {
	Directory string
}

func NewWorkflowPersistence(cwd string) *WorkflowPersistence {
	directory, err := storage.ProjectPath(cwd, WorkflowRunsDir)
	if err != nil {
		directory = filepath.Join(cwd, ".yukino", WorkflowRunsDir)
	}
	return &WorkflowPersistence{Directory: directory}
}

func (p *WorkflowPersistence) Path(runID, filename string) (string, error) {
	if !RunIDRe.MatchString(runID) {
		return "", errors.New("Invalid workflow run ID")
	}
	return filepath.Join(p.Directory, runID, filename), nil
}

// SaveRequest writes the script and request files, returning the script path.
func (p *WorkflowPersistence) SaveRequest(runID, script string, request *SavedWorkflow) (string, error) {
	scriptPath, err := p.Path(runID, ScriptFilename)
	if err != nil {
		return "", err
	}
	if err := storage.MkdirPrivateSync(filepath.Dir(scriptPath)); err != nil {
		return "", err
	}
	if err := storage.WritePrivateFileSync(scriptPath, []byte(script), os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
		return "", err
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		return "", err
	}
	requestPath, err := p.Path(runID, RequestFilename)
	if err != nil {
		return "", err
	}
	if err := storage.WritePrivateFileSync(requestPath, encoded, os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
		return "", err
	}
	return scriptPath, nil
}

func (p *WorkflowPersistence) ReadRequest(runID string) (*SavedWorkflow, error) {
	requestPath, err := p.Path(runID, RequestFilename)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(requestPath)
	if err != nil {
		return nil, err
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return ParseSavedWorkflow(value)
}

// WriteState atomically writes the run state file.
func (p *WorkflowPersistence) WriteState(run *WorkflowRun) error {
	statePath, err := p.Path(run.RunID, StateFilename)
	if err != nil {
		return err
	}
	if err := storage.MkdirPrivateSync(filepath.Dir(statePath)); err != nil {
		return err
	}
	encoded, err := json.Marshal(run)
	if err != nil {
		return err
	}
	if err := storage.WritePrivateFileSync(statePath+".tmp", encoded, os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
		return err
	}
	if err := os.Rename(statePath+".tmp", statePath); err != nil {
		_ = os.Remove(statePath + ".tmp")
		return err
	}
	return nil
}

// List loads all persisted runs sorted by startedAt descending.
func (p *WorkflowPersistence) List() ([]*WorkflowRun, error) {
	entries, err := os.ReadDir(p.Directory)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var runs []*WorkflowRun
	for _, entry := range entries {
		id := entry.Name()
		if !RunIDRe.MatchString(id) {
			continue
		}
		statePath, err := p.Path(id, StateFilename)
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(statePath)
		if err != nil {
			continue
		}
		var value map[string]any
		if err := json.Unmarshal(raw, &value); err != nil {
			continue
		}
		run, err := ParseWorkflowRun(value)
		if err != nil {
			continue
		}
		runs = append(runs, run)
	}
	sort.Slice(runs, func(i, j int) bool { return runs[i].StartedAt > runs[j].StartedAt })
	return runs, nil
}
