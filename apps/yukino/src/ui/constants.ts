import type { NonPlanPermissionMode } from "@/permissions/index.js";
import { DARK_THEME, type ThemePalette } from "@/theme/constants.js";

export const THEME: ThemePalette = { ...DARK_THEME };

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

export const COMMAND_TAGS = ["[skill]", "[custom]"];

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
