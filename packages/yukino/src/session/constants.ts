export const SESSION_RUNTIME_STATE = "session_runtime_state";
export const MAX_SESSION_RUNTIME_IDENTIFIER_CHARS = 256;
export const MAX_SESSION_RUNTIME_TOOLS = 1024;
export const SESSION_RUNTIME_IDENTIFIER_RE = /^[^\p{Cc}\p{Cs}]+$/u;
export const SESSION_RUNTIME_CREDENTIAL_RE =
  /(?:\/\/|\bBearer\s+|\b(?:sk|sess|gh[pousr]|github_pat|xox[baprs])[_-]|\bAKIA[A-Z\d]{16}\b|\beyJ[A-Za-z\d_-]+\.)/iu;
export const SESSION_RUNTIME_STATE_LABEL = "Runtime state";
export const COMPACT_BOUNDARY = "compact_boundary";
export const BRANCH_SUMMARY = "branch_summary";
export const BRANCH_SUMMARY_MAX_INPUT_CHARS = 48_000;
export const BRANCH_SUMMARY_MAX_ENTRY_CHARS = 4_000;
export const BRANCH_SUMMARY_MAX_ENTRIES = 128;
export const BRANCH_SUMMARY_MAX_DESCRIPTION_CHARS = 2_048;
export const BRANCH_SUMMARY_MAX_OUTPUT_TOKENS = 2_048;
export const BRANCH_SUMMARY_MAX_OUTPUT_CHARS = 12_000;
export const BRANCH_SUMMARY_MAX_STREAM_CHARS = 96_000;
export const BRANCH_SUMMARY_TIMEOUT_MS = 120_000;
export const BRANCH_SUMMARY_EMPTY = "Branch summary returned no text.";
export const BRANCH_SUMMARY_TOOLS = "Branch summary must not request tools.";
export const BRANCH_SUMMARY_INCOMPLETE =
  "Branch summary did not complete successfully.";
export const BRANCH_SUMMARY_TOO_LARGE =
  "Branch summary exceeded its output limit.";
export const UNKNOWN_SESSION_ENTRY = "Unknown session entry.";
export const SESSION_FORMAT = "yukino-session-tree";
export const SESSION_VERSION = 1;
export const SESSION_APPEND_ROLLBACK_ERROR =
  "Could not restore the session transcript after a failed append";
export const SESSION_FILE_EXTENSION = ".jsonl";
export const FIRST_MESSAGE_PREVIEW_CHARS = 100;
export const INPUT_SESSION_MISMATCH =
  "User input does not belong to this project and session.";
export const UNSUPPORTED_SESSION_FORMAT =
  "Unsupported session format. Linear/older transcripts are not supported; the original file has been preserved.";
export const INVALID_SESSION_RECORD = "Invalid session record";
export const UNSAFE_SESSION_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
export const SESSION_CONFLICT =
  "Session revision conflict; refresh before retrying.";
export const SESSION_NOT_FOUND = "Session does not exist.";
export const UNSAFE_TOOL_BOUNDARY =
  "Cannot navigate an incomplete or ambiguous tool batch.";
export const MAX_SESSION_TIMESTAMP = 8_640_000_000_000_000;
export const INVALID_TOOL_ARTIFACT = "Invalid session tool artifact";
export const UNOWNED_ARTIFACT =
  "Export refuses an unowned persisted-output path.";
