/**
 * Beyond plain text, teammates exchange several kinds of structured messages.
 *
 * Each request carries a requestId that is echoed verbatim in the response,
 * allowing the requesting side — the Leader for shutdown flows, a teammate for
 * plan approval — to correlate replies with the requests it sent: when shutdown
 * requests are dispatched to three teammates simultaneously, the three
 * responses are indistinguishable without an ID.
 */
export const MSG_TEXT = "text";
export const MSG_SHUTDOWN_REQUEST = "shutdown_request";
export const MSG_SHUTDOWN_RESPONSE = "shutdown_response";
export const MSG_PLAN_APPROVAL_REQUEST = "plan_approval_request";
export const MSG_PLAN_APPROVAL_RESPONSE = "plan_approval_response";
export const LEADER_NAME = "leader";

// Team-internal coordination tools. Teammates run unattended — they have no
// permission dialog of their own — so messaging and the shared task board
// must never fall through to an "ask" decision on a teammate checker. These
// are exempted on the checker itself (see PermissionChecker.teammate); the
// "command" categories stay in place so the Leader's calls still go through
// permission policy. Explicit deny/ask rules still take precedence.
export const TEAMMATE_COORDINATION_TOOLS: ReadonlySet<string> = new Set([
  "SendMessage",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
]);

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
// TeamCreate is not here because the Agent tool's teammate path auto-creates a
// Team if none exists — the Leader simply dispatches teammates
// without a separate team-creation step.
export const COORDINATOR_ALLOWED_TOOLS = new Set([
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

export const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
export const LOCK_STALE_MS = 10_000;
export const LOCK_MIN_BACKOFF_MS = 5;
export const LOCK_MAX_BACKOFF_MS = 80;

export const MAX_READ_MESSAGES = 500;

export const MAX_RETAINED_TERMINATED_MEMBERS = 200;
