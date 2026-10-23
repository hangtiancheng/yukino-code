import type { ThinkingLevel } from "@yukino.js/config/provider-config.js";
import {
  DARK_THEME,
  LIGHT_THEME,
  type ThemeMode,
} from "@yukino.js/theme/constants.js";

import { THEME } from "./constants.js";

let themeMode: ThemeMode = "dark";

export function getThemeMode(): ThemeMode {
  return themeMode;
}

export function setThemeMode(mode: ThemeMode): void {
  themeMode = mode;
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
