package workflow

import (
	"context"
	"fmt"
	"strings"
)

// AgentAdapterCapabilities declares what an adapter supports.
type AgentAdapterCapabilities struct {
	StructuredOutput bool
	Tools            bool
	Stream           bool
}

// AgentAdapterContext carries the per-call execution context.
type AgentAdapterContext struct {
	Host       *HostHandle
	Ctx        context.Context
	RunID      string
	AgentID    int
	OnProgress func(update AgentProgressUpdate)
}

// AgentAdapter runs one workflow agent call.
type AgentAdapter interface {
	ID() string
	Capabilities() AgentAdapterCapabilities
	Run(params *AgentRunParams, ctx *AgentAdapterContext) (AgentRunResult, error)
	Initialize() error
	Dispose() error
}

// AdapterRouteRule routes params to an adapter.
type AdapterRouteRule struct {
	Kind      string // "agentType" | "model" | "custom"
	AgentType string
	Pattern   string
	Match     func(params *AgentRunParams) bool
	Adapter   string
}

// AdapterNotFoundError marks an unmatched agent call.
type AdapterNotFoundError struct{ Message string }

func (e *AdapterNotFoundError) Error() string { return e.Message }

// AgentAdapterRegistry registers adapters and routes agent calls.
type AgentAdapterRegistry struct {
	adapters map[string]AgentAdapter
	rules    []AdapterRouteRule
	order    []string
	default_ string
}

func NewAgentAdapterRegistry() *AgentAdapterRegistry {
	return &AgentAdapterRegistry{adapters: map[string]AgentAdapter{}}
}

func (r *AgentAdapterRegistry) Register(adapter AgentAdapter) *AgentAdapterRegistry {
	if _, ok := r.adapters[adapter.ID()]; !ok {
		r.order = append(r.order, adapter.ID())
	}
	r.adapters[adapter.ID()] = adapter
	return r
}

func (r *AgentAdapterRegistry) Default(adapterID string) *AgentAdapterRegistry {
	r.default_ = adapterID
	return r
}

func (r *AgentAdapterRegistry) Route(rule AdapterRouteRule) *AgentAdapterRegistry {
	r.rules = append(r.rules, rule)
	return r
}

func (r *AgentAdapterRegistry) Has(id string) bool {
	_, ok := r.adapters[id]
	return ok
}

func (r *AgentAdapterRegistry) Get(id string) AgentAdapter {
	return r.adapters[id]
}

// Resolve picks the adapter for params: first matching rule, then the
// default, otherwise an AdapterNotFoundError.
func (r *AgentAdapterRegistry) Resolve(params *AgentRunParams) (AgentAdapter, error) {
	for _, rule := range r.rules {
		if matchRule(rule, params) {
			if hit, ok := r.adapters[rule.Adapter]; ok {
				return hit, nil
			}
		}
	}
	if r.default_ != "" {
		if fallback, ok := r.adapters[r.default_]; ok {
			return fallback, nil
		}
	}
	return nil, &AdapterNotFoundError{Message: fmt.Sprintf("No adapter matched (rules=%d, default=%s)", len(r.rules), orNone(r.default_))}
}

func (r *AgentAdapterRegistry) InitializeAll() error {
	for _, id := range r.order {
		if err := r.adapters[id].Initialize(); err != nil {
			return err
		}
	}
	return nil
}

func (r *AgentAdapterRegistry) DisposeAll() error {
	var first error
	for _, id := range r.order {
		if err := r.adapters[id].Dispose(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func orNone(value string) string {
	if value == "" {
		return "none"
	}
	return value
}

func matchRule(rule AdapterRouteRule, params *AgentRunParams) bool {
	switch rule.Kind {
	case "agentType":
		return params.AgentType == rule.AgentType
	case "model":
		return params.Model != "" && strings.HasPrefix(params.Model, rule.Pattern)
	default:
		return rule.Match != nil && rule.Match(params)
	}
}
