package workflow

import (
	"encoding/json"
	"sort"
	"sync"
	"time"
)

func nowMillis() int64 { return time.Now().UnixMilli() }

// WorkflowRunPhase is one declared phase of a run.
type WorkflowRunPhase struct {
	Title  string `json:"title"`
	Status string `json:"status"` // pending | running | done
}

// WorkflowRunAgent is one agent row in the progress viewer.
type WorkflowRunAgent struct {
	ID         int    `json:"id"`
	Label      string `json:"label,omitempty"`
	Phase      string `json:"phase,omitempty"`
	Status     string `json:"status"` // running | done | cancelled
	ResultKind string `json:"resultKind,omitempty"`
	TokenCount int    `json:"tokenCount"`
	ToolCount  int    `json:"toolCount"`
	Model      string `json:"model,omitempty"`
	Detail     string `json:"detail,omitempty"`
}

// WorkflowRun is the persisted/viewed state of one run, mirroring
// workflowRunSchema.
type WorkflowRun struct {
	RunID        string             `json:"runId"`
	TaskID       string             `json:"taskId"`
	WorkflowName string             `json:"workflowName"`
	ScriptPath   string             `json:"scriptPath"`
	Status       string             `json:"status"` // running | completed | failed | killed
	StartedAt    int64              `json:"startedAt"`
	UpdatedAt    int64              `json:"updatedAt"`
	Description  string             `json:"description,omitempty"`
	Phases       []WorkflowRunPhase `json:"phases"`
	Agents       []WorkflowRunAgent `json:"agents"`
	Logs         []string           `json:"logs"`
	ReturnValue  any                `json:"returnValue,omitempty"`
	Error        string             `json:"error,omitempty"`
}

// ParseWorkflowRun validates a persisted state file.
func ParseWorkflowRun(raw map[string]any) (*WorkflowRun, error) {
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	var run WorkflowRun
	if err := json.Unmarshal(encoded, &run); err != nil {
		return nil, err
	}
	if run.RunID == "" || run.TaskID == "" || run.WorkflowName == "" || run.ScriptPath == "" {
		return nil, errInvalidRunState
	}
	switch run.Status {
	case "running", "completed", "failed", "killed":
	default:
		return nil, errInvalidRunState
	}
	for _, phase := range run.Phases {
		switch phase.Status {
		case "pending", "running", "done":
		default:
			return nil, errInvalidRunState
		}
	}
	for _, agent := range run.Agents {
		switch agent.Status {
		case "running", "done", "cancelled":
		default:
			return nil, errInvalidRunState
		}
	}
	if run.Phases == nil {
		run.Phases = []WorkflowRunPhase{}
	}
	if run.Agents == nil {
		run.Agents = []WorkflowRunAgent{}
	}
	if run.Logs == nil {
		run.Logs = []string{}
	}
	return &run, nil
}

var errInvalidRunState = &WorkflowError{Message: "invalid workflow run state"}

// WorkflowProgressStore keeps the live run snapshots, mirroring
// WorkflowProgressStore (subscribe/getSnapshot semantics).
type WorkflowProgressStore struct {
	mu         sync.Mutex
	runs       map[string]*WorkflowRun
	listeners  map[int]func()
	nextListen int
	snapshot   []*WorkflowRun
}

func NewWorkflowProgressStore() *WorkflowProgressStore {
	return &WorkflowProgressStore{runs: map[string]*WorkflowRun{}, listeners: map[int]func(){}}
}

func (s *WorkflowProgressStore) GetSnapshot() []*WorkflowRun {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*WorkflowRun(nil), s.snapshot...)
}

func (s *WorkflowProgressStore) Subscribe(listener func()) func() {
	s.mu.Lock()
	id := s.nextListen
	s.nextListen++
	s.listeners[id] = listener
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(s.listeners, id)
	}
}

func (s *WorkflowProgressStore) Get(runID string) *WorkflowRun {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.runs[runID]
	if !ok {
		return nil
	}
	return run
}

