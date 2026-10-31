import { CUSTOM_COMMAND_TAG } from "@/commands/constants.js";
import type { ThinkingLevel } from "@/config/provider-config.js";
import type { NonPlanPermissionMode } from "@/permissions/index.js";
import { DARK_THEME, type ThemePalette } from "@/theme/constants.js";
import type { ModelPickerState } from "@/ui/model-select.js";

export const THEME: ThemePalette = { ...DARK_THEME };

export const AGENTS_DIALOG_TITLE = "Agents & tasks";
export const AGENTS_DIALOG_SUBTITLE = "teammates and running background tasks";
export const AGENTS_DIALOG_EMPTY = "No teammates or running background tasks";

export const ICONS = {
  active: "◉",
  arrow: "→" satisfies "→" | "←",
  branch: "├─",
  collapsed: "⊞",
  expanded: "⊟",
  inactive: "○",
  lastBranch: "└─",
  prompt: ">",
  success: "✓",
  error: "✗",
  tree: "│",
} as const;

export const COMMAND_TAGS = ["[skill]", CUSTOM_COMMAND_TAG];

// @-mention cache lifetime: covers edits made outside the app (user editor,
// git) that produce no fileFactsVersion bump.
export const FILE_CACHE_TTL_MS = 30_000;

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

export const PERMISSION_MODE_CYCLE: NonPlanPermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
];

export const MODE_DISPLAY: Record<string, string> = {
  default: "Default",
  acceptEdits: "Accept Edits",
  plan: "Plan",
  bypassPermissions: "YOLO",
};

// Maximum number of recent tool names (deduplicated) passed to the memory recall selector
export const MAX_RECENT_TOOLS = 10;

export const MARKER =
  /\[paste #\d+ (?:\+\d+ lines|\d+ chars)\]|\[Image #\d+\]/g;

/**
 * An scp-style remote, as in `git clone git@github.com:owner/repo.git`.
 *
 * GFM's inline url rule autolinks the `user@host` part as an email address,
 * splitting the remote into a mailto link token (styled as a link, and a
 * clickable OSC-8 hyperlink where the terminal supports it) and a dangling
 * `:owner/repo.git` text tail. Claiming the pattern before that rule sees it
 * keeps such remotes verbatim as plain text; the colon has to be followed by
 * a non-space character, so ordinary addresses such as
 * "foo@example.com: see the docs" still autolink.
 */
export const SCP_STYLE_REMOTE =
  /^[A-Za-z0-9._+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+:(?=\S)/u;

export const PERMISSION_OPTIONS: {
  label: string;
  action: "allow" | "deny" | "allowAlways";
}[] = [
  { label: "Yes", action: "allow" },
  {
    label: "Yes, remember the scopes above for all agents in this project",
    action: "allowAlways",
  },
  { label: "No", action: "deny" },
];

export const PLAN_APPROVAL_OPTIONS = [
  "Yes, enter YOLO mode (auto-approve all)",
  "Yes, manually approve edits",
  "Tell Yukino what to change",
];

export const PROTOCOLS = ["anthropic", "openai", "openai-compat"] as const;

export const RESTORE_OPTIONS = [
  "Restore code and conversation",
  "Restore conversation only",
  "Restore code only",
  "Never mind",
];

/** Focus sentinel for the free-text row; never a real model id. */
export const OTHER = "\u0000other";
export const OTHER_LABEL = "Other (type your own)";

export const TAB_SIZE = 2;

export const OSC_BACKGROUND = "\x1b]11;";
export const COLOR_SCHEME = "\x1b[?997;";
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

export const BSU = "\x1b[?2026h"; // Begin Synchronized Update
export const ESU = "\x1b[?2026l"; // End Synchronized Update

/** TERM_PROGRAM values whose terminal emulator implements synchronized output. */
export const SYNC_OUTPUT_TERM_PROGRAMS = new Set([
  "alacritty",
  "contour",
  "ghostty",
  "iTerm.app",
  "vscode",
  "WarpTerminal",
  "WezTerm",
]);

/** One space of padding on each side of a cell, in terminal columns. */
export const CELL_PADDING = 2;

export const STATUS_MESSAGES: Record<
  Exclude<ModelPickerState["status"], "ready">,
  string
> = {
  loading: "Fetching models…",
  empty: "No models returned by this provider",
  error: "Model discovery failed for this provider",
};

export const CLIENT_NOT_READY = "Client not ready.";

export const TERMINAL_TOO_SHORT = "Terminal too short";

export const USER_BASH_PROGRESS_EXCLUDED =
  "User command · excluded in next model context";
export const USER_BASH_PROGRESS_INCLUDED =
  "User command · included in next model context";

export const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "Reasoning off",
  minimal: "Brief reasoning",
  low: "Light reasoning",
  medium: "Balanced reasoning",
  high: "Deep reasoning",
  xhigh: "Extra-deep reasoning",
  max: "Most thorough reasoning",
};
