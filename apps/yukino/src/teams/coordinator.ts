// CoordinatorMode narrows the Leader's toolset to pure orchestration.
//
// The dividing line is not "read" vs. "write" — it is whether a tool would flood
// the Leader's context with large volumes of content. The Leader's context must hold
// task decomposition, teammate status, and message history; once it can read files
// or run commands directly, the model will inevitably start investigating on its
// own. Thousands of lines of code pour in, and the space that should be reserved
// for orchestration is gone. That is why ReadFile / Glob / Grep / Bash are excluded:
// when code needs to be inspected, delegate to a teammate who brings back conclusions.
// The Leader digests those conclusions and writes the next specification.
//
// Shared task metadata is orchestration, not workspace investigation.
//
// TeamDelete is retained for teardown: teammates are attached to the Team, and once
// work is done there must be a way to stop them and clean up the team directory.
// TeamCreate is not here because the Agent tool's team_name path auto-creates the
// specified Team if it does not exist — the Leader simply dispatches teammates
// without a separate team-creation step.
const COORDINATOR_ALLOWED_TOOLS = new Set([
  "Goal",
  "Agent",
  "SendMessage",
  "TaskStop",
  "SyntheticOutput",
  "TeamDelete",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TodoWrite",
]);

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
