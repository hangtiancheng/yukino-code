import {
  TERMINAL_COLOR_QUERY,
  TERMINAL_THEME_NOTIFICATIONS_OFF,
  TERMINAL_THEME_NOTIFICATIONS_ON,
  TERMINAL_THEME_QUERY,
  TERMINAL_THEME_TIMEOUT_MS,
} from "@/ui/constants.js";
import type { TerminalInput } from "@/ui/terminal-input.js";

export type TerminalTheme = "dark" | "light";

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

function parseChannel(channel: string): number | undefined {
  if (!/^[0-9a-f]{1,4}$/iu.test(channel)) {
    return undefined;
  }
  const max = 16 ** channel.length - 1;
  return max > 0
    ? Math.round((Number.parseInt(channel, 16) / max) * 255)
    : undefined;
}

export function parseTerminalColorSchemeReport(
  data: string,
): TerminalTheme | undefined {
  const match = /\x1b\[\?997;(1|2)n/u.exec(data);
  return match?.[1] === "2" ? "light" : match?.[1] === "1" ? "dark" : undefined;
}

export function parseOsc11BackgroundColor(data: string): RgbColor | undefined {
  return parseOscColor(data, 11);
}

function parseOscColor(data: string, code: 10 | 11): RgbColor | undefined {
  const match = /\x1b\](10|11);([^\x07\x1b]*)(?:\x07|\x1b\\)/iu.exec(data);
  if (match?.[1] !== String(code)) {
    return undefined;
  }
  const value = match[2]?.trim();
  if (!value) {
    return undefined;
  }

  if (/^#[0-9a-f]{6}$/iu.test(value)) {
    return {
      r: Number.parseInt(value.slice(1, 3), 16),
      g: Number.parseInt(value.slice(3, 5), 16),
      b: Number.parseInt(value.slice(5, 7), 16),
    };
  }

  const channels = value.replace(/^rgba?:/iu, "").split("/");
  if (channels.length !== 3) {
    return undefined;
  }
  const r = parseChannel(channels[0] ?? "");
  const g = parseChannel(channels[1] ?? "");
  const b = parseChannel(channels[2] ?? "");
  return r === undefined || g === undefined || b === undefined
    ? undefined
    : { r, g, b };
}

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function themeForRgb(
  { r, g, b }: RgbColor,
  foreground?: RgbColor,
): TerminalTheme {
  const luminance =
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b);
  const whiteContrast = 1.05 / (luminance + 0.05);
  const blackContrast = (luminance + 0.05) / 0.05;
  if (foreground) {
    const foregroundLuminance =
      0.2126 * channelLuminance(foreground.r) +
      0.7152 * channelLuminance(foreground.g) +
      0.0722 * channelLuminance(foreground.b);
    if (Math.abs(luminance - foregroundLuminance) > 0.05) {
      const theme = luminance > foregroundLuminance ? "light" : "dark";
      if ((theme === "dark" ? whiteContrast : blackContrast) >= 4.5) {
        return theme;
      }
    }
  }
  return blackContrast > whiteContrast ? "light" : "dark";
}

function ansiColor(index: number): RgbColor {
  if (index >= 232) {
    const value = 8 + (index - 232) * 10;
    return { r: value, g: value, b: value };
  }
  const cube = index - 16;
  const levels = [0, 95, 135, 175, 215, 255];
  return {
    r: levels[Math.floor(cube / 36)] ?? 0,
    g: levels[Math.floor((cube % 36) / 6)] ?? 0,
    b: levels[cube % 6] ?? 0,
  };
}

export function themeFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): TerminalTheme | undefined {
  const background = env.COLORFGBG?.split(";").at(-1)?.trim();
  if (
    !background ||
    !/^\d{1,3}$/u.test(background) ||
    Number(background) > 255
  ) {
    return undefined;
  }
  const index = Number(background);
  // ANSI slots are user-defined; bright black commonly represents a dark background.
  if (index < 16) {
    return index <= 6 || index === 8 ? "dark" : "light";
  }
  return themeForRgb(ansiColor(index));
}

export async function detectTerminalTheme(
  input: TerminalInput,
  {
    theme = "auto",
    timeoutMs = TERMINAL_THEME_TIMEOUT_MS,
  }: { theme?: "auto" | TerminalTheme; timeoutMs?: number } = {},
): Promise<TerminalTheme> {
  if (theme !== "auto") {
    return theme;
  }
  const environmentTheme = themeFromEnvironment();
  const stdin = input.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY) {
    return environmentTheme ?? "dark";
  }

  return new Promise((resolve) => {
    let background: RgbColor | undefined;
    let foreground: RgbColor | undefined;
    let colorScheme: TerminalTheme | undefined;
    let settled = false;

    const finish = (theme: TerminalTheme) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.off("terminal-response", onData);
      resolve(theme);
    };
    const onData = (report: string) => {
      colorScheme = parseTerminalColorSchemeReport(report) ?? colorScheme;
      background = parseOsc11BackgroundColor(report) ?? background;
      foreground = parseOscColor(report, 10) ?? foreground;
      if (background && foreground) {
        finish(themeForRgb(background, foreground));
      }
    };
    const timer = setTimeout(() => {
      finish(
        background
          ? themeForRgb(background, foreground)
          : (colorScheme ?? environmentTheme ?? "dark"),
      );
    }, timeoutMs);

    try {
      input.on("terminal-response", onData);
      process.stdout.write(TERMINAL_THEME_QUERY);
    } catch {
      finish(environmentTheme ?? "dark");
    }
  });
}

export function subscribeTerminalTheme(
  input: TerminalInput,
  onTheme: (theme: TerminalTheme) => void,
): () => void {
  if (!input.stdin.isTTY || !process.stdout.isTTY) {
    return () => undefined;
  }
  let background: RgbColor | undefined;
  let foreground: RgbColor | undefined;
  let scheme: TerminalTheme | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => {
    clearTimeout(timer);
    timer = undefined;
    const theme = background ? themeForRgb(background, foreground) : scheme;
    if (theme) {
      onTheme(theme);
    }
  };
  const onData = (report: string) => {
    const reportedScheme = parseTerminalColorSchemeReport(report);
    if (reportedScheme) {
      scheme = reportedScheme;
      background = undefined;
      foreground = undefined;
      clearTimeout(timer);
      timer = setTimeout(publish, TERMINAL_THEME_TIMEOUT_MS);
      process.stdout.write(TERMINAL_COLOR_QUERY);
      return;
    }
    background = parseOsc11BackgroundColor(report) ?? background;
    foreground = parseOscColor(report, 10) ?? foreground;
    if (background && foreground) {
      publish();
    } else {
      timer ??= setTimeout(publish, TERMINAL_THEME_TIMEOUT_MS);
    }
  };
  input.on("terminal-response", onData);
  process.stdout.write(TERMINAL_THEME_NOTIFICATIONS_ON + TERMINAL_THEME_QUERY);
  return () => {
    clearTimeout(timer);
    input.off("terminal-response", onData);
    process.stdout.write(TERMINAL_THEME_NOTIFICATIONS_OFF);
  };
}
