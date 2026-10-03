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

/** Text prefix for shutdown messages; teammates launched by older versions still recognize this prefix. */
export const SHUTDOWN_PREFIX = "[shutdown]";

/**
 * Generates a request identifier. Uses a random string rather than an auto-incrementing
 * sequence because requests may originate from teammates in different processes,
 * where an incrementing counter would collide across process boundaries.
 */
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

/** Approval result; on rejection, feedback explains what needs to change. */
export function planApprovalResponse(
  from: string,
  requestId: string,
  approve: boolean,
  feedback = "",
): FileMailMessage {
  return typed(from, MSG_PLAN_APPROVAL_RESPONSE, requestId, feedback, approve);
}

/**
 * Determines whether a message is a shutdown request.
 *
 * In addition to checking the type field, the "[shutdown]" text prefix is also
 * recognized: pane teammates are independent processes that may have been launched
 * by an older version, and a user manually inserting a line into the mailbox
 * should also work.
 */
export function isShutdownRequest(m: FileMailMessage): boolean {
  if (m.type === MSG_SHUTDOWN_REQUEST) {
    return true;
  }
  return (m.text ?? "").trim().startsWith(SHUTDOWN_PREFIX);
}

/**
 * Whether the response constitutes approval. When the field is absent, it is
 * treated as not approved — silence is never interpreted as consent; the
 * requester follows the rejection path instead (for plan approval, the
 * teammate revises and resubmits).
 */
export function approved(m: FileMailMessage): boolean {
  return m.approve === true;
}
