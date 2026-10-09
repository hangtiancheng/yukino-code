import type { ThinkingLevel } from "@/config/provider-config.js";

export interface ThemePalette {
  accent: string;
  bashMode: string;
  border: string;
  borderAccent: string;
  borderMuted: string;
  customMessageBg: string;
  customMessageLabel: string;
  dim: string;
  error: string;
  mdCode: string;
  mdCodeBlock: string;
  mdCodeBlockBorder: string;
  mdHeading: string;
  mdHr: string;
  mdLink: string;
  mdLinkUrl: string;
  mdListBullet: string;
  mdQuote: string;
  mdQuoteBorder: string;
  muted: string;
  searchMatchBg: string;
  searchMatchText: string;
  selectedBg: string;
  success: string;
  syntaxComment: string;
  syntaxFunction: string;
  syntaxKeyword: string;
  syntaxNumber: string;
  syntaxOperator: string;
  syntaxPunctuation: string;
  syntaxString: string;
  syntaxType: string;
  syntaxVariable: string;
  text: string;
  thinkingText: string;
  thinkingHigh: string;
  thinkingLow: string;
  thinkingMax: string;
  thinkingMedium: string;
  thinkingMinimal: string;
  thinkingOff: string;
  thinkingXHigh: string;
  toolDiffAdded: string;
  toolDiffContext: string;
  toolDiffRemoved: string;
  toolErrorBg: string;
  toolOutput: string;
  toolPendingBg: string;
  toolSuccessBg: string;
  toolTitle: string;
  customMessageText: string;
  userMessageText: string;
  userMessageBg: string;
  warning: string;
}

/**
 * Palette derived from pi-coding-agent's built-in `dark` theme. The source
 * tokens are authored in OKHSL; the values below are their sRGB equivalents so
 * the terminal renderer can emit them as 24-bit hex without a color-space
 * conversion at draw time.
 */
export const DARK_THEME: ThemePalette = {
  accent: "#a798d7",
  bashMode: "#5eb286",
  border: "#5fa8cc",
  borderAccent: "#a08ed5",
  borderMuted: "#768186",
  customMessageBg: "#3a3055",
  customMessageLabel: "#a798d7",
  dim: "#7e888e",
  error: "#ea7f81",
  mdCode: "#a798d7",
  mdCodeBlock: "#68b78d",
  mdCodeBlockBorder: "#9da5a9",
  mdHeading: "#cd9a22",
  mdHr: "#9da5a9",
  mdLink: "#69add0",
  mdLinkUrl: "#9da5a9",
  mdListBullet: "#a798d7",
  mdQuote: "#9da5a9",
  mdQuoteBorder: "#9da5a9",
  muted: "#9da5a9",
  searchMatchBg: "#4e2f1b",
  searchMatchText: "#9da5a9",
  selectedBg: "#213b49",
  success: "#68b78d",
  syntaxComment: "#9da5a9",
  syntaxFunction: "#cd9a22",
  syntaxKeyword: "#69add0",
  syntaxNumber: "#68b78d",
  syntaxOperator: "#9da5a9",
  syntaxPunctuation: "#9da5a9",
  syntaxString: "#de8d5a",
  syntaxType: "#a798d7",
  syntaxVariable: "#5db3ba",
  text: "#dee0e1",
  thinkingText: "#96a0a4",
  thinkingHigh: "#9776e5",
  thinkingLow: "#5489a4",
  thinkingMax: "#fe5462",
  thinkingMedium: "#6185cc",
  thinkingMinimal: "#68808d",
  thinkingOff: "#6c767b",
  thinkingXHigh: "#de54c1",
  toolDiffAdded: "#68b78d",
  toolDiffContext: "#9da5a9",
  toolDiffRemoved: "#ea7f81",
  toolErrorBg: "#5b282a",
  toolOutput: "#9da5a9",
  toolPendingBg: "#34383a",
  toolSuccessBg: "#254131",
  toolTitle: "#dee0e1",
  customMessageText: "#9da5a9",
  userMessageText: "#dee0e1",
  userMessageBg: "#213b49",
  warning: "#cd9a22",
};

/**
 * Palette derived from pi-coding-agent's built-in `light` theme, converted
 * from OKHSL to sRGB hex exactly like {@link DARK_THEME}.
 */
export const LIGHT_THEME: ThemePalette = {
  accent: "#7459b4",
  bashMode: "#40976c",
  border: "#3d8eb3",
  borderAccent: "#8a72cb",
  borderMuted: "#9aa2a7",
  customMessageBg: "#e6e4ee",
  customMessageLabel: "#7459b4",
  dim: "#879095",
  error: "#c8253d",
  mdCode: "#7459b4",
  mdCodeBlock: "#337e58",
  mdCodeBlockBorder: "#677176",
  mdHeading: "#8f6802",
  mdHr: "#677176",
  mdLink: "#2f7899",
  mdLinkUrl: "#677176",
  mdListBullet: "#7459b4",
  mdQuote: "#677176",
  mdQuoteBorder: "#677176",
  muted: "#677176",
  searchMatchBg: "#ede3dd",
  searchMatchText: "#677176",
  selectedBg: "#dfe7ec",
  success: "#337e58",
  syntaxComment: "#677176",
  syntaxFunction: "#8f6802",
  syntaxKeyword: "#2f7899",
  syntaxNumber: "#337e58",
  syntaxOperator: "#677176",
  syntaxPunctuation: "#677176",
  syntaxString: "#a45417",
  syntaxType: "#7459b4",
  syntaxVariable: "#287a81",
  text: "#3b3f41",
  thinkingText: "#7c868c",
  thinkingHigh: "#b5a5e8",
  thinkingLow: "#9fc2d5",
  thinkingMax: "#fe7479",
  thinkingMedium: "#a2b7e0",
  thinkingMinimal: "#b5c4cb",
  thinkingOff: "#c2c8ca",
  thinkingXHigh: "#e585cd",
  toolDiffAdded: "#337e58",
  toolDiffContext: "#677176",
  toolDiffRemoved: "#c8253d",
  toolErrorBg: "#eee2e1",
  toolOutput: "#677176",
  toolPendingBg: "#e4e5e6",
  toolSuccessBg: "#dee9e1",
  toolTitle: "#3b3f41",
  customMessageText: "#677176",
  userMessageText: "#3b3f41",
  userMessageBg: "#dfe7ec",
  warning: "#8f6802",
};

export const THEME: ThemePalette = { ...DARK_THEME };

export function setThemeMode(mode: "dark" | "light"): void {
  Object.assign(THEME, mode === "light" ? LIGHT_THEME : DARK_THEME);
}

export function thinkingLevelColor(level: ThinkingLevel): string {
  switch (level) {
    case "off":
      return THEME.thinkingOff;
    case "minimal":
      return THEME.thinkingMinimal;
    case "low":
      return THEME.thinkingLow;
    case "medium":
      return THEME.thinkingMedium;
    case "high":
      return THEME.thinkingHigh;
    case "xhigh":
      return THEME.thinkingXHigh;
    case "max":
      return THEME.thinkingMax;
  }
}

export type ActivityStatus =
  "idle" | "working" | "retry" | "compacting" | "error";

/**
 * Map an agent lifecycle state to a composer status-border color; the composer
 * colors idle/working with the active thinking level instead.
 */
export function activityStatusColor(status: ActivityStatus): string {
  switch (status) {
    case "working":
      return THEME.thinkingHigh;
    case "retry":
      return THEME.warning;
    case "compacting":
      return THEME.accent;
    case "error":
      return THEME.error;
    case "idle":
      return THEME.borderMuted;
  }
}

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
