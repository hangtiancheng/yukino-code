import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  analyzeHarnessAnomalies,
  descriptionFallbackDraft,
} from "./analyze.js";
import {
  buildEnvironment,
  collectAttachments,
  feedbackLogPath,
  feedbackRedactor,
  readTextCapped,
  summarizeEnvironment,
  type CollectOutput,
  type EnvironmentSnapshot,
  type RuntimeInfo,
} from "./collect.js";
import {
  filterDuplicateDrafts,
  issueFingerprint,
  loadFiledIssues,
  recordFiledIssues,
} from "./dedup.js";
import {
  buildIssueUrl,
  createGist,
  createIssue,
  desiredLabels,
  detectChannel,
  fetchRepoLabels,
  openInBrowser,
} from "./github.js";
import { redactJsonLines, redactText } from "./redact.js";
import type {
  FeedbackChannel,
  FeedbackOptions,
  IssueConfirmation,
  IssueDraft,
} from "./types.js";
import { writeZipArchive } from "./zip.js";

import type { Message } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import { createChildLogger } from "@/logger/index.js";
import {
  COMPACT_BOUNDARY,
  loadSession,
  rebuildFromSession,
} from "@/session/index.js";
import { sessionPath } from "@/storage/index.js";
import { asErrorString } from "@/utils/index.js";
import { version } from "@/version.js";

const MAX_ANALYSIS_LOG_BYTES = 200 * 1024;
const log = createChildLogger({ module: "feedback" });

interface Attachments {
  gistUrl?: string;
  bundlePath?: string;
  uploadError?: string;
  names: string[];
}

function analysisHistory(deps: PipelineDeps): Message[] {
  const saved = loadSession(deps.cwd, deps.sessionId);
  const boundary = saved.findLastIndex(
    (message) => message.type === COMPACT_BOUNDARY,
  );
  if (boundary < 0) {
    return deps.messages;
  }
  return [
    ...rebuildFromSession(
      saved
        .slice(0, boundary)
        .filter((message) => message.type !== COMPACT_BOUNDARY),
      { includeExcludedUserBash: true },
    ),
    ...deps.messages,
  ];
}

export interface PipelineDeps {
  cwd: string;
  sessionId: string;
  client: LLMClient;
  messages: Message[];
  runtime?: RuntimeInfo;
  contextWindow: number;
  abortSignal: AbortSignal;
  onProgress: (message: string) => void;
  confirmIssues: (issues: IssueDraft[]) => Promise<IssueConfirmation>;
}

export interface PipelineResult {
  report: string;
  /** Set when the user rejected filing; carries the drafts and their reason. */
  rejection?: { issues: IssueDraft[]; reason?: string };
}

/** The log always feeds the analysis, independent of the attachment choice. */
function readLogForAnalysis(sessionId: string): string | null {
  try {
    const { content } = readTextCapped(
      feedbackLogPath(sessionId),
      MAX_ANALYSIS_LOG_BYTES,
    );
    return redactJsonLines(content);
  } catch {
    return null;
  }
}

async function writeBundle(
  sessionId: string,
  collected: CollectOutput,
): Promise<string> {
  const dir = sessionPath(sessionId, "feedback");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `bundle-${stamp}.zip`);
  await writeZipArchive(
    path,
    collected.files.map((file) => ({ name: file.name, data: file.content })),
  );
  return path;
}

function assembleIssueBody(
  draft: IssueDraft,
  env: EnvironmentSnapshot,
  sessionId: string,
  attachments: Attachments,
): string {
  const attachmentLines = attachments.gistUrl
    ? [
        `Attachments (secret Gist): ${attachments.gistUrl}`,
        `Included: ${attachments.names.join(", ")}`,
      ]
    : attachments.bundlePath
      ? [
          `Attachments exported locally (not uploaded): ${attachments.bundlePath}`,
          `Included: ${attachments.names.join(", ")}`,
          "Please attach the zip manually if you can.",
        ]
      : ["Attachments: none selected"];
  const body = [
    draft.body.trim(),
    "",
    "<details><summary>Environment</summary>",
    "",
    "```json",
    JSON.stringify(summarizeEnvironment(env), null, 2),
    "```",
    "",
    "</details>",
    "",
    ...attachmentLines,
    ...(attachments.uploadError
      ? [`Attachment upload failed: ${attachments.uploadError}`]
      : []),
    "",
    `Reported via /feedback · session ${sessionId} · yukino ${version}`,
  ].join("\n");
  return redactText(body);
}

