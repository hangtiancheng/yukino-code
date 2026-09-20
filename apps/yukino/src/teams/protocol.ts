/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { randomBytes } from "node:crypto";

import type { FileMailMessage } from "./file-mailbox.js";

/**
 * Beyond plain text, teammates exchange several kinds of structured messages.
 *
 * Each carries a requestId that is echoed verbatim in the response, allowing the
 * Lead to correlate replies with the requests it sent: when shutdown requests are
 * dispatched to three teammates simultaneously, the three responses are
 * indistinguishable without an ID.
 */
export const MSG_TEXT = "text";
export const MSG_SHUTDOWN_REQUEST = "shutdown_request";
export const MSG_SHUTDOWN_RESPONSE = "shutdown_response";
export const MSG_PLAN_APPROVAL_REQUEST = "plan_approval_request";
export const MSG_PLAN_APPROVAL_RESPONSE = "plan_approval_response";

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

/** Shutdown request. The text carries the reason so the teammate can decide whether to agree. */
export function shutdownRequest(from: string, reason = ""): FileMailMessage {
  const why = reason || "team is wrapping up";
  return typed(from, MSG_SHUTDOWN_REQUEST, newRequestId(), `${SHUTDOWN_PREFIX} ${why}`);
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
export function planApprovalRequest(from: string, plan: string): FileMailMessage {
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
 * treated as not approved — better to make the Lead wait another round than to
 * interpret silence as consent.
 */
export function approved(m: FileMailMessage): boolean {
  return m.approve === true;
}
