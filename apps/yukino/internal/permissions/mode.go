package permissions

import "sync"

func (c *Checker) CurrentPlanPath() string {
	c.planPathMu.RLock()
	defer c.planPathMu.RUnlock()
	return c.planFilePath
}
func (c *Checker) SetPlanFilePath(path string) {
	c.planPathMu.Lock()
	defer c.planPathMu.Unlock()
	c.planFilePath = path
}

type permissionModeState struct {
	mu     sync.RWMutex
	value  PermissionMode
	events *modeEvents
}
type modeEvents struct {
	mu        sync.Mutex
	next      uint64
	listeners map[uint64]func()
}
type planModeState struct {
	mu       sync.Mutex
	previous PermissionMode
}

func (c *Checker) Mode() PermissionMode {
	if c.ReadOnly {
		return ModePlan
	}
	c.modeState.mu.RLock()
	mode := c.modeState.value
	c.modeState.mu.RUnlock()
	if c.parent == nil {
		if mode == "" {
			return ModeDefault
		}
		return mode
	}
	if c.Teammate && c.RequiresLeaderPlanApproval && mode == ModePlan {
		return ModePlan
	}
	parent := c.parent.Mode()
	if parent == ModeBypass || mode == ModeBypass {
		return ModeBypass
	}
	if parent == ModeAcceptEdits {
		return ModeAcceptEdits
	}
	if mode == "" {
		return ModeDefault
	}
	return mode
}
func (c *Checker) SetMode(mode PermissionMode) {
	c.modeState.mu.RLock()
	unchanged := c.modeState.value == mode
	c.modeState.mu.RUnlock()
	if unchanged {
		return
	}
	if c.Mode() == ModePlan && mode != ModePlan {
		c.planModeState.mu.Lock()
		c.planModeState.previous = ""
		c.planModeState.mu.Unlock()
	}
	c.modeState.mu.Lock()
	c.modeState.value = mode
	c.modeState.mu.Unlock()
	events := c.modeState.events
	events.mu.Lock()
	listeners := make([]func(), 0, len(events.listeners))
	for _, listener := range events.listeners {
		listeners = append(listeners, listener)
	}
	events.mu.Unlock()
	for _, listener := range listeners {
		listener()
	}
}
func (c *Checker) SubscribeMode(listener func()) func() {
	events := c.modeState.events
	events.mu.Lock()
	events.next++
	key := events.next
	events.listeners[key] = listener
	events.mu.Unlock()
	return func() { events.mu.Lock(); delete(events.listeners, key); events.mu.Unlock() }
}

func (c *Checker) IsSubagent() bool { return c.parent != nil }
func (c *Checker) EnterPlanMode() PermissionMode {
	c.planModeState.mu.Lock()
	if c.Mode() == ModePlan {
		previous := c.planModeState.previous
		c.planModeState.mu.Unlock()
		if previous == "" {
			return ModeDefault
		}
		return previous
	}
	previous := c.Mode()
	c.planModeState.previous = previous
	c.planModeState.mu.Unlock()
	c.SetMode(ModePlan)
	return previous
}
func (c *Checker) ExitPlanMode(mode PermissionMode) PermissionMode {
	if mode == "" {
		c.planModeState.mu.Lock()
		mode = c.planModeState.previous
		c.planModeState.mu.Unlock()
	}
	if mode == "" {
		mode = ModeDefault
	}
	c.SetMode(mode)
	return mode
}
func (c *Checker) ForCwd(cwd string) *Checker {
	checker := NewChecker(NewPathSandbox(cwd, true), c.RuleEngine, c.Mode())
	checker.modeState = c.modeState
	checker.planModeState = c.planModeState
	checker.parent = c.parent
	checker.SetPlanFilePath(c.CurrentPlanPath())
	checker.Teammate = c.Teammate
	checker.ReadOnly = c.ReadOnly
	checker.RequiresLeaderPlanApproval = c.RequiresLeaderPlanApproval
	checker.SandboxEnabled = c.SandboxEnabled
	checker.SandboxAutoAllow = c.SandboxAutoAllow
	c.worktreeMu.RLock()
	checker.Worktrees = c.Worktrees
	checker.extraRoots = append([]string(nil), c.extraRoots...)
	checker.isolatedRoot = c.isolatedRoot
	c.worktreeMu.RUnlock()
	root := cwd
	if checker.isolatedRoot != "" {
		root = checker.isolatedRoot
	}
	checker.Sandbox = NewPathSandbox(root, checker.isolatedRoot == "")
	for _, root := range checker.extraRoots {
		checker.Sandbox.AddRoot(root)
	}
	return checker
}
func (c *Checker) ForSubagent(cwd string, mode PermissionMode) *Checker {
	checker := c.ForCwd(cwd)
	checker.parent = c
	checker.modeState = &permissionModeState{value: mode, events: c.modeState.events}
	checker.planModeState = &planModeState{}
	if !c.Teammate {
		checker.SetPlanFilePath("")
	}
	return checker
}
func (c *Checker) CanReadSearchPath(path string) bool {
	if c.SearchReadPolicy != nil {
		return c.SearchReadPolicy(path)
	}
	return true
}
func (c *Checker) CanTraverseSearchPath(path string) bool {
	if c.SearchTraversePolicy != nil {
		return c.SearchTraversePolicy(path)
	}
	return c.CanReadSearchPath(path)
}