interface FiledResult {
  title: string;
  url: string;
  error?: string;
}

async function fileIssues(
  channel: FeedbackChannel,
  drafts: IssueDraft[],
  bodyFor: (draft: IssueDraft) => string,
  abortSignal: AbortSignal,
  onFiled: (result: FiledResult) => void,
): Promise<FiledResult[]> {
  abortSignal.throwIfAborted();
  if (channel === "browser") {
    return drafts.map((draft) => {
      abortSignal.throwIfAborted();
      const url = buildIssueUrl(draft.title, bodyFor(draft));
      openInBrowser(url);
      return { title: draft.title, url };
    });
  }

  const labels = desiredLabels(await fetchRepoLabels(channel, abortSignal));
  const results: FiledResult[] = [];
  for (const draft of drafts) {
    abortSignal.throwIfAborted();
    let result: FiledResult;
    try {
      const created = await createIssue(
        channel,
        draft.title,
        bodyFor(draft),
        labels,
        abortSignal,
      );
      result = { title: draft.title, url: created.url };
    } catch (err) {
      abortSignal.throwIfAborted();
      result = {
        title: draft.title,
        url: "",
        error: asErrorString(err),
      };
    }
    results.push(result);
    if (!result.error) {
      onFiled(result);
    }
  }
  return results;
}

