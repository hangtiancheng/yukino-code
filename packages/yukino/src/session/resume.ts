import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  MAX_SESSION_SEARCH_CHARS,
  SESSION_TREE_COMMAND_MAX_CHARS,
} from "@/session/constants.js";
import type { SessionManager } from "@/session/manager.js";
import { sessionSearchTerms } from "@/session/organization.js";
import { SessionConflictError } from "@/session/records.js";
import {
  inspectSessionRestoration,
  prepareSessionRestoration,
  type PreparedSessionRestoration,
  type SessionRestorationOptions,
} from "@/session/restoration.js";
import { SESSION_ID_RE } from "@/storage/constants.js";
import type { Asker } from "@/tools/ask-user.js";
import { canonicalPath } from "@/utils/paths.js";

const directory = z
  .string()
  .min(1)
  .max(SESSION_TREE_COMMAND_MAX_CHARS)
  .refine(isAbsolute);
export const SessionResumeTargetSchema = z.strictObject({
  id: z.string().min(1).max(128).regex(SESSION_ID_RE),
  cwd: directory.optional(),
  destination: directory.optional(),
  copy: z.boolean().optional(),
});
export type SessionResumeTarget = z.infer<typeof SessionResumeTargetSchema>;
export type SessionResumeCommand =
  | { action: "resume"; target: SessionResumeTarget }
  | {
      action: "picker";
      allProjects: boolean;
      includeArchived: boolean;
      query: string;
    };

export function parseSessionResumeCommand(args: string): SessionResumeCommand {
  if (args.length > SESSION_TREE_COMMAND_MAX_CHARS) {
    throw new Error("Session resume command is too long");
  }
  const text = args.trim();
  if (text.startsWith("{")) {
    return {
      action: "resume",
      target: SessionResumeTargetSchema.parse(JSON.parse(text)),
    };
  }
  if (text && !text.startsWith("--")) {
    return {
      action: "resume",
      target: SessionResumeTargetSchema.parse({ id: text }),
    };
  }
  const parts = text.split(/\s+/u).filter(Boolean);
  let allProjects = false;
  let includeArchived = false;
  const query: string[] = [];
  for (const part of parts) {
    if (part === "--all") {
      allProjects = true;
    } else if (part === "--archived") {
      includeArchived = true;
    } else if (part.startsWith("--")) {
      throw new Error(
        "Usage: /resume [--all] [--archived] [query], /resume <id>, or /resume <JSON target>",
      );
    } else {
      query.push(part);
    }
  }
  const search = query.join(" ");
  if (search.length > MAX_SESSION_SEARCH_CHARS) {
    throw new Error("Session search is too long");
  }
  sessionSearchTerms(search);
  return { action: "picker", allProjects, includeArchived, query: search };
}

export async function requestSessionRestoration(
  source: SessionManager,
  currentCwd: string,
  ask: Asker,
  options: SessionRestorationOptions = {},
): Promise<PreparedSessionRestoration | null> {
  currentCwd = canonicalPath(currentCwd);
  const signal = options.signal;
  const first = await inspectSessionRestoration(source, options);
  signal?.throwIfAborted();
  let destination = options.destination ?? first.destination;
  let copy = options.copy !== undefined && options.copy !== false;
  if (first.sourceMissing && options.destination === undefined) {
    const question = `The original directory is missing. Copy session ${source.id} from ${source.cwd} to the existing current directory ${currentCwd}? The source is preserved.`;
    const answers = await ask(
      [
        {
          question,
          multiSelect: false,
          options: [{ label: "copy here" }, { label: "cancel" }],
        },
      ],
      signal,
    );
    signal?.throwIfAborted();
    if (answers[question] !== "copy here") {
      return null;
    }
    destination = currentCwd;
    copy = true;
  }
  if (destination === undefined) {
    return null;
  }
  const inspected = await inspectSessionRestoration(source, {
    destination,
    signal,
  });
  if (
    inspected.sourceRevision !== first.sourceRevision ||
    inspected.sourceLeafId !== first.sourceLeafId
  ) {
    throw new Error(
      "Session changed while choosing a destination; reopen the picker",
    );
  }
  if (source.cwd !== currentCwd || copy || inspected.sourceMissing) {
    const action = copy ? "copy" : "restore";
    const question = `${action === "copy" ? "Copy to a new identity" : "Restore session"} ${source.id}?\nSource: ${source.cwd}\nDestination: ${destination}\nRevision: ${String(inspected.sourceRevision)}\nProject resources require their own trust approval; source data is preserved.`;
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
      return null;
    }
  }
  const prepared = await prepareSessionRestoration(source, currentCwd, {
    destination,
    copy: copy ? inspected.copyConfirmation : false,
    signal,
  });
  if (
    prepared.sourceRevision !== inspected.sourceRevision ||
    prepared.sourceLeafId !== inspected.sourceLeafId
  ) {
    throw new SessionConflictError(
      inspected.sourceRevision,
      prepared.sourceRevision,
    );
  }
  await prepared.assertCurrent(signal);
  return prepared;
}
