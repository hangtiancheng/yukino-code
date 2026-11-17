package teams

import (
	"fmt"
	"sync"

	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/todo"
)

type SharedTaskStore struct {
	mu           sync.Mutex
	path         string
	listeners    map[int]func([]*todo.Task)
	nextListener int
}

// NewSharedTaskStore mirrors the SharedTaskStore constructor: the board is
// loaded immediately, so an unreadable file fails at construction time.
func NewSharedTaskStore(path string) (*SharedTaskStore, error) {
	store := &SharedTaskStore{path: path, listeners: map[int]func([]*todo.Task){}}
	if _, err := store.load(); err != nil {
		return nil, err
	}
	return store, nil
}
func (s *SharedTaskStore) load() (todo.Snapshot, error) {
	snapshot, err := todo.LoadSnapshot(s.path, true)
	if err == nil {
		err = todo.ValidateDependencies(snapshot.Tasks)
	}
	if err != nil {
		return todo.Snapshot{}, fmt.Errorf("Cannot load an unreadable shared task board: %w", err)
	}
	return snapshot, nil
}
func (s *SharedTaskStore) Subscribe(listener func([]*todo.Task)) func() {
	s.mu.Lock()
	id := s.nextListener
	s.nextListener++
	s.listeners[id] = listener
	s.mu.Unlock()
	return func() { s.mu.Lock(); delete(s.listeners, id); s.mu.Unlock() }
}
func (s *SharedTaskStore) mutate(operation func(todo.Snapshot) (todo.Snapshot, []*todo.Task, bool, error)) ([]*todo.Task, error) {
	s.mu.Lock()
	var result, latest []*todo.Task
	changed := false
	err := storage.WithFileSyncLock(s.path, func() error {
		snapshot, err := s.load()
		if err != nil {
			return err
		}
		next, tasks, save, err := operation(snapshot)
		if err != nil {
			return err
		}
		if save {
			if err := todo.ValidateDependencies(next.Tasks); err != nil {
				return err
			}
			if err := todo.SaveSnapshot(s.path, next.Tasks, next.NextID); err != nil {
				return err
			}
		}
		result = todo.CloneTasks(tasks)
		latest = todo.CloneTasks(next.Tasks)
		changed = save
		return nil
	})
	listeners := make([]func([]*todo.Task), 0, len(s.listeners))
	for _, listener := range s.listeners {
		listeners = append(listeners, listener)
	}
	s.mu.Unlock()
	if err == nil && changed {
		for _, listener := range listeners {
			func() { defer func() { recover() }(); listener(todo.CloneTasks(latest)) }()
		}
	}
	return result, err
}
func (s *SharedTaskStore) Write(input map[string]any, options todo.WriteOptions) ([]*todo.Task, error) {
	create := options.CreateTask
	options.CreateTask = func(task *todo.Task) {
		name := ""
		task.CreatedBy = &name
		if create != nil {
			create(task)
		}
	}
	parsed, err := todo.ParseWrite(input)
	if err != nil {
		return nil, err
	}
	if len(parsed.Todos) == 0 && len(parsed.DeleteIDs) == 0 {
		return s.ListTasks("", "")
	}
	return s.mutate(func(snapshot todo.Snapshot) (todo.Snapshot, []*todo.Task, bool, error) {
		tasks, nextID, err := todo.ApplyWrite(snapshot.Tasks, snapshot.NextID, parsed, options)
		return todo.Snapshot{Tasks: tasks, NextID: nextID}, tasks, true, err
	})
}
func (s *SharedTaskStore) Get(id string) (*todo.Task, error) {
	tasks, err := s.ListTasks("", "")
	if err != nil {
		return nil, err
	}
	for _, task := range tasks {
		if task.ID == id {
			return task, nil
		}
	}
	return nil, nil
}
func (s *SharedTaskStore) ListTasks(status, owner string) ([]*todo.Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	snapshot, err := s.load()
	if err != nil {
		return nil, err
	}
	tasks := []*todo.Task{}
	for _, task := range snapshot.Tasks {
		if status != "" && string(task.Status) != status || owner != "" && task.Owner != owner {
			continue
		}
		tasks = append(tasks, task)
	}
	return tasks, nil
}
func (s *SharedTaskStore) ReleaseOwner(owner string) ([]*todo.Task, error) {
	return s.mutate(func(snapshot todo.Snapshot) (todo.Snapshot, []*todo.Task, bool, error) {
		released := []*todo.Task{}
		for _, task := range snapshot.Tasks {
			if task.Owner == owner && task.Status != todo.StatusCompleted && task.Status != todo.StatusCancelled {
				task.Owner = ""
				task.Status = todo.StatusPending
				released = append(released, task)
			}
		}
		return snapshot, released, len(released) > 0, nil
	})
}
func (s *SharedTaskStore) InitEmpty() error {
	_, err := s.mutate(func(todo.Snapshot) (todo.Snapshot, []*todo.Task, bool, error) {
		return todo.Snapshot{NextID: 1, Tasks: []*todo.Task{}}, []*todo.Task{}, true, nil
	})
	return err
}
