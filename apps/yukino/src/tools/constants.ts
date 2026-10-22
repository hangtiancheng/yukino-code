import { TOOL_RESULT_PREVIEW_CHARS } from "@/tool-result/constants.js";

export const DEFAULT_TIMEOUT = 120;
export const MAX_TIMEOUT = 600;
// Grace period between SIGTERM and the SIGKILL escalation when terminating a command.
export const KILL_GRACE_MS = 3000;

export const DEFAULT_LIMIT = 2000;
export const MAX_READ_BYTES = 50 * 1024;
// Whole-file read admission cap (memory bound; see the fileStat.size check).
export const MAX_READ_FILE_BYTES = 10 * 1024 * 1024;

export const MAX_RESULTS = 500;
export const MAX_MATCH_LINE_BYTES = 2000;
export const BINARY_SNIFF_BYTES = 8 * 1024;
export const DEFAULT_MAX_TRAVERSED_ENTRIES = 10_000;
export const DEFAULT_MAX_TRAVERSAL_DEPTH = 25;
// Files above this size are skipped rather than buffered whole: reading a
// multi-GB file into memory would spike it and block the loop, and the 500-
// match cap means huge files rarely contribute anything the model needs.
export const MAX_GREP_FILE_BYTES = 25 * 1024 * 1024;
export const MATCH_MIN_TIMEOUT_MS = 2000;
export const MATCH_MAX_TIMEOUT_MS = 10000;

// JS regexes keep \w/\b/\d ASCII-only even in u-mode, unlike ripgrep whose
// defaults are Unicode-aware. Rewrite them to property-escape equivalents
// before compiling so "\w+" matches Chinese text and "\b" works next to CJK.
export const WORD = "\\p{L}\\p{M}\\p{N}_";
export const TOP_LEVEL = new Map<string, string>([
  ["w", `[${WORD}]`],
  ["W", `[^${WORD}]`],
  ["d", "\\p{Nd}"],
  ["D", "\\P{Nd}"],
  ["b", `(?:(?<![${WORD}])(?=[${WORD}])|(?<=[${WORD}])(?![${WORD}]))`],
  ["B", `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`],
]);
// Inside a character class \b means backspace and complements (\W/\D) can't
// be inlined without v-flag set operations, so only \w/\d are expanded.
export const IN_CLASS = new Map<string, string>([
  ["w", WORD],
  ["d", "\\p{Nd}"],
]);

export const MAX_SEARCH_OUTPUT_BYTES = 50 * 1024;
export const MAX_SHELL_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Notification body budget: larger outputs stay on disk and only a preview travels in the notification. */
export const BACKGROUND_NOTIFICATION_BYTES = 30_000;
export const SHELL_OUTPUT_PREVIEW_BYTES = TOOL_RESULT_PREVIEW_CHARS;
/** Disk cap for foreground and background commands, independent of display limits. */
export const MAX_SHELL_OUTPUT_FILE_BYTES = 5 * 1024 * 1024 * 1024;
export const SIZE_WATCHDOG_INTERVAL_MS = 500;

/** Tools that support background execution; Ctrl+B handling iterates this list. */
export const BACKGROUNDABLE_TOOL_NAMES = ["Bash", "PowerShell"] as const;

export const SKIP_DIRS = new Set([
  ".agents",
  ".git",
  ".yukino",
  ".next",
  ".venv",
  ".mypy_cache",
  "__pycache__",
  "dist",
  "node_modules",
]);

export const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export const ACTIONS = [
  "key",
  "hold_key",
  "type",
  "cursor_position",
  "mouse_move",
  "left_mouse_down",
  "left_mouse_up",
  "left_click",
  "left_click_drag",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "scroll",
  "wait",
  "screenshot",
  "zoom",
  "click",
  "drag",
  "keypress",
  "move",
] as const;

// OpenAI computer contract: instead of one action per call, the model sends an
// ordered batch of typed actions plus safety-check/status bookkeeping.
export const OPENAI_ACTION_TYPES = [
  "click",
  "double_click",
  "drag",
  "keypress",
  "move",
  "screenshot",
  "scroll",
  "type",
  "wait",
] as const;
export const MAX_BATCH_ACTIONS = 100;
export const COMMAND_TIMEOUT_MS = 15_000;
export const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;
export const MAX_SCREENSHOT_WIDTH = 1366;
export const MAX_SCREENSHOT_HEIGHT = 900;
export const COMPUTER_USE_BOTH_ACTIONS_ERROR =
  "Error: send either action (Anthropic-style, one action per call) or actions (OpenAI-style batch), not both.";