export const UNSAFE_ARTIFACT_LINK =
  "Export refuses symlink or hardlink artifacts.";
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;
export const MAX_SESSION_RECORDS = 50_000;
export const MAX_SESSION_DEPTH = 4096;
export const MAX_JSON_DEPTH = 64;
export const MAX_JSON_REFERENCES = 200_000;
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_ARTIFACT_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_ARTIFACTS = 1024;
export const MAX_METADATA_TEXT = 256;
export const MAX_SESSION_TAGS = 64;
export const ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/u;
export const MIME_TYPE_RE =
  /^[a-z\d][a-z\d!#$&^_.+-]*\/[a-z\d][a-z\d!#$&^_.+-]*$/iu;
export const SHA256_RE = /^[a-f\d]{64}$/u;
export const BASE64_RE = /^[A-Za-z\d+/]*={0,2}$/u;
export const ARTIFACT_URI_PREFIX = "artifact://";
export const ARTIFACT_URI_RE = /artifact:\/\/([A-Za-z\d_-]{1,128})/gu;
export const SESSION_EXPORT_CSP =
  "default-src 'none'; script-src 'sha256-y2serMhEYeLnyrXKZDp45QIn5hl5TBywKuaFmEDipzY='; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const SENSITIVE_KEY_RE =
  /(?:authorization|api[_-]?key|token|secret|password|cookie|credential|environment|^env$)/iu;
export const SENSITIVE_TEXT_RE =
  /\b(?:Bearer\s+[A-Za-z\d._~+/-]+=*|(?:sk|sess|ghp|github_pat)[_-][A-Za-z\d_-]+)|((?:api[_-]?key|token|secret|password|cookie|authorization)["']?\s*[:=]\s*["']?)[^\s,;"']+/giu;
export const ABSOLUTE_PATH_RE =
  /(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|private|var|etc)\/)[^\s"'<>]+/gu;
export const REDACTED_TEXT = "[REDACTED]";
export const EXPORT_REDACTION_NOTICE =
  "Best-effort redaction only. Review free text and attachments before sharing; no data is uploaded.";
export const PERSISTED_OUTPUT_PATH_RE =
  /(<persisted-output>[\s\S]*?Full content saved to:\n)([^\n]+)(\n)/gu;
export const MAX_SESSION_SEARCH_CHARS = 512;
export const MAX_SESSION_SEARCH_TERMS = 32;
export const SESSION_SEARCH_TOO_LONG = "Session search exceeds 512 characters.";
export const SESSION_SEARCH_TOO_MANY_TERMS = "Session search exceeds 32 terms.";
export const SESSION_SEARCH_WHITESPACE_RE = /\s+/u;
export const SESSION_NAME_WHITESPACE_RE = /\s+/gu;
export const SESSION_FILTER_PREFIXES = {
  name: "name:",
  tag: "tag:",
  project: "project:",
};
export const SESSION_FILTER_EMPTY_VALUE =
  "Session search filters require a value.";
export const SESSION_TREE_COMMAND_MAX_CHARS = 4096;
export const SESSION_TREE_COMMAND_TOO_LONG =
  "Session tree command is too long.";
export const SESSION_TREE_SHOW_USAGE =
  "Usage: /tree [show] [--labeled-only | --all-labels] [query] [--summary [description]]";
export const SESSION_TREE_GO_USAGE =
  "Usage: /tree go <entry> [--summary [description]]";
export const SESSION_TREE_LABEL_USAGE = "Usage: /tree label <entry> [label]";
export const SESSION_TREE_FOLD_USAGE =
  "Usage: /tree <fold | unfold> <entry | --all>";
export const SESSION_TREE_ROLE_PREFIX = "role:";
export const SESSION_TREE_ROLES = new Set(["user", "assistant", "system"]);
export const SESSION_TREE_INVALID_ROLE =
  "Tree role must be user, assistant or system.";
export const SESSION_TREE_TOOL_MESSAGE = "(tool message)";
export const SESSION_INVALID_TAGS =
  "Tags must be nonempty text without control characters, at most 256 characters each and 64 tags total.";
export const SESSION_TAG_INVALID_RE = /[\p{Cc}\p{Cs}]/u;
export const SESSION_PICKER_ARCHIVED_LABEL = "archived";
export const SESSION_NAME_MAX_GRAPHEMES = 64;
export const SESSION_NAME_MAX_INPUT_CHARS = 4096;
export const SESSION_NAME_ELLIPSIS = "…";
export const SESSION_NAME_SURROGATE_RE = /\p{Cs}/gu;

export const SESSION_TRANSPORT_CHUNK_BYTES = 64 * 1024;
export const SESSION_TRANSPORT_TEXT_CHARS = 8 * 1024;
export const MAX_SESSION_RECORD_BYTES = 12 * 1024 * 1024;
export const MAX_SESSION_STREAM_BYTES = MAX_SESSION_BYTES;
export const MAX_SESSION_STRING_BYTES = 1024 * 1024;
export const UNSAFE_SESSION_TRANSFER_FILE =
  "Session transfer requires an absolute canonical path, real directories and a regular, unlinked file.";
export const SESSION_TRANSFER_TEMP_PREFIX = ".yukino-transfer-";

export const SESSION_LEASE_VERSION = 1;
export const SESSION_LEASE_SUFFIX = ".leases";
export const SESSION_LEASE_KINDS = [
  "foreground",
  "background",
  "vm",
  "warming",
] as const;
export const SESSION_LEASE_TOKEN_RE = /^[a-f\d]{64}$/u;
export const SESSION_LEASE_MAX_BYTES = 4096;
export const SESSION_LEASE_FILE_EXTENSION = ".json";
export const SESSION_LEASE_PENDING_RE = /^([1-9]\d*)-([a-f\d]{64})\.pending$/u;
export const SESSION_MAINTENANCE_VERSION = 1;
export const SESSION_MAINTENANCE_OPERATIONS = ["delete", "cleanup"] as const;
export const SESSION_MAINTENANCE_SUFFIX = ".maintenance-";
export const SESSION_MAINTENANCE_MAX_FILES = 10_000;
export const SESSION_MAINTENANCE_MAX_BYTES = 256 * 1024 * 1024;
export const SESSION_STORAGE_UNSAFE =
  "Session storage refuses links, hardlinks, foreign owners, special files, or path escape.";
export const SESSION_STORAGE_CHANGED =
  "Session storage source was replaced or changed.";
export const SESSION_LEASE_INVALID =
  "Session lease ownership cannot be verified.";
export const SESSION_LEASE_ACTIVE = "Session has an active process lease.";
export const SESSION_MAINTENANCE_CONFIRMATION =
  "Session maintenance requires explicit confirmation of this exact plan.";
export const SESSION_MAINTENANCE_STALE =
  "Session maintenance plan is stale or altered.";
export const SESSION_MAINTENANCE_UNKNOWN =
  "Session maintenance cannot prove exclusive ownership or complete references.";
export const SESSION_MAINTENANCE_REFERENCED =
  "Session or artifacts are referenced by another session; sources are preserved.";
export const SESSION_MAINTENANCE_LIMIT =
  "Session maintenance inspection limit exceeded.";

export const SESSION_VIEWER_FENCE_RE = /^(`{3,}|~{3,})([\w+-]{0,32})\s*$/u;
export const SESSION_VIEWER_MAX_INDENT = 16;
export const LOCAL_DIAGNOSTICS_MAX_BYTES = 64 * 1024;
export const LOCAL_DIAGNOSTICS_MAX_TEXT = 1024;
export const LOCAL_DIAGNOSTICS_MAX_ITEMS = 64;
export const LOCAL_DIAGNOSTICS_MAX_NODES = 256;
export const LOCAL_DIAGNOSTICS_TEXT_BUDGET = 4096;
export const LOCAL_DIAGNOSTICS_USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "reasoningTokens",
] as const;
export const LOCAL_DIAGNOSTICS_MAX_DEPTH = 8;
export const LOCAL_DIAGNOSTICS_OMITTED =
  "[omitted: diagnostics limit or non-data value]";
export const LOCAL_DIAGNOSTICS_USAGE =
  "Usage: /diagnostics [file] [--include-transcript]";
export const LOCAL_DIAGNOSTICS_CONFIGURATION_KEYS = [
  "source",
  "name",
  "model",
  "protocol",
  "thinking",
  "contextWindow",
  "maxOutputTokens",
];

export const SESSION_TREE_FILTERS = [
  "all",
  "no-tools",
  "user-only",
  "labeled-only",
] as const;

export const FILE_OPERATIONS_PORTABLE_PATH_RE =
  /^\[(?:workspace|local-path)\](?:[\\/].*)?$/u;
