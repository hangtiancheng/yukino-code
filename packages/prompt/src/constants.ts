export const TOOL_GUIDANCE_MARKER = "# Active tool guidance";
export const DEFERRED_GUIDANCE_MARKER = "# Deferred tool guidance";

// Bounded, shell-free Git probing: a hanging git (networked worktree, lock)
// must not stall prompt construction, so the probe degrades to "no git info".
export const GIT_PROBE_TIMEOUT_MS = 1500;
export const GIT_BRANCH_MAX_LENGTH = 256;

/** Re-inject the full text every few turns to prevent complete drift in long conversations. */
export const REMINDER_INTERVAL = 5;
