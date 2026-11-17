package permissions

import (
	"context"
	"fmt"
	"slices"

	"github.com/yukino-js/yukino/yukino/internal/utils"
	"github.com/yukino-js/yukino/yukino/internal/worktree"
)

func (c *Checker) cwdLocked() string {
	if c.activeWorktree != nil {
		return c.activeWorktree.WorktreePath
	}
	if c.restoredCwd != "" {
		return c.restoredCwd
	}
	return c.projectCwd
}

func (c *Checker) Cwd() string {
	c.worktreeMu.RLock()
	defer c.worktreeMu.RUnlock()
	return c.cwdLocked()
}

func (c *Checker) WorktreeSession() *worktree.WorktreeSession {
	c.worktreeMu.RLock()
	defer c.worktreeMu.RUnlock()
	if c.activeWorktree == nil {
		return nil
	}
	session := *c.activeWorktree
	return &session
}

func (c *Checker) EnterWorktree(ctx context.Context, wt worktree.WorktreeResult, originalCwd string) error {
	c.worktreeMu.Lock()
	defer c.worktreeMu.Unlock()
	if c.activeWorktree != nil {
		return fmt.Errorf("%s", worktree.WorktreeAlreadyActiveError)
	}
	path, err := utils.CanonicalPath(wt.WorktreePath, 0)
	if err != nil {
		return err
	}
	if !wt.Created && !c.enteredWorktrees[path] {
		return fmt.Errorf("%s", worktree.WorktreeNotOwnedError)
	}
	if err := c.registerWorktreeLocked(ctx, wt); err != nil {
		return err
	}
	owned := c.Worktrees.Get(wt.WorktreePath)
	if owned == nil {
		return fmt.Errorf("%s", worktree.WorktreeNotOwnedError)
	}
	if originalCwd == "" {
		originalCwd = c.cwdLocked()
	}
	c.activeWorktree = &worktree.WorktreeSession{WorktreeResult: *owned, OriginalCwd: originalCwd}
	c.enteredWorktrees[path] = true
	return nil
}

func (c *Checker) LeaveWorktree() {
	c.worktreeMu.Lock()
	defer c.worktreeMu.Unlock()
	if c.activeWorktree != nil {
		path := c.activeWorktree.WorktreePath
		c.extraRoots = slices.DeleteFunc(c.extraRoots, func(root string) bool { return root == path })
		c.restoredCwd = c.activeWorktree.OriginalCwd
	}
	c.activeWorktree = nil
	root := c.cwdLocked()
	if c.isolatedRoot != "" {
		root = c.isolatedRoot
	}
	c.Sandbox.reset(root, c.isolatedRoot == "", c.extraRoots)
}

func (c *Checker) AllowExtraRoot(path string) error {
	c.worktreeMu.Lock()
	defer c.worktreeMu.Unlock()
	return c.allowExtraRootLocked(path)
}

func (c *Checker) allowExtraRootLocked(path string) error {
	root, err := utils.CanonicalPath(utils.ResolveToolPath(c.cwdLocked(), path), 0)
	if err != nil {
		return err
	}
	c.extraRoots = append(c.extraRoots, root)
	c.Sandbox.AddRoot(root)
	return nil
}

func (c *Checker) registerWorktreeLocked(ctx context.Context, wt worktree.WorktreeResult) error {
	registered, err := c.Worktrees.Register(ctx, wt)
	if err != nil {
		return err
	}
	if registered {
		return c.allowExtraRootLocked(wt.WorktreePath)
	}
	return nil
}

func (c *Checker) RegisterWorktree(ctx context.Context, wt worktree.WorktreeResult) error {
	c.worktreeMu.Lock()
	defer c.worktreeMu.Unlock()
	return c.registerWorktreeLocked(ctx, wt)
}

func (c *Checker) ForWorktree(ctx context.Context, wt worktree.WorktreeResult) (*Checker, error) {
	checker := c.ForCwd(wt.WorktreePath)
	root, err := utils.CanonicalPath(wt.WorktreePath, 0)
	if err != nil {
		return nil, err
	}
	checker.isolatedRoot = root
	checker.Sandbox = NewPathSandbox(root, false)
	checker.extraRoots = nil
	checker.Worktrees = &worktree.OwnedWorktrees{}
	registered, err := checker.Worktrees.Register(ctx, wt)
	if err != nil {
		return nil, err
	}
	if !registered {
		return nil, fmt.Errorf("%s", IsolatedWorktreeClaimError)
	}
	return checker, nil
}

func (c *Checker) SandboxWriteRoots(fallback []string) []string {
	c.worktreeMu.RLock()
	defer c.worktreeMu.RUnlock()
	roots := append([]string(nil), fallback...)
	if c.isolatedRoot != "" {
		roots = []string{c.isolatedRoot}
	}
	roots = append(roots, c.extraRoots...)
	roots = append(roots, c.Worktrees.SandboxWriteRoots()...)
	unique := roots[:0]
	for _, root := range roots {
		if !slices.Contains(unique, root) {
			unique = append(unique, root)
		}
	}
	return unique
}

func (c *Checker) SandboxTempDirectory() string {
	c.worktreeMu.RLock()
	defer c.worktreeMu.RUnlock()
	if c.isolatedRoot == "" {
		return ""
	}
	return c.Worktrees.TempDirectory(c.isolatedRoot)
}

func (c *Checker) RemoveWorktree(ctx context.Context, path string, discard bool) (*worktree.ChangeSummary, error) {
	return c.Worktrees.Remove(ctx, path, discard)
}

func (s *PathSandbox) reset(cwd string, includeTemp bool, extraRoots []string) {
	next := NewPathSandbox(cwd, includeTemp)
	for _, root := range extraRoots {
		next.AddRoot(root)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.projectDir = next.projectDir
	s.allowedRoots = next.allowedRoots
}