export const COMPUTER_USE_ACTION_REQUIRED_ERROR =
  "Error: action (Anthropic-style) or actions (OpenAI-style batch) is required.";
export const COMPUTER_USE_LOCKED_ERROR =
  "Error: the computer is being controlled by another Yukino call. Retry after it finishes.";

// Bound how much opened-document text a session retains. Without eviction the
// documents Map (and the language server's own copy) grows for every file ever
// queried over a long session.
export const MAX_CACHED_DOCUMENTS = 40;
export const MAX_CACHED_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const MAX_CACHED_DIAGNOSTIC_BYTES = 2 * 1024 * 1024;

export const LSP_OPERATIONS = [
  "definition",
  "references",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "implementation",
  "typeDefinition",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
  "diagnostics",
] as const;

export const CONTEXT_LINES = 3;
// Prevent excessively large diffs from overwhelming UI rendering and context window usage
export const MAX_DIFF_LINES = 200;

// Resource controls: cap a single response, the request timeout, and how much
// markdown reaches the model, so one fetch cannot overwhelm the session.
export const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 60_000;
export const MAX_MARKDOWN_LENGTH = 100_000;

// Fetched pages are cached per URL for 15 minutes (expired entries are dropped
// on access), bounded by a 50MB byte budget with oldest-first eviction.
export const CACHE_TTL_MS = 15 * 60 * 1000;
export const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024;

// grep, rg, findstr, diff, cmp, test, [, expr, find, robocopy
export const EXIT_CODE_HINTS = new Map<string, Map<number, string>>([
  // Search tools: exit 1 means "no match", not failure
  [
    "grep",
    new Map([
      [1, "no matches found"],
      [2, "error while searching"],
    ]),
  ],
  [
    "rg",
    new Map([
      [1, "no matches found"],
      [2, "error while searching"],
    ]),
  ],
  [
    "findstr",
    new Map([
      [1, "no matches found"],
      [2, "error while searching"],
    ]),
  ],
  // Comparison / condition tools: non-zero exit is informational
  [
    "diff",
    new Map([
      [1, "files differ"],
      [2, "trouble reading files"],
    ]),
  ],
  [
    "cmp",
    new Map([
      [1, "files differ"],
      [2, "trouble reading files"],
    ]),
  ],
  [
    "test",
    new Map([
      [1, "condition is false"],
      [2, "expression error"],
    ]),
  ],
  [
    "[",
    new Map([
      [1, "condition is false"],
      [2, "expression error"],
    ]),
  ],
  [
    "expr",
    new Map([
      [1, "expression is null or zero"],
      [2, "syntax error"],
    ]),
  ],
  [
    "find",
    new Map([[1, "partial success — some inputs could not be processed"]]),
  ],
  // Windows
  [
    "robocopy",
    new Map([
      [1, "success — files copied"],
      [2, "success — extra files or directories detected"],
      [4, "success — mismatched files detected"],
      [8, "some files failed to copy"],
      [16, "serious error — no files copied"],
    ]),
  ],
]);

// Shell-level exit codes that apply to any command
export const GENERIC_HINTS = new Map<number, string>([
  [126, "command found but not executable"],
  [127, "command not found"],
  [129, "terminated by SIGHUP"],
  [130, "terminated by SIGINT (Ctrl+C)"],
  [137, "killed by SIGKILL (often OOM)"],
  [141, "downstream consumer exited early (SIGPIPE)"],
  [143, "terminated by SIGTERM"],
]);

export const INTEGER_PATTERN = /^[+-]?\d+$/;
export const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export const COMMAND_REQUIRED_ERROR = "Error: command is required";
export const TIMEOUT_INVALID_ERROR =
  "Error: timeout must be a finite number greater than 0 seconds";
