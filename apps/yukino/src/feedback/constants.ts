import type { AttachmentKind } from "@/feedback/types.js";
import { REDACTED } from "@/utils/constants.js";

export const CHARS_PER_TOKEN = 3.5;
// Share of the REAL context window available to the whole analysis request.
export const CONTEXT_BUDGET_RATIO = 0.8;
export const SYSTEM_PROMPT_RESERVE_TOKENS = 1_000;
export const ANSWER_RESERVE_TOKENS = 8_000;
export const INSTRUCTIONS_RESERVE_TOKENS = 1_000;
// Even tiny windows get a minimal well-formed prompt; whether the provider
// accepts it is the provider's call (failures degrade gracefully).
export const MIN_ANALYSIS_BUDGET_TOKENS = 2_000;
// The log shares the budget: at most a quarter of it, under an absolute cap.
export const LOG_BUDGET_RATIO = 0.25;
export const MAX_LOG_CHARS = 200_000;
export const MAX_ANALYSIS_INPUT_TOKENS = 32_000;
export const MAX_ISSUES = 3;
export const MAX_ISSUE_TITLE_CHARS = 90;
export const MAX_ISSUE_BODY_CHARS = 2_000;

export const GIST_FILENAME = "feedback.json";
// Product upload budget; larger captures remain available in the local ZIP.
export const MAX_GIST_BYTES = 2 * 1024 * 1024;
export const GIST_MAX_ATTEMPTS = 3;
export const GIST_RETRY_DELAY_MS = 500;
export const GITHUB_ERROR_DETAIL_CHARS = 240;
export const MIN_GLOBAL_SECRET_LENGTH = 8;
export const GIST_UPLOAD_TOO_LARGE_MESSAGE =
  "Attachments exceed the 2 MB upload budget; use the local ZIP.";
export const GH_COMMAND_FAILED_MESSAGE = "GitHub CLI failed";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_BACKUP_FILE_BYTES = 1024 * 1024;
export const MAX_TRACE_RESULT_CHARS = 100_000;
export const MAX_CONFIG_FILE_BYTES = 256 * 1024;
export const GIT_TIMEOUT_MS = 3_000;
export const PROXY_VAR_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];
// env and log first: they are small and the most failure-relevant context.
export const COLLECT_ORDER: AttachmentKind[] = [
  "env",
  "log",
  "session",
  "tools",
  "file-history",
];

export const FEEDBACK_REPO_OWNER = "hangtiancheng";
export const FEEDBACK_REPO_NAME = "yukino-code";
export const FEEDBACK_REPO = `${FEEDBACK_REPO_OWNER}/${FEEDBACK_REPO_NAME}`;
export const DESIRED_LABELS = ["bug", "yukino-feedback"];
// Empirically safe limit for GitHub's issues/new prefill URL.
export const GITHUB_URL_LIMIT = 7250;
export const NETWORK_TIMEOUT_MS = 30_000;
export const GH_UPLOAD_TIMEOUT_MS = 60_000;
export const PROBE_TIMEOUT_MS = 3_000;

export const MAX_ANALYSIS_LOG_BYTES = 200 * 1024;

// Key names whose values must never leave the machine. camelCase is normalized
// to snake_case before matching so "apiKey" and "API_KEY" behave alike.
export const SENSITIVE_KEY =
  /(?:^|[-_])(api[-_]?key|secret|token|password|passwd|credential|authorization|cookie|private[-_]?key)(?:$|[-_])/i;
// Ordered: specific prefixes first so the generic sk- pattern cannot shadow them.
export const TEXT_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/g, replacement: REDACTED },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, replacement: REDACTED },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, replacement: REDACTED },
  { pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g, replacement: REDACTED },
  { pattern: /\bgh[a-z]_[A-Za-z0-9_]{30,}/g, replacement: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: REDACTED },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replacement: REDACTED },
];

export const ATTACHMENT_KINDS = [
  "session",
  "tools",
  "file-history",
  "log",
  "env",
] as const;
