import { createHash } from "node:crypto";
import { closeSync, fsyncSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CodeModeCall, WorkflowVmOutcome } from "@/code-mode/types.js";
import { openPrivateFileSync } from "@/storage/private.js";
import { tryAcquireFileSyncLock } from "@/teams/file-lock.js";
import { asRecord } from "@/utils/index.js";
import { stableStringify } from "@/utils/json.js";
import {
  JOURNAL_FILENAME,
  RUN_ID_RE,
  WORKFLOW_MAX_JOURNAL_CHARS,
} from "@/workflow/constants.js";
import type { JournalStore } from "@/workflow/ports.js";
import { journalEntrySchema, type JournalEntry } from "@/workflow/schema.js";
import type { WorkflowRunResult } from "@/workflow/types.js";

export function workflowFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value) ?? "")
    .digest("hex");
}

export interface WorkflowJournalState {
  header?: Extract<JournalEntry, { kind: "header" }>;
  calls: CodeModeCall[];
  started: Set<number>;
  agentStarts: number;
  outcomes: {
    id: number;
    seq: number;
    now: number;
    outcome: WorkflowVmOutcome;
  }[];
  checkpoints: Map<number, number>;
  final?: WorkflowRunResult;
  edited?: boolean;
}
export function rebuildWorkflowJournal(
  entries: JournalEntry[],
): Map<string, WorkflowJournalState> {
  const scopes = new Map<string, WorkflowJournalState>();
  for (const raw of entries) {
    const entry = journalEntrySchema.parse(raw);
    let state = scopes.get(entry.scope);
    if (entry.kind === "header") {
      state ??= {
        calls: [],
        started: new Set(),
        agentStarts: 0,
        outcomes: [],
        checkpoints: new Map(),
      };
      if (state.header && state.header.fingerprint !== entry.fingerprint) {
        state.checkpoints.clear();
        state.edited = true;
      }
      state.header = entry;
      state.final = undefined;
      scopes.set(entry.scope, state);
      continue;
    }
    if (!state?.header) {
      throw new Error(
        "Invalid Workflow journal order; unsupported or missing VM header",
      );
    }
    switch (entry.kind) {
      case "call":
        if (entry.call.id !== state.calls.length + 1 || state.final) {
          throw new Error("Invalid Workflow call sequence");
        }
        state.calls.push(entry.call);
        break;
      case "started":
        if (
          !state.calls[entry.id - 1] ||
          state.started.has(entry.id) ||
          state.final
        ) {
          throw new Error("Invalid Workflow started record");
        }
        state.started.add(entry.id);
        if (state.calls[entry.id - 1].name === "agent") {
          state.agentStarts++;
        }
        break;
      case "outcome":
        if (
          !state.started.has(entry.id) ||
          state.outcomes.some((item) => item.id === entry.id) ||
          entry.seq !== state.outcomes.length + 1 ||
          state.final
        ) {
          throw new Error("Invalid Workflow outcome sequence");
        }
        state.outcomes.push(entry);
        break;
      case "idle":
        if (
          entry.seq > state.outcomes.length ||
          entry.issued > state.calls.length ||
          (state.checkpoints.has(entry.seq) &&
            state.checkpoints.get(entry.seq) !== entry.issued)
        ) {
          throw new Error("Invalid Workflow checkpoint");
        }
        state.checkpoints.set(entry.seq, entry.issued);
        break;
      case "invalidate":
        if (entry.from > state.calls.length + 1) {
          throw new Error("Invalid Workflow suffix invalidation");
        }
        state.calls = state.calls.filter((call) => call.id < entry.from);
        state.started = new Set(
          [...state.started].filter((id) => id < entry.from),
        );
        state.outcomes = state.outcomes
          .filter((item) => item.id < entry.from)
          .map((item, index) => ({ ...item, seq: index + 1 }));
        state.checkpoints.clear();
        state.final = undefined;
        break;
      case "final":
        if (state.final) {
          throw new Error("Duplicate Workflow final record");
        }
        state.final = entry.result;
        state.edited = false;
        break;
    }
  }
  return scopes;
}

export function createFileJournalStore(runsDir: string): JournalStore {
  const pathOf = (runId: string) => {
    if (!RUN_ID_RE.test(runId)) {
      throw new Error("Invalid workflow run ID");
    }
    return join(runsDir, runId, JOURNAL_FILENAME);
  };
  let pending = Promise.resolve();
  return {
    acquire(runId) {
      pathOf(runId);
      const release = tryAcquireFileSyncLock(
        join(runsDir, `.workflow-${runId}`),
        0,
      );
      if (!release) {
        throw new Error("Workflow is already executing in another process");
      }
      return release;
    },
    async read(runId) {
      await pending;
      let raw: string;
      try {
        raw = await readFile(pathOf(runId), "utf8");
      } catch (error) {
        if (asRecord(error).code === "ENOENT") {
          return [];
        }
        throw error;
      }
      if (
        raw.length > WORKFLOW_MAX_JOURNAL_CHARS ||
        (raw && !raw.endsWith("\n"))
      ) {
        throw new Error("Incomplete or oversized Workflow journal");
      }
      const entries = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => journalEntrySchema.parse(JSON.parse(line)));
      rebuildWorkflowJournal(entries);
      return entries;
    },
    append(runId, entry) {
      const parsed = journalEntrySchema.parse(entry);
      const next = pending.then(() => {
        const fd = openPrivateFileSync(pathOf(runId), "a");
        try {
          writeFileSync(fd, JSON.stringify(parsed) + "\n", "utf8");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      });
      pending = next.catch(() => undefined);
      return next;
    },
  };
}