func (s *WorkflowProgressStore) Set(run *WorkflowRun) {
	s.mu.Lock()
	s.runs[run.RunID] = run
	snapshot := make([]*WorkflowRun, 0, len(s.runs))
	for _, item := range s.runs {
		snapshot = append(snapshot, item)
	}
	sort.Slice(snapshot, func(i, j int) bool { return snapshot[i].StartedAt > snapshot[j].StartedAt })
	s.snapshot = snapshot
	listeners := make([]func(), 0, len(s.listeners))
	for _, listener := range s.listeners {
		listeners = append(listeners, listener)
	}
	s.mu.Unlock()
	for _, listener := range listeners {
		listener()
	}
}

// Apply folds a progress event into the stored run, mirroring
// WorkflowProgressStore.apply.
func (s *WorkflowProgressStore) Apply(event ProgressEvent) {
	s.mu.Lock()
	previous, ok := s.runs[event.RunID]
	if !ok {
		s.mu.Unlock()
		return
	}
	run := cloneRun(previous)
	s.mu.Unlock()
	run.UpdatedAt = nowMillis()
	switch event.Type {
	case "run_started":
		run.WorkflowName = event.WorkflowName
		if event.Meta != nil {
			run.Description = event.Meta.Description
			run.Phases = nil
			for _, phase := range event.Meta.Phases {
				run.Phases = append(run.Phases, WorkflowRunPhase{Title: phase.Title, Status: "pending"})
			}
			if run.Phases == nil {
				run.Phases = []WorkflowRunPhase{}
			}
		}
	case "phase_started":
		found := false
		for i := range run.Phases {
			if run.Phases[i].Title == event.Phase {
				run.Phases[i].Status = "running"
				found = true
			}
		}
		if !found {
			run.Phases = append(run.Phases, WorkflowRunPhase{Title: event.Phase, Status: "running"})
		}
	case "phase_done":
		for i := range run.Phases {
			if run.Phases[i].Title == event.Phase {
				run.Phases[i].Status = "done"
			}
		}
	case "agent_started", "agent_done":
		var target *WorkflowRunAgent
		for i := range run.Agents {
			if run.Agents[i].ID == event.AgentID {
				target = &run.Agents[i]
				break
			}
		}
		if target == nil {
			run.Agents = append(run.Agents, WorkflowRunAgent{
				ID:     event.AgentID,
				Label:  event.Label,
				Phase:  event.Phase,
				Status: "running",
			})
			target = &run.Agents[len(run.Agents)-1]
		}
		if event.Type == "agent_done" && event.Result != nil {
			target.Status = "done"
			target.ResultKind = event.Result.Kind
			if event.Result.Kind == "ok" {
				if event.Result.TokenCount != nil {
					target.TokenCount = *event.Result.TokenCount
				}
				if event.Result.ToolCount != nil {
					target.ToolCount = *event.Result.ToolCount
				}
				target.Model = event.Result.Model
			} else if event.Result.Kind == "dead" {
				target.Detail = event.Result.Detail
			}
		}
	case "agent_progress":
		for i := range run.Agents {
			if run.Agents[i].ID == event.AgentID {
				run.Agents[i].TokenCount = event.TokenCount
				run.Agents[i].ToolCount = event.ToolCount
			}
		}
	case "log":
		run.Logs = append(append([]string{}, run.Logs...), event.Message)
		if len(run.Logs) > MaxWorkflowLogs {
			run.Logs = run.Logs[len(run.Logs)-MaxWorkflowLogs:]
		}
	case "run_done":
		run.Status = event.Status
		run.ReturnValue = event.ReturnValue
		run.Error = event.Error
		for i := range run.Agents {
			if run.Agents[i].Status == "running" {
				run.Agents[i].Status = "cancelled"
			}
		}
	}
	s.Set(run)
}

func cloneRun(run *WorkflowRun) *WorkflowRun {
	clone := *run
	clone.Phases = append([]WorkflowRunPhase{}, run.Phases...)
	clone.Agents = append([]WorkflowRunAgent{}, run.Agents...)
	clone.Logs = append([]string{}, run.Logs...)
	return &clone
}
