import { COORDINATOR_ALLOWED_TOOLS } from "@/teams/constants.js";

export function isCoordinatorTool(name: string): boolean {
  return COORDINATOR_ALLOWED_TOOLS.has(name);
}

/**
 * Returns the tool-filter predicate for the Leader Agent.
 * When disabled, returns an always-true predicate; when enabled, only whitelisted
 * tools are permitted for the entire session.
 *
 * The decision is based solely on configuration, not on whether a team exists:
 * switching modes mid-session would leave stale orchestration directives in the
 * conversation history that cannot be retracted, causing the model to follow
 * outdated constraints. Configuration is authoritative from the first turn to the last.
 *
 * MCP tools are likewise excluded: fetching web pages or querying databases can
 * easily return thousands of tokens — flooding the Leader's context is no different
 * from letting it read files directly. Delegate such work to teammates.
 */
export function coordinatorToolFilter(
  enabled = false,
): (name: string) => boolean {
  if (!enabled) {
    return () => true;
  }
  return isCoordinatorTool;
}

/**
 * Determines whether Coordinator Mode is currently active; the condition is kept
 * consistent with the tool filter. The two must stay in sync — restricting tools
 * without providing guidance would leave the Leader unable to read files yet unaware
 * that it should delegate reading to a teammate.
 */
export function coordinatorActive(enabled = false): boolean {
  return enabled;
}
