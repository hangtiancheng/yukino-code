import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import { FEEDBACK_DIR_NAME, ISSUES_FILENAME } from "./constants.js";
import {
  FiledIssueRecordSchema,
  type FiledIssueRecord,
  type IssueDraft,
} from "./types.js";
import { sessionPath } from "@yukino.js/storage";
import {
  mkdirPrivateSync as mkdirSync,
  readPrivateFileSync as readFileSync,
  writePrivateFileSync as writeFileSync,
} from "@yukino.js/storage/private.js";
import { withFileSyncLock } from "@yukino.js/teams/file-lock.js";

const FiledRecordsSchema = z.array(FiledIssueRecordSchema);

/** Normalize a title so cosmetic differences do not defeat dedup. */
export function issueFingerprint(title: string): string {
  const normalized = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return createHash("sha256").update(normalized).digest("hex");
}

function issuesFilePath(sessionId: string): string {
  return sessionPath(sessionId, FEEDBACK_DIR_NAME, ISSUES_FILENAME);
}

/** Issues filed during this session; persisted so /resume keeps the dedup. */
export function loadFiledIssues(sessionId: string): FiledIssueRecord[] {
  const path = issuesFilePath(sessionId);
  if (!existsSync(path)) {
    return [];
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    const parsed = FiledRecordsSchema.safeParse(raw);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function recordFiledIssues(
  sessionId: string,
  records: FiledIssueRecord[],
): void {
  if (records.length === 0) {
    return;
  }
  const path = issuesFilePath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  withFileSyncLock(path, () => {
    const merged = [...loadFiledIssues(sessionId), ...records];
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  });
}

/**
 * Drop drafts whose fingerprint matches an issue already filed in this session
 * (and collapse duplicates inside the batch itself).
 */
export function filterDuplicateDrafts(
  drafts: IssueDraft[],
  filed: FiledIssueRecord[],
): { fresh: IssueDraft[]; skipped: number } {
  const seen = new Set(filed.map((record) => record.fingerprint));
  const fresh: IssueDraft[] = [];
  let skipped = 0;
  for (const draft of drafts) {
    const fingerprint = issueFingerprint(draft.title);
    if (seen.has(fingerprint)) {
      skipped++;
      continue;
    }
    seen.add(fingerprint);
    fresh.push(draft);
  }
  return { fresh, skipped };
}