function formatReport(
  channel: FeedbackChannel,
  results: FiledResult[],
  skippedDuplicates: number,
  attachments: Attachments,
  collected?: CollectOutput,
): string {
  const lines: string[] = [];
  const filed = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  if (channel === "browser") {
    lines.push(
      `No gh CLI or GitHub token found — opened ${String(filed.length)} prefilled issue page(s) in your browser.`,
      "Review each one and press Submit; the report is not filed until you do.",
    );
  } else if (filed.length > 0) {
    lines.push(`Filed ${String(filed.length)} issue(s) via ${channel}:`);
  }
  for (const result of filed) {
    lines.push(`  • ${result.title} — ${result.url}`);
  }
  for (const result of failed) {
    lines.push(`  ✗ ${result.title} — failed: ${result.error ?? "unknown"}`);
  }
  if (skippedDuplicates > 0) {
    lines.push(
      `Skipped ${String(skippedDuplicates)} issue(s) already filed in this session.`,
    );
  }
  if (attachments.gistUrl) {
    lines.push(`Attachments (secret Gist): ${attachments.gistUrl}`);
  }
  if (attachments.bundlePath) {
    lines.push(`Attachments exported locally: ${attachments.bundlePath}`);
  }
  if (attachments.uploadError) {
    lines.push(`Attachment upload failed: ${attachments.uploadError}`);
  }
  if (collected?.skipped.length) {
    lines.push(
      `Skipped unavailable or oversized attachments: ${collected.skipped.join(", ")}`,
    );
  }
  const truncated =
    collected?.files
      .filter((file) => file.truncated)
      .map((file) => file.name) ?? [];
  if (truncated.length > 0) {
    lines.push(`Truncated attachments: ${truncated.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Full /feedback flow: analyze the session for harness anomalies, attach the
 * selected scene capture, and file one issue per distinct defect.
 */
export async function runFeedbackPipeline(
  options: FeedbackOptions,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const { sessionId, abortSignal } = deps;
  abortSignal.throwIfAborted();
  const redact = feedbackRedactor(deps.runtime);
  const env = await buildEnvironment(deps.cwd, deps.runtime);
  abortSignal.throwIfAborted();
  const filed = loadFiledIssues(sessionId);

  deps.onProgress("Analyzing session for yukino harness anomalies…");
  const logContent = readLogForAnalysis(sessionId);
  let drafts: IssueDraft[];
  try {
    drafts = await analyzeHarnessAnomalies({
      client: deps.client,
      messages: analysisHistory(deps),
      logContent,
      description: options.description,
      filedIssues: filed,
      contextWindow: deps.contextWindow,
      maxOutputTokens: deps.runtime?.provider?.maxOutputTokens,
      abortSignal,
    });
  } catch (err) {
    abortSignal.throwIfAborted();
    if (!options.description.trim()) {
      throw err;
    }
    // Analysis failed but the user wrote something — file their words.
    drafts = [descriptionFallbackDraft(options.description)];
  }
  if (drafts.length === 0 && options.description.trim()) {
    drafts = [descriptionFallbackDraft(options.description)];
  }
  if (drafts.length === 0) {
    return {
      report:
        "No yukino harness anomalies detected in this session — nothing filed.",
    };
  }

  abortSignal.throwIfAborted();
  const { fresh, skipped } = filterDuplicateDrafts(
    drafts.map((draft) => ({
      title: redact(draft.title),
      body: redact(draft.body),
    })),
    filed,
  );
  if (fresh.length === 0) {
    return {
      report: `All ${String(skipped)} detected issue(s) were already filed in this session — nothing new to file.`,
    };
  }

  deps.onProgress(
    `Prepared ${String(fresh.length)} issue(s) — waiting for approval.`,
  );
  const confirmation = await deps.confirmIssues(fresh);
  abortSignal.throwIfAborted();
  if (!confirmation.approved) {
    const reason = confirmation.reason?.trim() || undefined;
    return {
      report: reason
        ? `Issue filing rejected — reason: ${reason}. Nothing was filed or uploaded.`
        : "Issue filing rejected. Nothing was filed or uploaded.",
      rejection: { issues: fresh, reason },
    };
  }

  const channel = await detectChannel();
  abortSignal.throwIfAborted();
  deps.onProgress(`Filing ${String(fresh.length)} issue(s) via ${channel}.`);

  let collected: CollectOutput = { files: [], skipped: [] };
  if (options.attachments.length > 0) {
    deps.onProgress(
      `Collecting ${String(options.attachments.length)} attachment group(s)…`,
    );
    collected = await collectAttachments({
      cwd: deps.cwd,
      sessionId,
      attachments: options.attachments,
      runtime: deps.runtime,
      environment: env,
    });
  }
  abortSignal.throwIfAborted();

  const attachments: Attachments = {
    names: collected.files.map((file) => file.name),
  };
  if (collected.files.length > 0) {
    if (channel === "browser") {
      attachments.bundlePath = await writeBundle(sessionId, collected);
    } else {
      deps.onProgress("Uploading attachments as a secret Gist…");
      try {
        attachments.gistUrl = await createGist(
          channel,
          collected.files,
          `yukino feedback ${sessionId.slice(0, 8)}`,
          abortSignal,
        );
      } catch (err) {
        abortSignal.throwIfAborted();
        attachments.uploadError = redact(asErrorString(err));
        log.warn(
          { error: attachments.uploadError },
          "Feedback attachment upload failed",
        );
        attachments.bundlePath = await writeBundle(sessionId, collected);
        deps.onProgress(
          `Gist upload failed (${attachments.uploadError}); exported a local bundle instead.`,
        );
      }
    }
  }
  abortSignal.throwIfAborted();

  const results = await fileIssues(
    channel,
    fresh,
    (draft) => redact(assembleIssueBody(draft, env, sessionId, attachments)),
    abortSignal,
    (result) => {
      deps.onProgress(`Filed: ${result.title} — ${result.url}`);
      recordFiledIssues(sessionId, [
        {
          fingerprint: issueFingerprint(result.title),
          title: result.title,
          url: result.url,
          channel,
          ...(attachments.gistUrl ? { gistUrl: attachments.gistUrl } : {}),
          createdAt: new Date().toISOString(),
        },
      ]);
    },
  );

  return {
    report: formatReport(channel, results, skipped, attachments, collected),
  };
}