export const COMMAND_INTERRUPTED_ERROR = "Error: command interrupted";
export const SANDBOX_UNAVAILABLE_ERROR =
  "Error: sandbox is enabled but unavailable; command was not executed";
export const OPERATION_INTERRUPTED_ERROR = "Error: operation interrupted";
export const FILE_PATH_REQUIRED_ERROR = "Error: file_path is required";
export const OFFSET_LIMIT_INVALID_ERROR =
  "Error: offset must be >= 0 and limit must be >= 1";
export const PATTERN_REQUIRED_ERROR = "Error: pattern is required";
export const GREP_PATTERN_TIMEOUT_ERROR =
  "Error: the pattern timed out while matching (likely catastrophic backtracking). Simplify it — avoid nested quantifiers such as (a+)+ — or narrow the path/include filter.";
export const URL_REQUIRED_ERROR = "Error: url is required";
export const FETCH_INTERRUPTED_ERROR = "Error: fetch interrupted";
export const OUTPUT_REQUIRED_ERROR = "Error: output is required";
export const QUERY_REQUIRED_ERROR = "Error: query is required";
export const SLUG_INVALID_ERROR =
  "Error: slug must contain only alphanumeric, hyphen, underscore";
export const WORKTREE_RUNTIME_REQUIRED_ERROR =
  "Error: a runtime permission checker is required for worktree sessions";
export const QUESTION_COUNT_ERROR = "Error: must have 1-4 questions";
export const FILE_NOT_READ_ERROR =
  "Error: file has not been read yet, read it first before editing.";
export const FILE_DELETED_ERROR =
  "Error: file was deleted or is no longer accessible; read it again before editing.";
export const FILE_MODIFIED_ERROR =
  "Error: file has been modified since last read, read it again before editing.";
export const EXECUTION_CANCELLED_ERROR =
  "Tool execution was cancelled before it started.";
export const PLAN_MODE_UNAVAILABLE_ERROR =
  "Plan mode is unavailable because no permission context exists.";
export const PLAN_MODE_DELEGATED_ERROR =
  "EnterPlanMode cannot be used from delegated agents.";
export const NOT_IN_PLAN_MODE_CONTINUE_ERROR =
  "You are not in plan mode. Continue within the user's requested scope and current permissions, or call EnterPlanMode first when the task genuinely needs planning. AskUserQuestion is for clarification, not approval.";
export const NOT_IN_PLAN_MODE_ERROR =
  "You are not in plan mode. This tool is only for exiting plan mode after writing a plan.";
export const NO_PLAN_FILE_ERROR =
  "No non-empty plan file found. Write your plan to the declared plan file before calling ExitPlanMode.";
export const NO_PLAN_APPROVAL_HANDLER_ERROR =
  "No leader plan approval handler is available for this teammate.";
export const MCP_CALL_TOOL_REQUIRED = "McpCall requires a 'tool' name";
export const MCP_CALL_ARGUMENTS_REQUIRED =
  "McpCall requires an 'arguments' object matching the target schema";
export const GOAL_MAIN_SESSION_ONLY =
  "Goals belong to the main session and are unavailable to delegated agents.";
export const GOAL_UPDATE_REQUIRES_STATUS_REASON =
  "Updating a goal requires status and reason.";
export const GOAL_INVALID_STATUS_ERROR =
  "Goal update accepts only 'in_progress', 'complete', or 'blocked'. A goal is active as soon as the user sets it. Only the user can pause or resume a goal.";
export const GOAL_INVALID_ARGS_ERROR =
  "Goal expects action 'get' or 'update'. Updating requires status 'in_progress', 'complete', or 'blocked' and a non-empty reason; no other fields are accepted.";
export const LSP_DISPOSED_ERROR = "LSP tool is disposed";
export const LSP_INTERRUPTED_ERROR = "LSP operation interrupted";
export const LSP_SERVER_EXITED_ERROR =
  "LSP server exited; retry to start a fresh server";
export const LSP_DOCUMENT_TOO_LARGE_ERROR =
  "LSP requires a regular file no larger than 8MB";
export const LSP_POSITION_OUT_OF_RANGE_ERROR =
  "LSP position is outside the document";
export const LSP_FILE_TOO_LARGE_ERROR =
  "LSP requires a regular file no larger than 10MB";
