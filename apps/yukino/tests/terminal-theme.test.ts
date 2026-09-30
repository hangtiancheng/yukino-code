import { afterEach, describe, expect, it } from "vitest";

import { THINKING_LEVELS } from "@/config/provider-config.js";
import {
  activityStatusColor,
  DARK_THEME,
  LIGHT_THEME,
  setThemeMode,
  THEME,
  thinkingLevelColor,
} from "@/ui/styles.js";
import {
  parseOsc11BackgroundColor,
  parseTerminalColorSchemeReport,
  themeForRgb,
  themeFromEnvironment,
} from "@/ui/terminal-theme.js";

afterEach(() => {
  setThemeMode("dark");
});

describe("terminal theme detection", () => {
  it.each(["dark", "light"] satisfies ("dark" | "light")[])(
    "maps every thinking level to its existing %s token, independently of lifecycle status",
    (mode) => {
      setThemeMode(mode);
      const palette = mode === "dark" ? DARK_THEME : LIGHT_THEME;
      expect(THINKING_LEVELS.map(thinkingLevelColor)).toEqual([
        palette.thinkingOff,
        palette.thinkingMinimal,
        palette.thinkingLow,
        palette.thinkingMedium,
        palette.thinkingHigh,
        palette.thinkingXHigh,
        palette.thinkingMax,
      ]);
      expect(activityStatusColor("idle")).toBe(palette.borderMuted);
      expect(activityStatusColor("working")).toBe(palette.thinkingHigh);
      expect(activityStatusColor("retry")).toBe(palette.warning);
      expect(activityStatusColor("compacting")).toBe(palette.accent);
      expect(activityStatusColor("error")).toBe(palette.error);
    },
  );
  it("parses terminal color scheme and OSC 11 responses", () => {
    expect(parseTerminalColorSchemeReport("\u001B[?997;2n")).toBe("light");
    expect(parseTerminalColorSchemeReport("\u001B[?997;1n")).toBe("dark");
    expect(
      parseOsc11BackgroundColor("\u001B]11;rgb:ffff/ffff/ffff\u0007"),
    ).toEqual({
      r: 255,
      g: 255,
      b: 255,
    });
  });

  it("classifies terminal backgrounds by luminance", () => {
    expect(themeForRgb({ r: 248, g: 248, b: 248 })).toBe("light");
    expect(themeForRgb({ r: 24, g: 24, b: 30 })).toBe("dark");
  });

  it("honors explicit theme and COLORFGBG", () => {
    expect(themeFromEnvironment({ YUKINO_THEME: "light" })).toBe("light");
    expect(themeFromEnvironment({ COLORFGBG: "15;0" })).toBe("dark");
    expect(themeFromEnvironment({ COLORFGBG: "0;15" })).toBe("light");
  });

  it("updates message and tool backgrounds when switching themes", () => {
    setThemeMode("light");
    expect(THEME.userMessageBg).toBe(LIGHT_THEME.userMessageBg);
    expect(THEME.toolPendingBg).toBe(LIGHT_THEME.toolPendingBg);
    expect(THEME.userMessageText).toBe(LIGHT_THEME.userMessageText);
    expect(THEME.toolOutput).toBe(LIGHT_THEME.toolOutput);

    setThemeMode("dark");
    expect(THEME.userMessageBg).toBe(DARK_THEME.userMessageBg);
    expect(THEME.userMessageText).toBe(DARK_THEME.userMessageText);
  });

  it("uses semantic lifecycle colors for the status border", () => {
    setThemeMode("dark");
    expect(activityStatusColor("working")).toBe(DARK_THEME.thinkingHigh);
    expect(activityStatusColor("retry")).toBe(DARK_THEME.warning);
    expect(activityStatusColor("compacting")).toBe(DARK_THEME.accent);
    expect(activityStatusColor("error")).toBe(DARK_THEME.error);
    expect(activityStatusColor("idle")).toBe(DARK_THEME.borderMuted);

    setThemeMode("light");
    expect(activityStatusColor("retry")).toBe(LIGHT_THEME.warning);
  });
});
