package todo

import (
	"encoding/json"
	"fmt"
	"sync"

	"github.com/google/uuid"
)

type TaskStatus string

const (
	StatusPending    TaskStatus = "pending"
	StatusInProgress TaskStatus = "in_progress"
	StatusCompleted  TaskStatus = "completed"
	StatusBlocked    TaskStatus = "blocked"
	StatusCancelled  TaskStatus = "cancelled"
)

type Task struct {
	ID          string         `json:"id"`
	Subject     string         `json:"subject"`
	Description string         `json:"description"`
	Status      TaskStatus     `json:"status"`
	Owner       string         `json:"owner"`
	Blocks      []string       `json:"blocks"`
	BlockedBy   []string       `json:"blockedBy"`
	Metadata    map[string]any `json:"metadata"`
	Priority    string         `json:"priority,omitempty"`
	CreatedBy   *string        `json:"createdBy,omitempty"`
}
type Board interface {
	BoardID() string
	Write(map[string]any) ([]*Task, error)
}
type TaskList struct {
	mu           sync.Mutex
	store        *Store
	tasks        []*Task
	nextID       int
	memoryID     string
	listeners    map[int]func([]*Task)
	nextListener int
}

func NewTaskList(store *Store) (*TaskList, error) {
	list := &TaskList{tasks: []*Task{}, nextID: 1, memoryID: "private:" + uuid.NewString(), listeners: map[int]func([]*Task){}}
	if store != nil {
		if err := list.UseStore(store); err != nil {
			return nil, err
		}
	}
	return list, nil
}
func CloneTasks(tasks []*Task) []*Task {
	encoded, err := json.Marshal(tasks)
	if err != nil {
		panic(err)
	}
	var result []*Task
	if err := json.Unmarshal(encoded, &result); err != nil {
		panic(err)
	}
	if result == nil {
		result = []*Task{}
	}
	return result
}
func (l *TaskList) BoardID() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.store != nil {
		return l.store.BoardID()
	}
	return l.memoryID
}
func (l *TaskList) UseStore(store *Store) error {
	snapshot, err := store.Load()
	if err != nil {
		return err
	}
	if err := ValidateDependencies(snapshot.Tasks); err != nil {
		return err
	}
	l.mu.Lock()
	l.store = store
	l.tasks = snapshot.Tasks
	l.nextID = snapshot.NextID
	l.mu.Unlock()
	l.emitChange()
	return nil
}
func (l *TaskList) Subscribe(listener func([]*Task)) func() {
	l.mu.Lock()
	id := l.nextListener
	l.nextListener++
	l.listeners[id] = listener
	tasks := CloneTasks(l.tasks)
	l.mu.Unlock()
	listener(tasks)
	return func() { l.mu.Lock(); delete(l.listeners, id); l.mu.Unlock() }
}
func (l *TaskList) emitChange() {
	l.mu.Lock()
	listeners := make([]func([]*Task), 0, len(l.listeners))
	for _, listener := range l.listeners {
		listeners = append(listeners, listener)
	}
	tasks := CloneTasks(l.tasks)
	l.mu.Unlock()
	for _, listener := range listeners {
		func() { defer func() { recover() }(); listener(CloneTasks(tasks)) }()
	}
}
func (l *TaskList) Get(id string) *Task {
	for _, task := range l.List() {
		if task.ID == id {
			return task
		}
	}
	return nil
}
func (l *TaskList) List() []*Task { l.mu.Lock(); defer l.mu.Unlock(); return CloneTasks(l.tasks) }
func (l *TaskList) Write(input map[string]any) ([]*Task, error) {
	parsed, err := ParseWrite(input)
	if err != nil {
		return nil, err
	}
	l.mu.Lock()
	if len(parsed.Todos) == 0 && len(parsed.DeleteIDs) == 0 {
		result := CloneTasks(l.tasks)
		l.mu.Unlock()
		return result, nil
	}
	result, nextID, err := ApplyWrite(l.tasks, l.nextID, parsed, WriteOptions{})
	if err == nil && l.store != nil {
		err = l.store.Save(result, nextID)
	}
	if err != nil {
		l.mu.Unlock()
		return nil, err
	}
	l.tasks = result
	l.nextID = nextID
	result = CloneTasks(result)
	l.mu.Unlock()
	l.emitChange()
	return result, nil
}
func Progress(tasks []*Task) string {
	completed := 0
	for _, task := range tasks {
		if task.Status == StatusCompleted {
			completed++
		}
	}
	return fmt.Sprintf("DONE %d/%d", completed, len(tasks))
}
