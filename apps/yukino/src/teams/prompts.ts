import type { FileMailMessage } from "@/teams/file-mailbox.js";
import type { Task } from "@/todo/index.js";
import { escapeXml } from "@/utils/xml.js";

export const TEAM_CREATE_TOOL_DESCRIPTION =
  "Create an automatically named team for coordinating multiple agents. At most one team exists at a time: creating a team deletes any other team, stopping its members.";

export const TEAM_DESCRIPTION_PARAM_DESCRIPTION = "What this team will work on";

export const SEND_MESSAGE_TOOL_DESCRIPTION =
  "Communicate within an agent team: send a message to a teammate or to the leader mailbox. One-shot subagents cannot receive messages; create Agent kind=\"teammate\" when communication or follow-up assignments are needed. Use to='leader' for the coordinator and to='*' to broadcast to all teammates. In coordinator mode, only the leader can send plan_approval_response; copy request_id, set approve, and give review feedback in content.";

export const SEND_MESSAGE_TO_DESCRIPTION =
  "Teammate name, 'leader' for the coordinator, or '*' to broadcast";

export const SEND_MESSAGE_CONTENT_DESCRIPTION =
  "Message content, shutdown reason, or the leader's plan review feedback.";

export const SEND_MESSAGE_REQUEST_ID_DESCRIPTION =
  "Copy the requestId from the shutdown or plan approval request when responding.";

export const SEND_MESSAGE_APPROVE_DESCRIPTION =
  "Required for shutdown_response and plan_approval_response: whether the request was accepted.";

export const LIST_TEAM_TOOL_DESCRIPTION =
  "List the current team and its members.";

export const TEAM_DELETE_TOOL_DESCRIPTION =
  "Delete the current team and stop its members.";

export const TASK_STOP_TOOL_DESCRIPTION =
  "Stop a running teammate or stop a background tool call early (subagent, Bash, PowerShell). Pass exactly one of teammate or task_id. Cancellation waits for cleanup; terminal background tasks leave the active UI while their results remain available through TaskOutput.";

export const TASK_STOP_TEAMMATE_DESCRIPTION =
  "Name of the teammate to stop, exactly as it appears in the from= field of a task-notification";

export const TASK_STOP_TASK_ID_DESCRIPTION =
  "ID of a background task (Agent, Bash, PowerShell)";

export const TASK_STOP_SUBAGENT_TOOL_DESCRIPTION =
  "Stop one of this agent's own background tasks (Agent, Bash, PowerShell). Pass task_id.";

export const TASK_STOP_SUBAGENT_TASK_ID_DESCRIPTION =
  "ID of this agent's background task";

export function buildTaskAssignmentPrompt(task: Task): string {
  return `Task assignment: #${task.id} ${task.subject}\n${task.description}\nUse TodoWrite({}) to inspect dependencies, then TodoWrite({todos:[{id:"${task.id}",status:"in_progress"}]}) to claim it before starting.`;
}

export const PLAN_AUTO_APPROVED_MESSAGE =
  "Your plan was automatically approved. Begin execution within the current tool permissions; plan approval does not authorize individual tool calls.";

/** Leader-side notification recorded when a plan is auto-approved outside coordinator mode. */
export const PLAN_AUTO_APPROVED_ACK_MESSAGE =
  "Plan automatically approved; tool permissions remain active.";

export function buildPlanRejectedMessage(feedback: string): string {
  return `The leader rejected your plan. Review feedback:\n${feedback}\n\nStay in plan mode. Revise the plan and submit it again with ExitPlanMode when available, otherwise return the revised plan in your final response.`;
}

export function buildPlanApprovedMessage(feedback: string): string {
  return `The leader approved your plan. Review feedback:\n${feedback}\n\nBegin execution within the approved scope and current tool permissions; plan approval does not authorize individual tool calls.`;
}

export function buildNewMessagesPrompt(messages: FileMailMessage[]): string {
  return `You have new messages from your team:\n\n${formatMailboxLines(messages)}`;
}

export function buildPlanReviewResumePrompt(
  review: string,
  messages: FileMailMessage[],
): string {
  if (messages.length === 0) {
    return review;
  }
  return `${review}\n\nMessages received while awaiting plan review. Apply scope corrections before executing or revising the plan:\n\n${formatMailboxLines(messages)}`;
}

export function buildTasksReleasedMessage(
  memberName: string,
  tasks: Task[],
): string {
  return `[tasks-released] ${memberName} exited. Unassigned tasks: ${tasks.map((task) => `#${task.id}`).join(", ")}. Use TodoWrite({}) to inspect and reassign them.`;
}

export function buildSendMessageTypeDescription(
  coordinatorMode: boolean,
): string {
  return (
    "Message kind, defaults to 'text'. Use 'shutdown_request' to ask a teammate to wrap up (it replies with shutdown_response). " +
    (coordinatorMode
      ? "The leader must review each plan_approval_request and reply with plan_approval_response, approve, request_id, and substantive feedback in content."
      : "Teammate plans are automatically approved by the runtime.")
  );
}

/** Idle notifications delivered through the leader mailbox. */
export function buildIdleStoppedMessage(name: string): string {
  return `[idle] ${name} (reason: stopped)`;
}

export function buildIdleAvailableMessage(name: string): string {
  return `[idle] ${name} (reason: available)`;
}

export function buildIdleFailedMessage(name: string, error: string): string {
  return `[idle] ${name} (reason: failed): ${error}`;
}

export const SHUTDOWN_ACK_MESSAGE = "acknowledged, shutting down";

export const STOPPED_AWAITING_PLAN_REVIEW_MESSAGE =
  "Stopped while awaiting plan review";

/** Default reason text when a shutdown request carries no explicit reason. */
export const DEFAULT_SHUTDOWN_REASON = "team is wrapping up";

/** Reason for the synthetic shutdown request when a member is deactivated mid-poll. */
export const MEMBER_DEACTIVATED_SHUTDOWN_REASON = "member deactivated";

/**
 * Wraps drained leader-mailbox messages in <task-notification> XML tags, so the
 * model can parse team notifications in a structured manner.
 */
export function buildTeamNotification(
  teamName: string,
  messages: FileMailMessage[],
): string {
  const lines: string[] = [];
  lines.push(`<task-notification team="${escapeXml(teamName)}">`);
  for (const msg of messages) {
    const metadata = [
      `from="${escapeXml(msg.from)}"`,
      msg.type ? `type="${escapeXml(msg.type)}"` : "",
      msg.requestId ? `requestId="${escapeXml(msg.requestId)}"` : "",
      msg.approve === undefined ? "" : `approve="${String(msg.approve)}"`,
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`<message ${metadata}>${escapeXml(msg.text)}</message>`);
  }
  lines.push("</task-notification>");
  return lines.join("\n");
}

function formatMailboxLines(messages: FileMailMessage[]): string {
  return messages
    .map((message) => `From ${message.from}: ${message.text}`)
    .join("\n\n");
}
