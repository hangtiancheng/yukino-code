import { AGENTS_FILE_NAME } from "@/memory/constants.js";
import { SKILLS_DIR_NAME } from "@/skills/constants.js";

export const GIT_QUERY_TIMEOUT_MS = 10_000;

export const GIT_DIR_NAME = ".git";
export const WORKTREES_DIR_NAME = "worktrees";

export const REFS_HEADS_PREFIX = "refs/heads/";

export const SHARED_AGENTS_ENTRIES = [AGENTS_FILE_NAME, SKILLS_DIR_NAME];

export const WORKTREE_SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const WORKTREE_ALREADY_ACTIVE_ERROR = "Already in a worktree session";
export const WORKTREE_NOT_OWNED_ERROR =
  "Cannot enter a worktree that was not created by this runtime";
export const NO_WORKTREE_SESSION_MESSAGE =
  "No-op: there is no active EnterWorktree session to exit. No filesystem changes were made.";
