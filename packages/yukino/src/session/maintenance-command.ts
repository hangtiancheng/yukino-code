import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  MAX_SESSION_STRING_BYTES,
  SESSION_TREE_COMMAND_MAX_CHARS,
} from "@/session/constants.js";
import {
  archiveSession,
  executeSessionMaintenance,
  planSessionMaintenance,
  unarchiveSession,
  type SessionMaintenancePlan,
} from "@/session/maintenance.js";
import { SessionManager } from "@/session/manager.js";
import { SESSION_ID_RE } from "@/storage/constants.js";
import type { Asker } from "@/tools/ask-user.js";

export const SessionMaintenanceTargetSchema = z.strictObject({
  id: z.string().min(1).max(128).regex(SESSION_ID_RE),
  cwd: z
    .string()
    .min(1)
    .max(SESSION_TREE_COMMAND_MAX_CHARS)
    .refine(isAbsolute)
    .optional(),
});

function preview(plan: SessionMaintenancePlan): string {
  const bytes = plan.paths.reduce((total, path) => total + path.size, 0);
  const report = [
    `Session: ${plan.sessionId}`,
    `Project: ${plan.cwd}`,
    `Revision: ${String(plan.revision)} · operation: ${plan.operation}`,
    `Owned paths: ${String(plan.paths.length)} · ${String(bytes)} bytes`,
    ...plan.paths.map(
      (path) =>
        `${path.path} · ${String(path.size)} bytes · ${path.sha256 ?? "directory"}`,
    ),
    `Referenced artifacts: ${String(plan.referencePreview.length)}`,
    ...plan.referencePreview.map(
      (reference) =>
        `${reference.path ?? reference.artifactId ?? "artifact"} · ${reference.sha256} · sessions: ${reference.sessionIds.join(", ")}`,
    ),
    `Plan: ${plan.planId}`,
    "Execution rechecks revisions, process leases, ownership and references; no automatic cleanup.",
  ].join("\n");
  if (Buffer.byteLength(report) > MAX_SESSION_STRING_BYTES / 2) {
    throw new Error(
      "Maintenance preview exceeds the interactive limit; inspect the full plan through the SDK before confirming.",
    );
  }
  return report;
}

export async function sessionMaintenanceCommand(
  name: "archive" | "unarchive" | "maintenance",
  args: string,
  manager: SessionManager,
  ask: Asker,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (args.length > SESSION_TREE_COMMAND_MAX_CHARS) {
    throw new Error("Maintenance command is too long");
  }
  const text = args.trim();
  if (name === "archive" || name === "unarchive") {
    if (text) {
      throw new Error(`Usage: /${name}`);
    }
    manager.refresh();
    if (name === "archive") {
      archiveSession(manager, manager.revision);
    } else {
      unarchiveSession(manager, manager.revision);
    }
    return `Session ${manager.id} ${name === "archive" ? "archived" : "unarchived"}; data preserved.`;
  }
  const space = text.indexOf(" ");
  const action = (space === -1 ? text : text.slice(0, space)) || "preview";
  if (!["preview", "cleanup", "delete"].includes(action)) {
    throw new Error(
      "Usage: /maintenance [preview|cleanup|delete] [JSON target]",
    );
  }
  const targetText = space === -1 ? "" : text.slice(space + 1).trim();
  const target = targetText
    ? SessionMaintenanceTargetSchema.parse(JSON.parse(targetText))
    : { id: manager.id, cwd: manager.cwd };
  const source =
    target.id === manager.id && (!target.cwd || target.cwd === manager.cwd)
      ? manager
      : SessionManager.open(target.cwd ?? manager.cwd, target.id);
  if (
    action === "delete" &&
    source.id === manager.id &&
    source.cwd === manager.cwd
  ) {
    throw new Error(
      "Switch away from the current session before deleting it; active runtime storage is protected.",
    );
  }
  source.refresh();
  const identity = { cwd: source.cwd, sessionId: source.id };
  const plan = planSessionMaintenance(
    identity,
    action === "delete" ? "delete" : "cleanup",
  );
  const report = preview(plan);
  if (action === "preview") {
    return report;
  }
  const question = `${report}\n\nConfirm this exact ${action} plan?`;
  const answers = await ask(
    [
      {
        question,
        multiSelect: false,
        options: [{ label: action }, { label: "cancel" }],
      },
    ],
    signal,
  );
  signal?.throwIfAborted();
  if (answers[question] !== action) {
    return "Session maintenance canceled; all data preserved.";
  }
  const result = executeSessionMaintenance(identity, plan, {
    confirmed: true,
    planId: plan.planId,
  });
  if (source === manager) {
    manager.refresh();
  }
  return `${result.operation}: ${String(result.deletedPaths.length)} owned paths / ${String(result.deletedBytes)} bytes removed from session ${result.sessionId}.`;
}
