package tools

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
)

type Registry struct {
	mu               sync.RWMutex
	tools            map[string]Tool
	order            []string
	owned            map[Tool]bool
	discoveredTools  map[string]bool
	cleanup          []func() error
	disposed         bool
	disposal         chan struct{}
	disposalError    error
	McpLoadingMode   McpLoadingMode
	ExposeToolSearch bool
	ExposeMcpCall    bool
}

func NewRegistry() *Registry {
	return &Registry{tools: map[string]Tool{}, owned: map[Tool]bool{}, discoveredTools: map[string]bool{}, McpLoadingMode: McpLoadingEager}
}
func (r *Registry) MarkDiscovered(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.discoveredTools[name] = true
}
func (r *Registry) IsDiscovered(name string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.discoveredTools[name]
}
func (r *Registry) Register(t Tool)         { r.register(t, true) }
func (r *Registry) RegisterBorrowed(t Tool) { r.register(t, false) }
func (r *Registry) register(t Tool, owned bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.disposed {
		panic("Cannot register tools on a disposed registry")
	}
	if _, exists := r.tools[t.Name()]; !exists {
		r.order = append(r.order, t.Name())
	}
	r.tools[t.Name()] = t
	if owned {
		r.owned[t] = true
	}
}
func (r *Registry) Unregister(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.tools, name)
	delete(r.discoveredTools, name)
	for i, key := range r.order {
		if key == name {
			r.order = append(r.order[:i], r.order[i+1:]...)
			break
		}
	}
}
func (r *Registry) Get(name string) Tool { r.mu.RLock(); defer r.mu.RUnlock(); return r.tools[name] }
func (r *Registry) ListTools() []Tool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Tool, 0, len(r.order))
	for _, name := range r.order {
		out = append(out, r.tools[name])
	}
	return out
}
func (r *Registry) CopyLoadingStateFrom(source *Registry) {
	source.mu.RLock()
	mode, search, call := source.McpLoadingMode, source.ExposeToolSearch, source.ExposeMcpCall
	discovered := make(map[string]bool, len(source.discoveredTools))
	for name, value := range source.discoveredTools {
		discovered[name] = value
	}
	source.mu.RUnlock()
	r.mu.Lock()
	r.McpLoadingMode = mode
	r.ExposeToolSearch = search
	r.ExposeMcpCall = call
	r.discoveredTools = discovered
	r.mu.Unlock()
}
func (r *Registry) TakeOwnershipFrom(source *Registry) {
	r.mu.RLock()
	disposed := r.disposed
	r.mu.RUnlock()
	source.mu.RLock()
	sourceDisposed := source.disposed
	source.mu.RUnlock()
	if disposed || sourceDisposed {
		panic("Cannot transfer tools from or to a disposed registry")
	}
	for _, tool := range r.ListTools() {
		source.mu.Lock()
		if source.disposed {
			source.mu.Unlock()
			panic("Cannot transfer tools from or to a disposed registry")
		}
		owned := source.owned[tool]
		delete(source.owned, tool)
		source.mu.Unlock()
		r.mu.Lock()
		if r.disposed {
			r.mu.Unlock()
			panic("Cannot transfer tools from or to a disposed registry")
		}
		if owned {
			r.owned[tool] = true
		}
		r.mu.Unlock()
	}
}
func (r *Registry) AddCleanup(cleanup func() error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.disposed {
		panic("Cannot add cleanup to a disposed registry")
	}
	r.cleanup = append(r.cleanup, cleanup)
}
func (r *Registry) Dispose() error {
	r.mu.Lock()
	if r.disposal != nil {
		done := r.disposal
		r.mu.Unlock()
		<-done
		return r.disposalError
	}
	r.disposed = true
	r.disposal = make(chan struct{})
	done := r.disposal
	cleanup := append([]func() error(nil), r.cleanup...)
	for tool := range r.owned {
		if disposable, ok := tool.(interface{ Dispose() error }); ok {
			cleanup = append(cleanup, disposable.Dispose)
		}
	}
	r.mu.Unlock()
	var wg sync.WaitGroup
	errs := make(chan error, len(cleanup))
	for _, fn := range cleanup {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				if failure := recover(); failure != nil {
					errs <- fmt.Errorf("%v", failure)
				}
			}()
			if err := fn(); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	var failures []error
	for err := range errs {
		failures = append(failures, err)
	}
	r.mu.Lock()
	clear(r.tools)
	clear(r.owned)
	clear(r.discoveredTools)
	r.order = nil
	r.cleanup = nil
	r.disposalError = errors.Join(failures...)
	close(done)
	r.mu.Unlock()
	return r.disposalError
}
func isDeferred(t Tool) bool {
	if deferred, ok := t.(DeferrableTool); ok {
		return deferred.ShouldDefer()
	}
	return false
}
func isOpenAIProtocol(protocol string) bool {
	return protocol == "openai" || protocol == "openai-compat"
}
func SchemaName(schema map[string]any) string {
	if function, ok := schema["function"].(map[string]any); ok {
		name, _ := function["name"].(string)
		return name
	}
	name, _ := schema["name"].(string)
	return name
}
func providerSchema(base map[string]any, protocol string, deferred bool) map[string]any {
	strict, _ := base["strict"].(bool)
	switch protocol {
	case "openai":
		return map[string]any{"type": "function", "name": base["name"], "description": base["description"], "parameters": base["input_schema"], "strict": strict}
	case "openai-compat":
		return map[string]any{"type": "function", "function": map[string]any{"name": base["name"], "description": base["description"], "parameters": base["input_schema"], "strict": strict}}
	default:
		out := make(map[string]any, len(base)+2)
		for key, value := range base {
			out[key] = value
		}
		out["type"] = "custom"
		if deferred {
			out["defer_loading"] = true
		}
		return out
	}
}
func (r *Registry) visibleTools(protocol string, filter func(string) bool) []Tool {
	r.mu.RLock()
	native := r.McpLoadingMode == McpLoadingNative && !isOpenAIProtocol(protocol)
	search, call := r.ExposeToolSearch, r.ExposeMcpCall
	discovered := make(map[string]bool, len(r.discoveredTools))
	for name, value := range r.discoveredTools {
		discovered[name] = value
	}
	r.mu.RUnlock()
	var out []Tool
	for _, tool := range r.ListTools() {
		name := tool.Name()
		if filter != nil && !filter(name) || name == ToolSearchToolName && !search || name == McpCallToolName && !call {
			continue
		}
		if isDeferred(tool) && !discovered[name] && !native {
			continue
		}
		out = append(out, tool)
	}
	return out
}
func (r *Registry) GetAllSchemas(protocol string) []map[string]any {
	return r.FilteredSchemas(protocol, nil)
}

