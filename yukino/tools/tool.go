// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package tools

import (
	"context"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf16"

	"github.com/hangtiancheng/yukino-code/yukino/file_history"
)

// SkipDirs mirrors the TS SKIP_DIRS set: noisy build/VCS/dependency directories
// pruned from Glob/Grep walks at any depth.
var SkipDirs = map[string]bool{
	".agents": true, ".git": true, ".yukino": true, ".next": true,
	".venv": true, ".mypy_cache": true, "__pycache__": true,
	"dist": true, "node_modules": true,
}

// MaxOutputChars is the spill threshold applied before a single tool result
// enters the conversation history: content exceeding this character count is
// written to disk, leaving only a preview and the file path in history. Set
// to 50000 rather than a smaller value so the model can see enough content
// in one pass without needing an extra ReadFile round-trip.
const MaxOutputChars = 50000

type ToolResult struct {
	Output  string
	IsError bool
	// ContentBlocks carries structured content blocks instead of plain text
	// for tool results. Currently only ToolSearch on the official Anthropic
	// endpoint uses this: it returns tool_reference blocks that the server
	// expands into context. When this field is populated, Output still holds
	// the equivalent text for TUI and log display.
	ContentBlocks []map[string]any
}

// McpLoadingMode determines how MCP tools enter the context. It is written to
// the Registry by internal/mcp after connecting to servers. It lives here
// rather than in internal/mcp because Registry holds it, and internal/mcp
// depends on internal/tools — a reverse reference would create a cycle.
type McpLoadingMode string

const (
	// McpLoadingEager: total schema size is under 10% of context; load all
	// tools into tools[] with no deferral.
	McpLoadingEager McpLoadingMode = "eager"
	// McpLoadingNative: official endpoint. Tools stay in tools[] with
	// defer_loading but the server hides them from the model; ToolSearch
	// returns tool_reference so the server expands the schema.
	McpLoadingNative McpLoadingMode = "native"
	// McpLoadingDispatch: other endpoints do not support defer_loading;
	// MCP tools never enter tools[] and calls go through McpCall.
	McpLoadingDispatch McpLoadingMode = "dispatch"
)

// MCPTool exposes additional capabilities of MCP tool wrappers to the dispatch
// and routing logic. A structured interface is used instead of a direct
// reference to internal/mcp, again to avoid a circular dependency.
type MCPTool interface {
	Tool
	MCPServerName() string
	MCPInputSchema() map[string]any
	SetDeferLoading(bool)
}

// ToolSearchToolName is the tool-search tool's name, used when the registry
// filters tools by mode.
const ToolSearchToolName = "ToolSearch"

type ToolCategory string

const (
	CategoryRead    ToolCategory = "read"
	CategoryWrite   ToolCategory = "write"
	CategoryCommand ToolCategory = "command"
)

// workDirKey carries the session working directory into tool execution (TS:
// ToolContext.workDir). It travels through context rather than living on the
// tool struct because forked/sub-agent registries share the parent's tool
// instances while running against a different workDir (e.g. a worktree); a
// per-call value resolves each invocation against the right workspace.
type workDirKey struct{}

// WithWorkDir returns a context carrying the session working directory. The
// agent sets it before calling Execute so every tool resolves relative paths
// against the session's workspace instead of the server process cwd.
func WithWorkDir(ctx context.Context, workDir string) context.Context {
	return context.WithValue(ctx, workDirKey{}, workDir)
}

// WorkDirFromContext returns the session working directory, or "" when absent.
func WorkDirFromContext(ctx context.Context) string {
	if wd, ok := ctx.Value(workDirKey{}).(string); ok {
		return wd
	}
	return ""
}

// sessionIDKey carries the owning session id into tool execution (TS:
// ToolContext.sessionId). Shell tools use it to place their output spill files
// under the session's tool-results directory. It travels through context for
// the same reason workDir does: shared tool instances serve the main agent and
// every subagent run, and each has its own (or no) session.
type sessionIDKey struct{}

