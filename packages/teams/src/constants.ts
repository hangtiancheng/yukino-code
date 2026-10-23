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

export const TEAMMATE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Replaces every non-alphanumeric character when compressing a team display
// name into its canonical directory slug.
export const TEAM_NAME_SLUG_PATTERN = /[^a-zA-Z0-9]/g;

// Teammates run unattended, so messaging and TODO bookkeeping use coordination
// permissions. Explicit deny/ask rules still take precedence.
export const TEAMMATE_COORDINATION_TOOLS: ReadonlySet<string> = new Set([
  "SendMessage",
  "TodoWrite",
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
  "Workflow",
  "Goal",
  "Agent",
  "SendMessage",
  "TaskStop",
  "SyntheticOutput",
  "TeamDelete",
  "TodoWrite",
]);

export const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
export const LOCK_STALE_MS = 10_000;
export const LOCK_MIN_BACKOFF_MS = 5;
export const LOCK_MAX_BACKOFF_MS = 80;

export const IDLE_POLL_INTERVAL_MS = 500;

// Refresh cadence for the leader's shared task-board subscription.
export const LEADER_TASK_REFRESH_INTERVAL_MS = 500;

export const MAX_READ_MESSAGES = 500;

export const MAX_RETAINED_TERMINATED_MEMBERS = 200;

// Truncation limit for the last-message preview shown in the teammate UI.
export const MAX_LAST_MESSAGE_CHARS = 200;

// Cap on the retained recent-activity history per teammate.
export const MAX_RECENT_ACTIVITIES = 5;

export const TEAM_CONFIG_FILENAME = "config.json";
export const TEAMS_DIR_NAME = "teams";
export const INBOXES_DIR_NAME = "inboxes";

// boardId prefix for the team-shared task board (sibling of PRIVATE_BOARD_ID_PREFIX).
export const TEAM_BOARD_ID_PREFIX = "team:";

export const TEAMMATE_SPINNER_VERB = "Working";

// lastMessage shown in the teammate UI after an aborted run.
export const TEAMMATE_STOPPED_MESSAGE = "Stopped";

// SendMessage recipient key that broadcasts to every active teammate.
export const BROADCAST_TARGET = "*";

export const EMPTY_TEAMMATE_PLAN_MESSAGE = "(The teammate returned no plan.)";

export const NO_ACTIVE_TEAM_MESSAGE = "No active team.";
export const NO_ACTIVE_TEAM_FOR_SENDER_ERROR =
  "No active team found for this sender.";
export const PLAN_APPROVAL_LEADER_ONLY_ERROR =
  "Only the leader can approve or reject teammate plans.";
export const PLAN_APPROVAL_RESPONSE_REQUIRED_ERROR =
  "plan_approval_response requires request_id, approve, and review feedback in content.";
export const SHUTDOWN_LEADER_ONLY_ERROR =
  "Only the leader can request teammate shutdown.";
export const SHUTDOWN_RESPONSE_APPROVE_REQUIRED_ERROR =
  "shutdown_response requires 'approve'.";
export const TASK_STOP_TARGET_REQUIRED_ERROR =
  "Error: pass exactly one of teammate or task_id";
export const TEAMMATE_STOP_LEADER_ONLY_ERROR =
  "Only the leader can stop teammates.";

export const MAILBOX_INVALID_MEMBER_NAME_ERROR = "Invalid mailbox member name";
export const MAILBOX_UNREADABLE_ERROR =
  "Cannot load an unreadable teammate mailbox; original contents were preserved";

export const SHARED_TASK_INVALID_ID_COUNTER_ERROR =
  "Invalid shared task ID counter";
export const SHARED_TASK_UNREADABLE_ERROR =
  "Cannot load an unreadable shared task board";

export const TEAM_NAME_EMPTY_ERROR =
  "Team name must not be empty or whitespace.";

export const NO_TEAM_TASK_BOARD_ERROR = "No active team task board";

export const PLAN_SUBMIT_INACTIVE_ERROR =
  "Only an active teammate in plan mode can submit a plan.";
export const PLAN_SUBMIT_EMPTY_ERROR =
  "A non-empty plan is required for review.";
export const PLAN_SUBMIT_PENDING_ERROR =
  "This teammate already has a plan awaiting review.";
export const PLAN_RESPOND_AUTO_APPROVED_ERROR =
  "Teammate plans are automatically approved outside coordinator mode.";
export const PLAN_RESPOND_NOT_PENDING_ERROR =
  "No matching pending plan approval request for this teammate.";
export const PLAN_RESPOND_ALREADY_RESPONDED_ERROR =
  "This plan approval request already has a leader response.";
export const PLAN_RESPOND_FEEDBACK_REQUIRED_ERROR =
  "Plan approval responses require the leader's review feedback.";

export function buildInvalidTeammateNameError(name: string): string {
  return `Invalid teammate name '${name}'`;
}

export function buildTeammateExistsError(name: string): string {
  return `Teammate '${name}' already exists`;
}

export function buildTeammateAlreadyRunningError(name: string): string {
  return `Teammate '${name}' is already running`;
}

export function buildStopActiveTeammateError(name: string): string {
  return `Stop teammate '${name}' before removing it`;
}

export function buildMemberNotFoundInTeamError(
  to: string,
  teamName: string,
): string {
  return `Member '${to}' not found in team '${teamName}'`;
}

export function buildInactiveTeammateError(to: string, status: string): string {
  return `Teammate '${to}' is ${status} and cannot receive work`;
}

export function buildTeammateUnavailableForAssignmentError(
  name: string,
): string {
  return `Teammate '${name}' is not available for assignment`;
}

export function buildTeamCreatedMessage(teamName: string): string {
  return (
    `Team '${teamName}' created. ` +
    `Use Agent with kind="teammate" to add teammates.`
  );
}

export function buildTeamDeletedMessage(teamName: string): string {
  return `Team '${teamName}' deleted.`;
}

export function buildMessageSentMessage(to: string): string {
  return `Message sent to '${to}'.`;
}

export function buildBroadcastSentMessage(count: number): string {
  return `Message broadcast to ${String(count)} teammate(s).`;
}

export function buildTypedMessageSentMessage(
  msgType: string,
  to: string,
): string {
  return `${msgType} sent to '${to}'.`;
}

export function buildUnsupportedMessageTypeError(msgType: string): string {
  return `Unsupported message type ${msgType}.`;
}

export function buildTeammateNotFoundError(to: string): string {
  return `Teammate '${to}' not found.`;
}

export function buildPlanResponseSentMessage(
  approve: boolean,
  to: string,
): string {
  return `Plan ${approve ? "approval" : "revision feedback"} sent to '${to}'.`;
}

export function buildBackgroundTaskNotFoundError(taskId: string): string {
  return `Error: background task '${taskId}' not found`;
}

export function buildBackgroundTaskNotRunningMessage(
  taskId: string,
  status: string,
): string {
  return `Background task '${taskId}' is ${status}, nothing to stop`;
}

export function buildBackgroundTaskStoppedMessage(taskId: string): string {
  return `Background task '${taskId}' stopped.`;
}

export function buildTeammateNotRunningMessage(
  name: string,
  teamName: string,
): string {
  return `Teammate '${name}' in team '${teamName}' is not running, nothing to stop`;
}

export function buildTeammateStoppedMessage(
  name: string,
  teamName: string,
): string {
  return `Teammate '${name}' in team '${teamName}' stopped.`;
}

export function buildUnknownTeammateError(
  name: string,
  knownMembers: string,
): string {
  return `Error: teammate '${name}' not found. Known teammates: ${knownMembers}`;
}