func (r *Registry) FilteredSchemas(protocol string, filter func(string) bool) []map[string]any {
	schemas := make([]map[string]any, 0)
	for _, tool := range r.visibleTools(protocol, filter) {
		schemas = append(schemas, providerSchema(tool.Schema(), protocol, isDeferred(tool) && !r.IsDiscovered(tool.Name())))
	}
	return schemas
}
func (r *Registry) ListVisibleToolNames(protocol string, filter func(string) bool) []string {
	var names []string
	for _, tool := range r.visibleTools(protocol, filter) {
		names = append(names, tool.Name())
	}
	return names
}
func (r *Registry) GetDeferredTools() []Tool {
	var out []Tool
	for _, tool := range r.ListTools() {
		if isDeferred(tool) && !r.IsDiscovered(tool.Name()) {
			out = append(out, tool)
		}
	}
	return out
}
func (r *Registry) GetDeferredToolNames() []string {
	var names []string
	for _, tool := range r.GetDeferredTools() {
		names = append(names, tool.Name())
	}
	sort.Strings(names)
	return names
}
func (r *Registry) SearchDeferred(query string, maxResults int) []Tool {
	query = strings.ToLower(query)
	var out []Tool
	for _, tool := range r.GetDeferredTools() {
		if strings.Contains(strings.ToLower(tool.Name()), query) || strings.Contains(strings.ToLower(tool.Description()), query) {
			out = append(out, tool)
			if len(out) >= maxResults {
				break
			}
		}
	}
	return out
}
func (r *Registry) FindDeferredByNames(names []string) []Tool {
	byName := map[string]Tool{}
	for _, tool := range r.ListTools() {
		byName[strings.ToLower(tool.Name())] = tool
	}
	var out []Tool
	for _, name := range names {
		if tool := byName[strings.ToLower(name)]; tool != nil && isDeferred(tool) {
			out = append(out, tool)
		}
	}
	return out
}