// WithSessionID returns a context carrying the session id. The agent attaches
// it to every execution; an empty value is meaningful (subagents run without a
// session, exactly like TS ctx.sessionId === "").
func WithSessionID(ctx context.Context, sessionID string) context.Context {
	return context.WithValue(ctx, sessionIDKey{}, sessionID)
}

// SessionIDFromContext returns the session id and whether the key is present.
// Absent means the caller did not go through an Agent, and tools fall back to
// their instance field.
func SessionIDFromContext(ctx context.Context) (string, bool) {
	id, ok := ctx.Value(sessionIDKey{}).(string)
	return id, ok
}

// toolCallIDKey carries the current tool_use id (TS: ToolContext.toolCallId).
// Background tasks record it as their origin so hosts can attribute task
// notifications back to the spawning call.
type toolCallIDKey struct{}

// WithToolCallID returns a context carrying the id of the tool call being
// executed. The agent sets it per call.
func WithToolCallID(ctx context.Context, toolCallID string) context.Context {
	return context.WithValue(ctx, toolCallIDKey{}, toolCallID)
}

// ToolCallIDFromContext returns the tool call id, or "" when absent.
func ToolCallIDFromContext(ctx context.Context) string {
	if id, ok := ctx.Value(toolCallIDKey{}).(string); ok {
		return id
	}
	return ""
}

// fileStateCacheKey carries the per-run file state cache (TS:
// ToolContext.fileStateCache). A present-but-nil value means "this run has no
// cache" (subagents get a fresh one per run in TS; an absent key falls back to
// the host-wired instance field).
type fileStateCacheKey struct{}

// WithFileStateCache returns a context carrying the run's file state cache.
// Passing nil explicitly disables the cache for the run.
func WithFileStateCache(ctx context.Context, cache *FileStateCache) context.Context {
	return context.WithValue(ctx, fileStateCacheKey{}, cache)
}

// ResolveFileStateCache returns the context-carried cache when the key is
// present (even nil), otherwise the tool instance's fallback.
func ResolveFileStateCache(ctx context.Context, fallback *FileStateCache) *FileStateCache {
	if v, ok := ctx.Value(fileStateCacheKey{}).(*FileStateCache); ok {
		return v
	}
	return fallback
}

// fileHistoryKey carries the run's file history (TS: ToolContext.fileHistory).
// Present-but-nil means the run records no history (subagents in TS run
// without fileHistory); an absent key falls back to the instance field.
type fileHistoryKey struct{}

// WithFileHistory returns a context carrying the run's file history. Passing
// nil explicitly disables history tracking for the run.
func WithFileHistory(ctx context.Context, history *file_history.History) context.Context {
	return context.WithValue(ctx, fileHistoryKey{}, history)
}

// ResolveFileHistory returns the context-carried history when the key is
// present (even nil), otherwise the tool instance's fallback.
func ResolveFileHistory(ctx context.Context, fallback *file_history.History) *file_history.History {
	if v, ok := ctx.Value(fileHistoryKey{}).(*file_history.History); ok {
		return v
	}
	return fallback
}

// PermissionAnswer is the answer to a permission prompt (TS
// onPermissionRequest's "allow" | "deny" | "allowAlways").
type PermissionAnswer string

const (
	PermissionAllow       PermissionAnswer = "allow"
	PermissionDeny        PermissionAnswer = "deny"
	PermissionAllowAlways PermissionAnswer = "allowAlways"
)

// ResolvePath resolves a possibly-relative requested path against workDir,
// mirroring Node's path.resolve(workDir, requestedPath): absolute paths pass
// through (cleaned), relative paths join onto workDir. An empty workDir leaves
// a relative path unchanged so it resolves against the process cwd as before.
func ResolvePath(workDir, requestedPath string) string {
	if requestedPath == "" {
		return workDir
	}
	if filepath.IsAbs(requestedPath) {
		return filepath.Clean(requestedPath)
	}
	if workDir == "" {
		return requestedPath
	}
	return filepath.Join(workDir, requestedPath)
}

