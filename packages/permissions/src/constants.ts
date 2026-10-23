import { TEAMMATE_COORDINATION_TOOLS } from "@yukino.js/teams/constants.js";

import type { DangerousPattern } from "./index.js";

export const PERMISSIONS_RULES_FILENAME = "permissions.yaml";

/** Truncation cap for a single argument value in HITL action descriptions. */
export const MAX_ACTION_ARG_VALUE_CHARS = 80;

export const PATH_PATTERN_TRAVERSAL_ERROR =
  "Permission path patterns cannot traverse after a wildcard";

export const RULES_PARSE_ERROR = "Cannot parse permission rules";

export const ISOLATED_WORKTREE_CLAIM_ERROR =
  "Cannot claim an existing worktree for an isolated agent";

// Intentionally empty: no command patterns are currently classified as
// dangerous, so detectDangerous() never matches and the Layer-3 deny stays
// inert until patterns are added.
export const DANGEROUS_PATTERNS: DangerousPattern[] = [];

export const SAFE_PREFIXES: (string | RegExp)[] = [
  "echo", // Output only, no dangerous flags
  "printf", // xargs runs /usr/bin/printf (binary), not bash builtin — no -v support
  "wc", // Read-only counting, no dangerous flags
  "grep", // Read-only search, no dangerous flags
  "head", // Read-only, no dangerous flags
  "tail", // Read-only (including -f follow), no dangerous flags

  // Cross-platform commands from shared validation
  /^docker\s+(?:ps|images)(?:\s|$)/u,

  // Unix/bash-specific read-only commands (not shared because they don't exist in PowerShell)

  // Time and date
  "cal",
  "uptime",

  // File content viewing (relative paths handled separately)
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "strings",
  "hexdump",
  "od",
  "nl",

  // System info
  "id",
  "uname",
  "free",
  "df",
  "du",
  "locale",
  "groups",
  "nproc",

  // Path information
  "basename",
  "dirname",
  "realpath",

  // Text processing
  "cut",
  "paste",
  "tr",
  "column",
  "tac", // Reverse cat — displays file contents in reverse line order
  "rev", // Reverse characters in each line
  "fold", // Wrap lines to specified width
  "expand", // Convert tabs to spaces
  "unexpand", // Convert spaces to tabs
  "fmt", // Simple text formatter — output to stdout only
  "comm", // Compare sorted files line by line
  "cmp", // Byte-by-byte file comparison
  "numfmt", // Number format conversion

  // Path information (additional)
  "readlink", // Resolve symlinks — displays target of symbolic link

  // File comparison
  "diff",

  // true and false, used to silence or create errors
  "true",
  "false",

  // Misc. safe commands
  "sleep",
  "which",
  "type",
  "expr", // Evaluate expressions (arithmetic, string matching)
  "test", // Conditional evaluation (file checks, comparisons)
  "getconf", // Get system configuration values
  "seq", // Generate number sequences
  "tsort", // Topological sort
  "pr", // Paginate files for printing
];

// Per-tool argument field treated as the "content" for safe/dangerous checks and rule matching
export const CONTENT_FIELDS: Record<string, string> = {
  Bash: "command",
  PowerShell: "command",
  ComputerUse: "action",
  ReadFile: "file_path",
  LSP: "file_path",
  WebFetch: "url",
  TaskOutput: "task_id",
  WriteFile: "file_path",
  EditFile: "file_path",
  Glob: "pattern",
  Grep: "pattern",
  InstallSkill: "source",
};

export const FILE_TOOLS = new Set(["ReadFile", "WriteFile", "EditFile", "LSP"]);

export const PLAN_COORDINATION_TOOLS = new Set([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "Agent",
  "Goal",
  "TodoWrite",
  "TaskStop",
  "TeamCreate",
  "TeamDelete",
  ...TEAMMATE_COORDINATION_TOOLS,
]);

export const RULE_RE = /^(\w+|\*)\(([\s\S]+)\)$/;

export const COMPLEX_COMMANDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "select",
  "coproc",
  "!",
  "time",
  "eval",
  "exec",
  "source",
  ".",
  "command",
  "builtin",
  "env",
  "sudo",
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "pwsh",
  "powershell",
  "xargs",
  "find",
]);
