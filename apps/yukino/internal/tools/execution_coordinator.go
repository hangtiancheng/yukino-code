package tools

import (
	"context"
	"os"
	"sync"

	"github.com/yukino-js/yukino/yukino/internal/file_history"
	"github.com/yukino-js/yukino/yukino/internal/plan_file"
	"github.com/yukino-js/yukino/yukino/internal/utils"
	"github.com/yukino-js/yukino/yukino/internal/worktree"
)

type executionContextKey struct{}

type PlanContext struct {
	Owner         plan_file.Owner
	IsPlanMode    func() bool
	EnterPlanMode func()
	IsSubagent    bool
	IsTeammate    bool
}

type PermissionRequest struct {
	ToolName         string
	Desc             string
	AgentName        string
	Cwd              string
	ToolCallID       string
	Args             map[string]any
	RememberPatterns []string
}

type PermissionHandler func(context.Context, PermissionRequest) int

type ExecutionContext struct {
	Worktrees             WorktreeRuntime
	RequestPermission     PermissionHandler
	Plan                  *PlanContext
	FileStateCache        *FileStateCache
	FileHistory           *file_history.History
	IsAgentRuntime        bool
	SessionID             string
	ToolCallID            string
	TaskManager           BackgroundTaskManager
	DisableBackground     bool
	ShellTimeoutDisabled  bool
	OnOutput              func(string)
	WorkDir               string
	CanReadSearchPath     func(string) bool
	CanTraverseSearchPath func(string) bool
	CheckPermission       func(string, map[string]any) *ToolResult
}

type WorktreeRuntime interface {
	WorktreeSession() *worktree.WorktreeSession
	EnterWorktree(context.Context, worktree.WorktreeResult, string) error
	LeaveWorktree()
	RemoveWorktree(context.Context, string, bool) (*worktree.ChangeSummary, error)
	SandboxWriteRoots([]string) []string
	SandboxTempDirectory() string
}

func PlanningContext(ctx context.Context) *PlanContext {
	execution, _ := ctx.Value(executionContextKey{}).(ExecutionContext)
	return execution.Plan
}

func WithExecutionContext(ctx context.Context, execution ExecutionContext) context.Context {
	return context.WithValue(ctx, executionContextKey{}, execution)
}

func workingDirectory(ctx context.Context) string {
	if execution, ok := ctx.Value(executionContextKey{}).(ExecutionContext); ok && execution.WorkDir != "" {
		return execution.WorkDir
	}
	cwd, _ := os.Getwd()
	return cwd
}

func toolPath(ctx context.Context, path string) string {
	return utils.ResolveToolPath(workingDirectory(ctx), path)
}

type mutationWaiter struct {
	ready chan struct{}
}

type mutationQueue struct {
	mu     sync.Mutex
	queues map[string][]*mutationWaiter
}

var workspaceMutations = mutationQueue{queues: make(map[string][]*mutationWaiter)}
var fileMutations = mutationQueue{queues: make(map[string][]*mutationWaiter)}

func (q *mutationQueue) acquire(ctx context.Context, key string) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	q.mu.Lock()
	waiter := &mutationWaiter{ready: make(chan struct{})}
	queue := q.queues[key]
	q.queues[key] = append(queue, waiter)
	if len(queue) == 0 {
		close(waiter.ready)
	}
	q.mu.Unlock()
	var once sync.Once
	release := func() {
		once.Do(func() {
			q.mu.Lock()
			defer q.mu.Unlock()
			queue := q.queues[key]
			for i, pending := range queue {
				if pending != waiter {
					continue
				}
				queue = append(queue[:i], queue[i+1:]...)
				if len(queue) == 0 {
					delete(q.queues, key)
				} else {
					q.queues[key] = queue
					if i == 0 {
						close(queue[0].ready)
					}
				}
				break
			}
		})
	}
	select {
	case <-ctx.Done():
		release()
		return nil, ctx.Err()
	case <-waiter.ready:
		if err := ctx.Err(); err != nil {
			release()
			return nil, err
		}
		return release, nil
	}
}

func AcquireWorkspaceMutation(ctx context.Context, cwd string) (func(), error) {
	key, err := utils.CanonicalPath(cwd, 0)
	if err != nil {
		return nil, err
	}
	return workspaceMutations.acquire(ctx, key)
}

func checkExecutionPermission(ctx context.Context, name string, args map[string]any) *ToolResult {
	if execution, ok := ctx.Value(executionContextKey{}).(ExecutionContext); ok && execution.CheckPermission != nil {
		return execution.CheckPermission(name, args)
	}
	return nil
}

func withFileMutation(ctx context.Context, name string, args map[string]any, path string, run func() ToolResult) ToolResult {
	release, err := AcquireWorkspaceMutation(ctx, workingDirectory(ctx))
	if err != nil {
		return ToolResult{Output: OperationInterruptedError, IsError: true}
	}
	defer release()
	if blocked := checkExecutionPermission(ctx, name, args); blocked != nil {
		return *blocked
	}
	releaseFile, err := fileMutations.acquire(ctx, normalizePath(path))
	if err != nil {
		return ToolResult{Output: OperationInterruptedError, IsError: true}
	}
	defer releaseFile()
	return run()
}

func fileCacheForContext(ctx context.Context, fallback *FileStateCache) *FileStateCache {
	if execution, ok := ctx.Value(executionContextKey{}).(ExecutionContext); ok && execution.IsAgentRuntime {
		return execution.FileStateCache
	}
	return fallback
}
func fileHistoryForContext(ctx context.Context, fallback *file_history.History) *file_history.History {
	if execution, ok := ctx.Value(executionContextKey{}).(ExecutionContext); ok && execution.IsAgentRuntime {
		return execution.FileHistory
	}
	return fallback
}

func RuntimeContext(ctx context.Context) (ExecutionContext, bool) {
	value, ok := ctx.Value(executionContextKey{}).(ExecutionContext)
	return value, ok
}