type Tool interface {
	Name() string
	Description() string
	Category() ToolCategory
	Schema() map[string]any
	Execute(ctx context.Context, args map[string]any) ToolResult
}

// DeferrableTool lets a tool declare whether it should be lazily loaded.
// Deferred tools do not appear in the initial tool list; the model must first
// use ToolSearch to retrieve the schema before invoking them.
//
// Only MCP tools implement this interface. MCP servers are configured
// per-project and can expose dozens of tools with lengthy schemas; including
// all of them in the initial tool list would consume a large portion of the
// context, and most tools are unused in any given session. Built-in tools are
// a fixed, manageable set — hiding them would only force the model through an
// extra ToolSearch round-trip, so they are never deferred and always expose
// their full schema.
type DeferrableTool interface {
	ShouldDefer() bool
}

// ConcurrencySafeTool lets a tool decide concurrency safety based on the
// actual arguments of a specific invocation.
//
// Tools that do not implement this interface fall back to category-based
// rules: read-only tools may run concurrently; write and command tools may not.
// Currently only Bash implements it, because whether a command is read-only
// depends on the command itself — ls and rm are both Bash but differ entirely
// in concurrency safety.
type ConcurrencySafeTool interface {
	IsConcurrencySafe(args map[string]any) bool
}

// IsConcurrencySafe reports whether a tool invocation can run concurrently
// with other invocations.
//
// If the tool implements ConcurrencySafeTool, its verdict is used; otherwise
// the decision falls back to the tool category.
func IsConcurrencySafe(t Tool, args map[string]any) bool {
	if cs, ok := t.(ConcurrencySafeTool); ok {
		return cs.IsConcurrencySafe(args)
	}
	return t.Category() == CategoryRead
}

type Registry struct {
	tools           map[string]Tool
	discoveredTools map[string]bool
	// order preserves registration order so ListTools is deterministic for
	// the recovery attachment and any model-visible listing. TS's Registry is
	// a Map, whose iteration order is insertion order; Go's map has none.
	order []string
	// McpLoadingMode is written by mcp.DecideAndApply after connecting to
	// servers. Without MCP it stays eager, which is equivalent to no deferral.
	McpLoadingMode McpLoadingMode

	// ExposeToolSearch / ExposeMcpCall control whether these two tools are
	// sent to the model, computed once by mcp.ApplyMode at session start.
	// They are not recomputed each turn based on "are there still deferred
	// tools": tools may be disabled at runtime, and recomputing would remove
	// a tool mid-session — that is an array change that breaks the cache prefix.
	ExposeToolSearch bool
	ExposeMcpCall    bool
}

func NewRegistry() *Registry {
	return &Registry{
		tools:           make(map[string]Tool),
		discoveredTools: make(map[string]bool),
		McpLoadingMode:  McpLoadingEager,
	}
}

func (r *Registry) MarkDiscovered(name string) {
	r.discoveredTools[name] = true
}

func (r *Registry) IsDiscovered(name string) bool {
	return r.discoveredTools[name]
}

func (r *Registry) Register(t Tool) {
	name := t.Name()
	if _, exists := r.tools[name]; !exists {
		r.order = append(r.order, name)
	}
	r.tools[name] = t
}

// Unregister removes a tool by name (TS: registry.unregister). Unknown names
// are a no-op.
func (r *Registry) Unregister(name string) {
	delete(r.tools, name)
	delete(r.discoveredTools, name)
	for i, existing := range r.order {
		if existing == name {
			r.order = append(r.order[:i], r.order[i+1:]...)
			break
		}
	}
}

func (r *Registry) Get(name string) Tool {
	return r.tools[name]
}

// ListTools returns the registered tools in registration order (TS:
// [...tools.values()]).
func (r *Registry) ListTools() []Tool {
	result := make([]Tool, 0, len(r.order))
	for _, name := range r.order {
		if t, ok := r.tools[name]; ok {
			result = append(result, t)
		}
	}
	return result
}

