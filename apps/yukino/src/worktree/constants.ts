/**
 * Allowed character set of ref names — excludes whitespace and shell
 * metacharacters. Path traversal is ruled out together with the ".." and
 * leading-slash checks in isSafeRefName.
 */
export const SAFE_REF_RE = /^[a-zA-Z0-9/._+@-]+$/;

/** Full SHA-1 (40 hex) or SHA-256 (64 hex) */
export const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export const SHARED_AGENTS_ENTRIES = ["AGENTS.md", "skills"];

export const WORKTREE_SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const WORKTREE_ALREADY_ACTIVE_ERROR = "Already in a worktree session";
export const WORKTREE_NOT_OWNED_ERROR =
  "Cannot enter a worktree that was not created by this runtime";
export const NO_WORKTREE_SESSION_MESSAGE =
  "No-op: there is no active EnterWorktree session to exit. No filesystem changes were made.";
