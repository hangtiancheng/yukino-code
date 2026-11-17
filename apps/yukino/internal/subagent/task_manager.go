package subagent

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/logger"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

var nextTaskID atomic.Uint64

type managedTask struct {
	tools.BackgroundTask
	cancel            func()
	done              chan struct{}
	pending, notified bool
}
type TaskManager struct {
	mu           sync.Mutex
	tasks        map[string]*managedTask
	order        []string
	store        *backgroundTaskStore
	listeners    map[uint64]func([]tools.BackgroundTask)
	nextListener uint64
}

func NewTaskManager() *TaskManager {
	return &TaskManager{tasks: make(map[string]*managedTask), listeners: make(map[uint64]func([]tools.BackgroundTask))}
}
func (tm *TaskManager) persist(task *managedTask) error {
	if tm.store == nil {
		return nil
	}
	return tm.store.save(storedBackgroundTask{task.BackgroundTask, task.notified})
}
func (tm *TaskManager) UseSession(id string) error {
	store, err := newBackgroundTaskStore(id)
	if err != nil {
		return err
	}
	records, err := store.load()
	if err != nil {
		return err
	}
	tm.mu.Lock()
	for _, task := range tm.tasks {
		if task.pending {
			tm.mu.Unlock()
			return errors.New("Stop and await tasks before switching their session")
		}
	}
	tm.tasks = make(map[string]*managedTask)
	tm.order = nil
	tm.store = store
	for _, record := range records {
		n := taskIDNumber(record.ID)
		for current := nextTaskID.Load(); current < n; current = nextTaskID.Load() {
			if nextTaskID.CompareAndSwap(current, n) {
				break
			}
		}
		done := make(chan struct{})
		close(done)
		task := &managedTask{BackgroundTask: record.BackgroundTask, done: done, notified: record.Notified}
		task.Done = done
		if task.Status == "running" {
			task.Status = "failed"
			task.Error = "Task interrupted before completion (session restored)"
			if task.Output != "" {
				task.Output += "\n\n"
			}
			task.Output += task.Error
			task.CompletedAt = time.Now().UnixMilli()
			task.notified = false
			if err := tm.persist(task); err != nil {
				tm.mu.Unlock()
				return err
			}
		}
		tm.tasks[task.ID] = task
		tm.order = append(tm.order, task.ID)
	}
	tm.prune()
	tm.mu.Unlock()
	tm.emit()
	return nil
}
func (tm *TaskManager) Create(name string, runner func(string) (string, error), cancel func(), options tools.TaskOptions) (string, error) {
	prefix := options.IDPrefix
	if prefix == "" {
		prefix = "agent"
	}
	id := fmt.Sprintf("%s-%d", prefix, nextTaskID.Add(1))
	done := make(chan struct{})
	task := &managedTask{BackgroundTask: tools.BackgroundTask{ID: id, Name: name, Kind: options.Kind, OriginToolCallID: options.OriginToolCallID, Status: "running", Output: "", TranscriptPath: options.TranscriptPath, StartedAt: time.Now().UnixMilli(), Done: done}, cancel: cancel, done: done, pending: true}
	// The reference registers the task and schedules the runner before the
	// initial persist, so a persistence failure still leaves the task running
	// while surfacing the error to the caller.
	tm.mu.Lock()
	tm.tasks[id] = task
	tm.order = append(tm.order, id)
	persistErr := tm.persist(task)
	tm.mu.Unlock()
	go func() {
		tm.mu.Lock()
		cancelled := task.Status == "cancelled"
		tm.mu.Unlock()
		var output string
		var err error
		if !cancelled || options.Kind == "workflow" || options.Kind == "shell" {
			func() {
				defer func() {
					if r := recover(); r != nil {
						err = fmt.Errorf("%v", r)
					}
				}()
				output, err = runner(id)
			}()
		}
		tm.mu.Lock()
		var failure *tools.TaskFailure
		if task.Status == "running" {
			if err == nil {
				task.Status = "completed"
				task.Output = output
			} else {
				task.Status = "failed"
				task.Error = err.Error()
				task.Output = "Error: " + err.Error()
				if errors.As(err, &failure) {
					task.Output = failure.Output
				}
			}
		} else if task.Status == "cancelled" && errors.As(err, &failure) {
			task.Output = failure.Output
		}
		task.cancel = nil
		task.CompletedAt = time.Now().UnixMilli()
		task.pending = false
		// The reference surfaces completion persistence failures through the
		// done promise, where they end up as unhandled rejections handled by
		// the process-level recovery path; Go's channel cannot carry them, so
		// log them instead of silently dropping the failure.
		if err := tm.persist(task); err != nil {
			logger.Global().Error(map[string]any{"err": err, "taskId": task.ID}, "background task persistence failed")
		}
		close(task.done)
		tm.mu.Unlock()
		tm.emit()
	}()
	if persistErr == nil {
		tm.emit()
	}
	if persistErr != nil {
		return "", persistErr
	}
	return id, nil
}
func (tm *TaskManager) Get(id string) *tools.BackgroundTask {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	if task := tm.tasks[id]; task != nil {
		copy := task.BackgroundTask
		return &copy
	}
	if tm.store != nil {
		if record, err := tm.store.get(id); err == nil && record != nil {
			done := make(chan struct{})
			close(done)
			record.Done = done
			return &record.BackgroundTask
		}
	}
	return nil
}
func (tm *TaskManager) List() []tools.BackgroundTask {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	out := make([]tools.BackgroundTask, 0, len(tm.order))
	for _, id := range tm.order {
		if task := tm.tasks[id]; task != nil {
			out = append(out, task.BackgroundTask)
		}
	}
	return out
}
func (tm *TaskManager) Subscribe(listener func([]tools.BackgroundTask)) func() {
	tm.mu.Lock()
	tm.nextListener++
	id := tm.nextListener
	tm.listeners[id] = listener
	tm.mu.Unlock()
	listener(tm.List())
	return func() { tm.mu.Lock(); delete(tm.listeners, id); tm.mu.Unlock() }
}
func (tm *TaskManager) emit() {
	tasks := tm.List()
	tm.mu.Lock()
	listeners := make([]func([]tools.BackgroundTask), 0, len(tm.listeners))
	for _, listener := range tm.listeners {
		listeners = append(listeners, listener)
	}
	tm.mu.Unlock()
	for _, listener := range listeners {
		func() { defer func() { recover() }(); listener(tasks) }()
	}
}
func (tm *TaskManager) HasRunning() bool {
	for _, task := range tm.List() {
		if task.Status == "running" {
			return true
		}
	}
	return false
}

