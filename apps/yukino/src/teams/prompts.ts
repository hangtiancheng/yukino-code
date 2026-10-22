import type { FileMailMessage } from "@/teams/file-mailbox.js";
import type { Task } from "@/todo/index.js";

export const TEAM_CREATE_TOOL_DESCRIPTION =
  "Create an automatically named team for coordinating multiple agents. At most one team exists at a time: creating a team deletes any other team, stopping its members.";

export const SEND_MESSAGE_TOOL_DESCRIPTION =
  "Communicate within an agent team: send a message to a teammate or to the leader mailbox. One-shot subagents cannot receive messages; create Agent kind=\"teammate\" when communication or follow-up assignments are needed. Use to='leader' for the coordinator and to='*' to broadcast to all teammates. In coordinator mode, only the leader can send plan_approval_response; copy request_id, set approve, and give review feedback in content.";

export const LIST_TEAM_TOOL_DESCRIPTION =
  "List the current team and its members.";

export const TEAM_DELETE_TOOL_DESCRIPTION =
  "Delete the current team and stop its members.";

export const TASK_STOP_TOOL_DESCRIPTION =
  "Stop a running teammate or stop a background tool call early (subagent, Bash, PowerShell). Pass exactly one of teammate or task_id. Cancellation waits for cleanup; terminal background tasks leave the active UI while their results remain available through TaskOutput.";

export const TASK_STOP_SUBAGENT_TOOL_DESCRIPTION =
  "Stop one of this agent's own background tasks (Agent, Bash, PowerShell). Pass task_id.";

export function buildTaskAssignmentPrompt(task: Task): string {
  return `Task assignment: #${task.id} ${task.subject}\n${task.description}\nUse TodoWrite({}) to inspect dependencies, then TodoWrite({todos:[{id:"${task.id}",status:"in_progress"}]}) to claim it before starting.`;
}

export const PLAN_AUTO_APPROVED_MESSAGE =
  "Your plan was automatically approved. Begin execution within the current tool permissions; plan approval does not authorize individual tool calls.";

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

function formatMailboxLines(messages: FileMailMessage[]): string {
  return messages
    .map((message) => `From ${message.from}: ${message.text}`)
    .join("\n\n");
}
