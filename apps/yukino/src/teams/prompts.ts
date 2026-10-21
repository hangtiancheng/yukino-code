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
