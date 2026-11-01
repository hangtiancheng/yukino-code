import { afterEach, describe, expect, it } from "vitest";

import { THINKING_LEVELS } from "@/config/constants.js";
import { DARK_THEME, LIGHT_THEME } from "@/theme/constants.js";
import { THEME } from "@/ui/constants.js";
import {
  activityStatusColor,
  setThemeMode,
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
  it.each([
    {
      flavor: "Mocha",
      palette: DARK_THEME,
      colors:
        "#f5e0dc #f2cdcd #f5c2e7 #cba6f7 #f38ba8 #eba0ac #fab387 #f9e2af #a6e3a1 #94e2d5 #89dceb #74c7ec #89b4fa #b4befe #cdd6f4 #bac2de #a6adc8 #9399b2 #7f849c #6c7086 #585b70 #45475a #313244 #1e1e2e #181825 #11111b",
    },
    {
      flavor: "Latte",
      palette: LIGHT_THEME,
      colors:
        "#dc8a78 #dd7878 #ea76cb #8839ef #d20f39 #e64553 #fe640b #df8e1d #40a02b #179299 #04a5e5 #209fb5 #1e66f5 #7287fd #4c4f69 #5c5f77 #6c6f85 #7c7f93 #8c8fa1 #9ca0b0 #acb0be #bcc0cc #ccd0da #eff1f5 #e6e9ef #dce0e8",
    },
  ])(
    "uses only exact official Catppuccin $flavor colors",
    ({ palette, colors }) => {
      const official = new Set(colors.split(" "));
      for (const color of Object.values<string>({ ...palette })) {
        expect(official.has(color), color).toBe(true);
      }
    },
  );
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

  it("detects the theme from COLORFGBG", () => {
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
