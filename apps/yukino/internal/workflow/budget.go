package workflow

import (
	"math"
	"sync"
)

// BudgetExhaustedError is raised when the workflow token budget is exhausted.
type BudgetExhaustedError struct{}

func (e *BudgetExhaustedError) Error() string {
	return "workflow token budget exhausted (budget.total reached the cap)"
}

// Budget tracks output-token accounting for a workflow run.
type Budget struct {
	Total *int

	mu          sync.Mutex
	spentTokens int
}

func NewBudget(total *int) *Budget { return &Budget{Total: total} }

func (b *Budget) Spent() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.spentTokens
}

func (b *Budget) Remaining() float64 {
	if b.Total == nil {
		return math.Inf(1)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	remaining := *b.Total - b.spentTokens
	if remaining < 0 {
		return 0
	}
	return float64(remaining)
}

func (b *Budget) AddOutputTokens(n int) {
	if n > 0 {
		b.mu.Lock()
		b.spentTokens += n
		b.mu.Unlock()
	}
}

func (b *Budget) AssertCanSpend() error {
	if b.Total == nil {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.spentTokens >= *b.Total {
		return &BudgetExhaustedError{}
	}
	return nil
}
