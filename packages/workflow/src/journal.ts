import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import {
  writePrivateFile,
  appendPrivateFileSync,
} from "@yukino.js/storage/private.js";
import { asRecord } from "@yukino.js/utils";
import { JOURNAL_FILENAME, RUN_ID_RE } from "./constants.js";
import type { JournalStore } from "./ports.js";
import { journalEntrySchema } from "./schema.js";
import type { AgentRunParams } from "./types.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function agentCallKey(prompt: string, params: AgentRunParams): string {
  const { label: _label, phase: _phase, ...rest } = params;
  return createHash("sha256")
    .update(prompt + "\n" + JSON.stringify(canonical(rest)))
    .digest("hex");
}

export function createFileJournalStore(runsDir: string): JournalStore {
  const pathOf = (runId: string) => {
    if (!RUN_ID_RE.test(runId)) {
      throw new Error("Invalid workflow run ID");
    }
    return join(runsDir, runId, JOURNAL_FILENAME);
  };
  let pending = Promise.resolve();
  const enqueue = (operation: () => void | Promise<void>): Promise<void> => {
    const next = pending.then(operation);
    pending = next.catch(() => undefined);
    return next;
  };
  return {
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
      return raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => journalEntrySchema.parse(JSON.parse(line)))
        .sort((a, b) => a.seq - b.seq);
    },
    append(runId, entry) {
      return enqueue(() => {
        const path = pathOf(runId);
        appendPrivateFileSync(path, JSON.stringify(entry) + "\n", "utf8");
      });
    },
    replace(runId, entries) {
      return enqueue(async () => {
        const path = pathOf(runId);
        await writePrivateFile(
          path + ".tmp",
          entries.map((entry) => JSON.stringify(entry) + "\n").join(""),
          "utf8",
        );
        await rename(path + ".tmp", path);
      });
    },
  };
}
