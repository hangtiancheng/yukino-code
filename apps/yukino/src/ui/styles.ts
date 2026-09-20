/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { ThinkingLevel } from "@/config/index.js";

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
  thinking: string;
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

export const DARK_THEME: ThemePalette = {
  accent: "#8abeb7",
  bashMode: "#b5bd68",
  border: "#5f87ff",
  borderAccent: "#00d7ff",
  borderMuted: "#505050",
  customMessageBg: "#2d2838",
  customMessageLabel: "#9575cd",
  dim: "#666666",
  error: "#cc6666",
  mdCode: "#8abeb7",
  mdCodeBlock: "#b5bd68",
  mdCodeBlockBorder: "#808080",
  mdHeading: "#f0c674",
  mdHr: "#808080",
  mdLink: "#81a2be",
  mdLinkUrl: "#666666",
  mdListBullet: "#8abeb7",
  mdQuote: "#808080",
  mdQuoteBorder: "#808080",
  muted: "#808080",
  searchMatchBg: "#3a3a4a",
  searchMatchText: "#d4d4d4",
  selectedBg: "#3a3a4a",
  success: "#b5bd68",
  syntaxComment: "#6A9955",
  syntaxFunction: "#DCDCAA",
  syntaxKeyword: "#569CD6",
  syntaxNumber: "#B5CEA8",
  syntaxOperator: "#D4D4D4",
  syntaxPunctuation: "#D4D4D4",
  syntaxString: "#CE9178",
  syntaxType: "#4EC9B0",
  syntaxVariable: "#9CDCFE",
  text: "#d4d4d4",
  thinking: "#808080",
  thinkingText: "#808080",
  thinkingHigh: "#b294bb",
  thinkingLow: "#5f87af",
  thinkingMax: "#ff5fff",
  thinkingMedium: "#81a2be",
  thinkingMinimal: "#6e6e6e",
  thinkingOff: "#505050",
  thinkingXHigh: "#d183e8",
  toolDiffAdded: "#b5bd68",
  toolDiffContext: "#808080",
  toolDiffRemoved: "#cc6666",
  toolErrorBg: "#3c2828",
  toolOutput: "#808080",
  toolPendingBg: "#282832",
  toolSuccessBg: "#283228",
  toolTitle: "#d4d4d4",
  customMessageText: "#d4d4d4",
  userMessageText: "#d4d4d4",
  userMessageBg: "#343541",
  warning: "#ffff00",
};

export const LIGHT_THEME: ThemePalette = {
  accent: "#5a8080",
  bashMode: "#588458",
  border: "#547da7",
  borderAccent: "#5a8080",
  borderMuted: "#b0b0b0",
  customMessageBg: "#ede7f6",
  customMessageLabel: "#7e57c2",
  dim: "#767676",
  error: "#aa5555",
  mdCode: "#5a8080",
  mdCodeBlock: "#588458",
  mdCodeBlockBorder: "#6c6c6c",
  mdHeading: "#9a7326",
  mdHr: "#6c6c6c",
  mdLink: "#547da7",
  mdLinkUrl: "#767676",
  mdListBullet: "#588458",
  mdQuote: "#6c6c6c",
  mdQuoteBorder: "#6c6c6c",
  muted: "#6c6c6c",
  searchMatchBg: "#d0d0e0",
  searchMatchText: "#1f2328",
  selectedBg: "#d0d0e0",
  success: "#588458",
  syntaxComment: "#008000",
  syntaxFunction: "#795E26",
  syntaxKeyword: "#0000FF",
  syntaxNumber: "#098658",
  syntaxOperator: "#000000",
  syntaxPunctuation: "#000000",
  syntaxString: "#A31515",
  syntaxType: "#267F99",
  syntaxVariable: "#001080",
  text: "#1f2328",
  thinking: "#6c6c6c",
  thinkingText: "#6c6c6c",
  thinkingHigh: "#875f87",
  thinkingLow: "#547da7",
  thinkingMax: "#af005f",
  thinkingMedium: "#5a8080",
  thinkingMinimal: "#767676",
  thinkingOff: "#b0b0b0",
  thinkingXHigh: "#8b008b",
  toolDiffAdded: "#588458",
  toolDiffContext: "#6c6c6c",
  toolDiffRemoved: "#aa5555",
  toolErrorBg: "#f0e8e8",
  toolOutput: "#6c6c6c",
  toolPendingBg: "#e8e8f0",
  toolSuccessBg: "#e8f0e8",
  toolTitle: "#1f2328",
  customMessageText: "#1f2328",
  userMessageText: "#1f2328",
  userMessageBg: "#e8e8e8",
  warning: "#9a7326",
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

export type ActivityStatus = "idle" | "working" | "retry" | "compacting" | "error";

/** Map an agent lifecycle state to the color used by the composer status border. */
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
  tree: "│",
} as const;
