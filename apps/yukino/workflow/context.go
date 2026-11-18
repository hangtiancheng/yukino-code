package workflow

import (
	"context"
	"sync"
)

// SharedResources are the per-run concurrency and accounting primitives.
type SharedResources struct {
	Semaphore  *Semaphore
	Budget     *Budget
	AgentIDSeq int
}

// EngineContext is the mutable state of one workflow execution. Fields
// guarded by Mu are shared between the VM loop and agent workers.
type EngineContext struct {
	Ports        WorkflowPorts
	Host         *HostHandle
	Ctx          context.Context
	RunID        string
	WorkflowName string
	Cwd          string
	Resources    *SharedResources
	InFlight     *InFlightTracker

	Mu                 sync.Mutex
	Journal            []JournalEntry
	JournalInvalidated bool
	CurrentPhase       string
}

// InFlightTracker counts outstanding agent/sub-workflow promises and signals
// when the count reaches zero.
type InFlightTracker struct {
	mu     sync.Mutex
	count  int
	notify chan struct{}
}

func NewInFlightTracker() *InFlightTracker {
	return &InFlightTracker{notify: make(chan struct{}, 1)}
}

func (t *InFlightTracker) Add() {
	t.mu.Lock()
	t.count++
	t.mu.Unlock()
}

func (t *InFlightTracker) Done() {
	t.mu.Lock()
	t.count--
	empty := t.count == 0
	t.mu.Unlock()
	if empty {
		select {
		case t.notify <- struct{}{}:
		default:
		}
	}
}

func (t *InFlightTracker) Count() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.count
}

func (t *InFlightTracker) Notify() <-chan struct{} { return t.notify }

func CreateSharedResources(budgetTotal *int, maxConcurrency *int) *SharedResources {
	return &SharedResources{
		Semaphore: NewSemaphore(ClampMaxConcurrency(maxConcurrency)),
		Budget:    NewBudget(budgetTotal),
	}
}

// EngineContextOptions builds an EngineContext.
type EngineContextOptions struct {
	Ports          WorkflowPorts
	Host           *HostHandle
	Ctx            context.Context
	RunID          string
	WorkflowName   string
	Cwd            string
	BudgetTotal    *int
	MaxConcurrency *int
	Journal        []JournalEntry
}

func CreateEngineContext(opts EngineContextOptions) *EngineContext {
	journal := make([]JournalEntry, len(opts.Journal))
	copy(journal, opts.Journal)
	return &EngineContext{
		Ports:        opts.Ports,
		Host:         opts.Host,
		Ctx:          opts.Ctx,
		RunID:        opts.RunID,
		WorkflowName: opts.WorkflowName,
		Cwd:          opts.Cwd,
		Resources:    CreateSharedResources(opts.BudgetTotal, opts.MaxConcurrency),
		InFlight:     NewInFlightTracker(),
		Journal:      journal,
	}
}
