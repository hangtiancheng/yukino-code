package workflow

import (
	"context"
	"errors"
	"math"
	"sync"
)

// Semaphore is an abort-aware counting semaphore; release transfers the
// permit directly to the next waiter, mirroring the reference implementation.
type Semaphore struct {
	mu        sync.Mutex
	available int
	waiters   []chan struct{}
}

func NewSemaphore(permits int) *Semaphore {
	return &Semaphore{available: max(1, permits)}
}

// Acquire blocks until a permit is available or ctx is canceled. The returned
// release function returns the permit.
func (s *Semaphore) Acquire(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, errors.New("Semaphore.acquire aborted (signal already aborted)")
	}
	s.mu.Lock()
	if s.available > 0 {
		s.available--
		s.mu.Unlock()
		return func() { s.release() }, nil
	}
	waiter := make(chan struct{})
	s.waiters = append(s.waiters, waiter)
	s.mu.Unlock()

	select {
	case <-waiter:
		return func() { s.release() }, nil
	case <-ctx.Done():
		s.mu.Lock()
		for i, w := range s.waiters {
			if w == waiter {
				s.waiters = append(s.waiters[:i], s.waiters[i+1:]...)
				break
			}
		}
		s.mu.Unlock()
		return nil, errors.New("Semaphore.acquire aborted")
	}
}

func (s *Semaphore) release() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.waiters) > 0 {
		next := s.waiters[0]
		s.waiters = s.waiters[1:]
		close(next) // transfer the permit directly
		return
	}
	s.available++
}

func ClampMaxConcurrency(n *int) int {
	if n == nil || math.IsNaN(float64(*n)) {
		return DefaultMaxConcurrency
	}
	return max(1, min(*n, MaxConcurrencyCap))
}
