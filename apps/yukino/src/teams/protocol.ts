import { randomBytes } from "node:crypto";

import type { FileMailMessage } from "./file-mailbox.js";

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

const teammateNamePattern = /^[a-zA-Z0-9_-]+$/;

export function isValidTeammateName(name: string): boolean {
  return name !== LEADER_NAME && teammateNamePattern.test(name);
}

/** Text control form used by the leader's stop path and the agents dialog. */
export const SHUTDOWN_PREFIX = "[shutdown]";

export function newRequestId(): string {
  return `req-${randomBytes(8).toString("hex")}`;
}

function typed(
  from: string,
  type: string,
  requestId: string,
  text: string,
  approve?: boolean,
): FileMailMessage {
  return {
    from,
    text,
    timestamp: new Date().toISOString(),
    type,
    requestId,
    ...(approve === undefined ? {} : { approve }),
  };
}

/**
 * Shutdown request. The text carries the reason so the recipient can decide
 * whether to agree (via the approve field of shutdownResponse); current
 * teammate implementations always accept.
 */
export function shutdownRequest(from: string, reason = ""): FileMailMessage {
  const why = reason || "team is wrapping up";
  return typed(
    from,
    MSG_SHUTDOWN_REQUEST,
    newRequestId(),
    `${SHUTDOWN_PREFIX} ${why}`,
  );
}

/** Teammate's reply to a shutdown request. */
export function shutdownResponse(
  from: string,
  requestId: string,
  approve: boolean,
  reason = "",
): FileMailMessage {
  return typed(from, MSG_SHUTDOWN_RESPONSE, requestId, reason, approve);
}

/** Plan approval request; text contains the full plan content. */
export function planApprovalRequest(
  from: string,
  plan: string,
): FileMailMessage {
  return typed(from, MSG_PLAN_APPROVAL_REQUEST, newRequestId(), plan);
}

/** Records the runtime's automatic plan approval. */
export function planApprovalResponse(
  from: string,
  requestId: string,
  feedback = "",
): FileMailMessage {
  return typed(from, MSG_PLAN_APPROVAL_RESPONSE, requestId, feedback, true);
}

/**
 * Determines whether a message is a shutdown request.
 *
 * Both the typed protocol and the leader's plain-text stop control are accepted.
 */
export function isShutdownRequest(m: FileMailMessage): boolean {
  if (m.type === MSG_SHUTDOWN_REQUEST) {
    return true;
  }
  return (m.text ?? "").trim().startsWith(SHUTDOWN_PREFIX);
}