// ToolNames returns the registered tool names in registration order.
func (r *Registry) ToolNames() []string {
	names := make([]string, 0, len(r.order))
	for _, name := range r.order {
		if _, ok := r.tools[name]; ok {
			names = append(names, name)
		}
	}
	return names
}

func isDeferred(t Tool) bool {
	if dt, ok := t.(DeferrableTool); ok {
		return dt.ShouldDefer()
	}
	return false
}

func isOpenAIProtocol(protocol string) bool {
	return protocol == "openai" || protocol == "openai-compat"
}

// GetAllSchemas builds the tool list to send to the model for this turn.
//
// It iterates in registration order, matching TS registry.ts which walks its
// Map in insertion order. Registration order is deterministic because Register
// maintains the order slice, so the serialized tool list is byte-stable across
// turns — the tool list renders after the system prompt and before messages,
// so any order change would invalidate the byte prefix and bust the
// conversation history cache that follows.
func (r *Registry) GetAllSchemas(protocol string) []map[string]any {
	// Official endpoint uses native deferral: tools stay in tools[] with
	// defer_loading and the server decides visibility. This way, even when
	// new tools are discovered, the tools array bytes do not change and the
	// prompt cache prefix is preserved. Other endpoints must hide deferred
	// tools entirely and rely on McpCall.
	native := r.McpLoadingMode == McpLoadingNative && !isOpenAIProtocol(protocol)
	schemas := make([]map[string]any, 0, len(r.tools))
	for _, name := range r.order {
		t, ok := r.tools[name]
		if !ok {
			continue
		}
		// Search and dispatch are only exposed in modes that need them. Under eager there are
		// no deferred tools to search and no dispatch needed; sending both would only waste
		// tokens and might tempt the model into a needless detour.
		if name == ToolSearchToolName && !r.ExposeToolSearch {
			continue
		} else if name == McpCallToolName && !r.ExposeMcpCall {
			continue
		}
		deferred := isDeferred(t) && !r.discoveredTools[name]
		if deferred && !native {
			continue
		}
		base := t.Schema()
		// TS registry.getAllSchemas serializes the two OpenAI protocols into
		// different shapes (registry.ts:129-153): native "openai" (Responses API)
		// is a flat {type,name,description,parameters,strict} function tool, while
		// "openai-compat" (Chat Completions) nests the definition under "function".
		// toOpenAIResponsesTools and toOpenAICompatTools each pass through only
		// their own shape, so flattening both — as an earlier port did — made every
		// openai-compat turn fail with "tool schema serialized for another protocol".
		strict, _ := base["strict"].(bool) // TS: s.strict ?? false
		if protocol == "openai" {
			schemas = append(schemas, map[string]any{
				"strict":      strict,
				"type":        "function",
				"name":        base["name"],
				"description": base["description"],
				"parameters":  base["input_schema"],
			})
		} else if protocol == "openai-compat" {
			schemas = append(schemas, map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        base["name"],
					"description": base["description"],
					"parameters":  base["input_schema"],
					"strict":      strict,
				},
			})
		} else {
			if deferred {
				withFlag := make(map[string]any, len(base)+1)
				for k, v := range base {
					withFlag[k] = v
				}
				withFlag["defer_loading"] = true
				base = withFlag
			}
			schemas = append(schemas, base)
		}
	}
	return schemas
}

// GetDeferredToolNames returns the names of deferred tools not yet discovered,
// in lexicographic order (TS: names.sort(), which compares UTF-16 code units).
// Sorting is not cosmetic: callers detect pool changes by comparing lists, so
// an unstable order would produce different text for the same set of tools.
func (r *Registry) GetDeferredToolNames() []string {
	var names []string
	for _, name := range r.order {
		t, ok := r.tools[name]
		if ok && isDeferred(t) && !r.discoveredTools[name] {
			names = append(names, name)
		}
	}
	sort.Slice(names, func(i, j int) bool {
		return lessUTF16(names[i], names[j])
	})
	return names
}

