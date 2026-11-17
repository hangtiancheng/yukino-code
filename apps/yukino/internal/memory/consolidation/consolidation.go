package consolidation

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/logger"
	"github.com/yukino-js/yukino/yukino/internal/memory"
	"github.com/yukino-js/yukino/yukino/internal/session"
	"github.com/yukino-js/yukino/yukino/internal/storage"
)

var log = logger.CreateChildLogger("memory")

// Consolidator implements background memory consolidation. Once both the time
// gate (>=24h since the last pass) and the session gate (>=5 sessions modified
// since then) are satisfied, it forks a subagent to consolidate memories.
type Consolidator struct {
	client       llm.Client
	cwd          string
	lastScanAt   int64
	minHours     int
	minSessions  int
	appendSystem func(string)

	mu         sync.Mutex
	cancel     context.CancelFunc
	completion chan struct{}
	disposed   bool
}

type Options struct {
	MinHours     int
	MinSessions  int
	AppendSystem func(string)
}

func New(client llm.Client, cwd string, opts Options) *Consolidator {
	minHours := opts.MinHours
	if minHours == 0 {
		minHours = memory.DefaultMinHours
	}
	minSessions := opts.MinSessions
	if minSessions == 0 {
		minSessions = memory.DefaultMinSessions
	}
	return &Consolidator{client: client, cwd: cwd, minHours: minHours, minSessions: minSessions, appendSystem: opts.AppendSystem}
}

func (c *Consolidator) MaybeRun(ctx context.Context) {
	if c == nil {
		return
	}
	c.mu.Lock()
	disposed := c.disposed
	c.mu.Unlock()
	if disposed {
		return
	}
	memDir := memory.GetAutoMemPath(c.cwd)
	if memDir == "" {
		return
	}
	if info, err := os.Stat(memDir); err != nil || !info.IsDir() {
		return
	}
	lastAt := readLastConsolidatedAt(memDir)
	hoursSince := float64(time.Now().UnixMilli()-lastAt) / float64(memory.MillisecondsPerHour)
	if hoursSince < float64(c.minHours) {
		return
	}
	now := time.Now().UnixMilli()
	if now-c.lastScanAt < memory.ScanThrottleMS {
		return
	}
	c.lastScanAt = now

	sessionIDs := listSessionsSince(c.cwd, lastAt)
	if len(sessionIDs) < c.minSessions {
		return
	}

	releaseLock, err := storage.TryAcquireFileSyncLock(filepath.Join(memDir, memory.RunningLockFile))
	if err != nil || releaseLock == nil {
		return
	}

	c.mu.Lock()
	if c.disposed || c.cancel != nil {
		c.mu.Unlock()
		_ = releaseLock()
		return
	}
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	c.cancel = cancel
	c.completion = done
	c.mu.Unlock()

	go func() {
		defer close(done)
		defer func() {
			if err := releaseLock(); err != nil {
				log.Error(map[string]any{"err": err}, "failed to release consolidation lock")
			}
		}()
		c.mu.Lock()
		disposed := c.disposed
		c.mu.Unlock()
		if err := c.run(runCtx, memDir, sessionIDs); err != nil {
			log.Error(map[string]any{"err": err}, "memory consolidation failed")
			return
		}
		if !disposed {
			markConsolidationSucceeded(memDir)
		}
	}()
}

// Dispose stops any in-flight consolidation and awaits its settlement.
func (c *Consolidator) Dispose() {
	c.mu.Lock()
	c.disposed = true
	cancel := c.cancel
	completion := c.completion
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if completion != nil {
		<-completion
	}
}

func (c *Consolidator) run(ctx context.Context, memDir string, sessionIDs []string) error {
	transcriptDir, err := storage.GetSessionsDir(c.cwd)
	if err != nil {
		return err
	}
	prompt := memory.BuildConsolidationPrompt(memDir, memory.GetUserAutoMemPath(), transcriptDir, sessionIDs)

	subRegistry := memory.NewTaskToolRegistry()
	subChecker := memory.NewMemoryPermissionChecker(c.cwd, true)

	conv := conversation.NewManager()
	conv.AddUserMessage(prompt)

	subagent := agent.New(c.client, subRegistry, protocolOf(c.client))
	subagent.MaxIterations = memory.ConsolidationMaxIterations
	subagent.Checker = subChecker
	subagent.WorkDir = c.cwd

	for event := range subagent.Run(ctx, conv) {
		if ev, ok := event.(agent.ErrorEvent); ok {
			return errors.New(ev.Message)
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	writtenPaths := memory.ExtractWrittenPaths(conv.GetMessages())
	var memoryPaths []string
	for _, path := range writtenPaths {
		if filepath.Base(path) != memory.MemoryIndexName {
			memoryPaths = append(memoryPaths, path)
		}
	}
	if len(memoryPaths) > 0 && c.appendSystem != nil {
		names := make([]string, 0, len(memoryPaths))
		for _, path := range memoryPaths {
			names = append(names, filepath.Base(path))
		}
		c.appendSystem(memory.BuildMemoryImprovedReminder(names))
	}
	return nil
}

func readLastConsolidatedAt(memDir string) int64 {
	info, err := os.Stat(filepath.Join(memDir, memory.LockFile))
	if err != nil {
		return 0
	}
	return info.ModTime().UnixMilli()
}

func markConsolidationSucceeded(memDir string) {
	if err := storage.WritePrivateFileSync(filepath.Join(memDir, memory.LockFile), nil, os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
		log.Error(map[string]any{"err": err}, "failed to update consolidation timestamp")
	}
}

func listSessionsSince(cwd string, sinceMs int64) []string {
	sessions := session.ListSessions(cwd)
	since := time.UnixMilli(sinceMs)
	var ids []string
	for _, s := range sessions {
		if s.ModTime.After(since) {
			ids = append(ids, s.ID)
		}
	}
	return ids
}

func protocolOf(client llm.Client) string {
	if provider, ok := client.(interface{ Protocol() string }); ok {
		return provider.Protocol()
	}
	return "anthropic"
}