// Stop cancels a running task. Like the reference stop(), a persistence
// failure propagates to the caller after the cancellation has run.
func (tm *TaskManager) Stop(id string) (bool, error) {
	tm.mu.Lock()
	task := tm.tasks[id]
	if task == nil || task.Status != "running" {
		tm.mu.Unlock()
		return false, nil
	}
	task.Status = "cancelled"
	task.Output = "Stopped by user"
	cancel := task.cancel
	err := tm.persist(task)
	tm.mu.Unlock()
	if cancel != nil {
		func() { defer func() { recover() }(); cancel() }()
	}
	tm.emit()
	if err != nil {
		return true, err
	}
	return true, nil
}
func (tm *TaskManager) StopAndWait(ctx context.Context, id string) (bool, error) {
	task := tm.Get(id)
	if task == nil {
		return false, nil
	}
	stopped, err := tm.Stop(id)
	if err != nil {
		return stopped, err
	}
	select {
	case <-task.Done:
		return stopped, nil
	case <-ctx.Done():
		return stopped, ctx.Err()
	}
}
func (tm *TaskManager) StopAll(ctx context.Context) error {
	for {
		tm.mu.Lock()
		var pending []*managedTask
		for _, task := range tm.tasks {
			if task.pending {
				pending = append(pending, task)
			}
		}
		tm.mu.Unlock()
		if len(pending) == 0 {
			return nil
		}
		for _, task := range pending {
			// The reference stopAll lets a stop() persistence failure
			// propagate immediately, abandoning the remaining stops.
			if _, err := tm.Stop(task.ID); err != nil {
				return err
			}
		}
		for _, task := range pending {
			select {
			case <-task.done:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
}
func (tm *TaskManager) WaitAll(ctx context.Context, filter func(tools.BackgroundTask) bool) error {
	for {
		tm.mu.Lock()
		var pending []*managedTask
		for _, task := range tm.tasks {
			if task.pending && (filter == nil || filter(task.BackgroundTask)) {
				pending = append(pending, task)
			}
		}
		tm.mu.Unlock()
		if len(pending) == 0 {
			return nil
		}
		for _, task := range pending {
			select {
			case <-task.done:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
}
func (tm *TaskManager) Wait(ctx context.Context, id string, timeout time.Duration) (*tools.BackgroundTask, bool, error) {
	if timeout < 0 || timeout > 60*time.Second {
		return nil, false, errors.New("Task wait timeout must be between 0 and 60000ms")
	}
	if ctx.Err() != nil {
		return nil, false, ctx.Err()
	}
	task := tm.Get(id)
	if task == nil {
		return nil, false, nil
	}
	select {
	case <-task.Done:
		return tm.Get(id), false, nil
	default:
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-task.Done:
		return tm.Get(id), false, nil
	case <-timer.C:
		return tm.Get(id), true, nil
	case <-ctx.Done():
		return nil, false, ctx.Err()
	}
}
func (tm *TaskManager) HasNotifications() bool {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	for _, task := range tm.tasks {
		if task.Status != "running" && !task.pending && !task.notified {
			return true
		}
	}
	return false
}

// DrainNotifications returns the tasks completed since the last drain. Like
// the reference, a persistence failure propagates to the caller.
func (tm *TaskManager) DrainNotifications() ([]tools.BackgroundTask, error) {
	tm.mu.Lock()
	var out []tools.BackgroundTask
	for _, id := range tm.order {
		task := tm.tasks[id]
		if task != nil && task.Status != "running" && !task.pending && !task.notified {
			task.notified = true
			if err := tm.persist(task); err != nil {
				tm.mu.Unlock()
				return nil, err
			}
			out = append(out, task.BackgroundTask)
		}
	}
	tm.prune()
	tm.mu.Unlock()
	return out, nil
}
func (tm *TaskManager) prune() {
	finished := 0
	for _, task := range tm.tasks {
		if task.Status != "running" && !task.pending && task.notified {
			finished++
		}
	}
	if excess := finished - 200; excess > 0 {
		var keep []string
		for _, id := range tm.order {
			task := tm.tasks[id]
			if excess > 0 && task.Status != "running" && !task.pending && task.notified {
				delete(tm.tasks, id)
				excess--
			} else {
				keep = append(keep, id)
			}
		}
		tm.order = keep
	}
}
func (tm *TaskManager) Clear() error {
	tm.mu.Lock()
	for _, task := range tm.tasks {
		if task.pending {
			tm.mu.Unlock()
			return errors.New("Stop and await tasks before clearing their manager")
		}
	}
	tm.tasks = make(map[string]*managedTask)
	tm.order = nil
	tm.mu.Unlock()
	tm.emit()
	return nil
}
