import { randomBytes } from "node:crypto";

import {
  LEADER_NAME,
  MSG_PLAN_APPROVAL_REQUEST,
  MSG_PLAN_APPROVAL_RESPONSE,
  MSG_SHUTDOWN_REQUEST,
  MSG_SHUTDOWN_RESPONSE,
  TEAMMATE_NAME_PATTERN,
} from "@/teams/constants.js";
import type { FileMailMessage } from "@/teams/file-mailbox.js";
import { DEFAULT_SHUTDOWN_REASON } from "@/teams/prompts.js";

export function isValidTeammateName(name: string): boolean {
  return name !== LEADER_NAME && TEAMMATE_NAME_PATTERN.test(name);
}

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
  const why = reason || DEFAULT_SHUTDOWN_REASON;
  return typed(from, MSG_SHUTDOWN_REQUEST, newRequestId(), why);
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

/** Leader's decision, with review feedback for the teammate. */
export function planApprovalResponse(
  from: string,
  requestId: string,
  approve: boolean,
  feedback = "",
): FileMailMessage {
  return typed(from, MSG_PLAN_APPROVAL_RESPONSE, requestId, feedback, approve);
}

export function isShutdownRequest(m: FileMailMessage): boolean {
  return (
    m.from === LEADER_NAME && m.type === MSG_SHUTDOWN_REQUEST && !!m.requestId
  );
}