// lessUTF16 reports whether a sorts before b in UTF-16 code-unit order,
// matching the default comparison of JS Array.prototype.sort(). For ASCII and
// BMP names this equals code-point order; the distinction matters only for
// supplementary-plane characters, which JS compares by their surrogate pairs.
func lessUTF16(a, b string) bool {
	ua := utf16.Encode([]rune(a))
	ub := utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}

// GetDeferredTools returns deferred tools that were not discovered yet (TS:
// getDeferredTools filters `t.deferred && !discovered`).
func (r *Registry) GetDeferredTools() []Tool {
	var result []Tool
	for _, name := range r.order {
		t, ok := r.tools[name]
		if ok && isDeferred(t) && !r.discoveredTools[name] {
			result = append(result, t)
		}
	}
	return result
}

// SearchDeferred returns deferred, not-yet-discovered tools whose name or
// description contains query, in registration order, capped at maxResults
// (TS: searchDeferred walks the Map in insertion order).
func (r *Registry) SearchDeferred(query string, maxResults int, protocol string) []map[string]any {
	query = strings.ToLower(query)
	var matches []map[string]any
	for _, name := range r.order {
		t, ok := r.tools[name]
		if !ok || !isDeferred(t) || r.discoveredTools[name] {
			continue
		}
		if strings.Contains(strings.ToLower(t.Name()), query) || strings.Contains(strings.ToLower(t.Description()), query) {
			base := t.Schema()
			if isOpenAIProtocol(protocol) {
				matches = append(matches, map[string]any{
					"type":        "function",
					"name":        base["name"],
					"description": base["description"],
					"parameters":  base["input_schema"],
				})
			} else {
				matches = append(matches, base)
			}
			if maxResults > 0 && len(matches) >= maxResults {
				break
			}
		}
	}
	return matches
}

// FindDeferredByNames resolves requested tool names case-insensitively and
// keeps only deferred tools, in the order the names were requested (TS:
// findDeferredByNames maps over names and filters `t?.deferred`).
func (r *Registry) FindDeferredByNames(names []string, protocol string) []map[string]any {
	byName := make(map[string]Tool, len(r.tools))
	for name, t := range r.tools {
		byName[strings.ToLower(name)] = t
	}
	var matches []map[string]any
	for _, name := range names {
		t, ok := byName[strings.ToLower(name)]
		if !ok || !isDeferred(t) {
			continue
		}
		base := t.Schema()
		if isOpenAIProtocol(protocol) {
			matches = append(matches, map[string]any{
				"type":        "function",
				"name":        base["name"],
				"description": base["description"],
				"parameters":  base["input_schema"],
			})
		} else {
			matches = append(matches, base)
		}
	}
	return matches
}

type DefaultTools struct {
	Registry       *Registry
	WriteFile      *WriteFileTool
	EditFile       *EditFileTool
	FileStateCache *FileStateCache
}

func CreateDefaultRegistry() *Registry {
	dt := CreateDefaultTools()
	return dt.Registry
}

func CreateDefaultToolsWithWorkDir(workDir string) DefaultTools {
	fsc := NewFileStateCache()
	wf := &WriteFileTool{FileStateCache: fsc}
	ef := &EditFileTool{FileStateCache: fsc}
	reg := NewRegistry()
	reg.Register(&ReadFileTool{FileStateCache: fsc})
	reg.Register(wf)
	reg.Register(ef)
	reg.Register(&BashTool{WorkDir: workDir})
	reg.Register(&GlobTool{})
	reg.Register(&GrepTool{})
	return DefaultTools{Registry: reg, WriteFile: wf, EditFile: ef, FileStateCache: fsc}
}

func CreateDefaultTools() DefaultTools {
	return CreateDefaultToolsWithWorkDir("")
}
