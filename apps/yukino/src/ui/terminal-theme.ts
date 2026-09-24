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

import type { TerminalInput } from "./terminal-input.js";

export type TerminalTheme = "dark" | "light";

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

function parseChannel(channel: string): number | undefined {
  if (!/^[0-9a-f]+$/iu.test(channel)) {
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
  const match = /\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)/iu.exec(data);
  const value = match?.[1]?.trim();
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
  if (channels.length < 3) {
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

export function themeForRgb({ r, g, b }: RgbColor): TerminalTheme {
  const luminance =
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b);
  return luminance >= 0.5 ? "light" : "dark";
}

function ansiColor(index: number): RgbColor {
  const base: RgbColor[] = [
    { r: 0, g: 0, b: 0 },
    { r: 128, g: 0, b: 0 },
    { r: 0, g: 128, b: 0 },
    { r: 128, g: 128, b: 0 },
    { r: 0, g: 0, b: 128 },
    { r: 128, g: 0, b: 128 },
    { r: 0, g: 128, b: 128 },
    { r: 192, g: 192, b: 192 },
    { r: 128, g: 128, b: 128 },
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 255, b: 0 },
    { r: 255, g: 255, b: 0 },
    { r: 0, g: 0, b: 255 },
    { r: 255, g: 0, b: 255 },
    { r: 0, g: 255, b: 255 },
    { r: 255, g: 255, b: 255 },
  ];
  if (index < 16) {
    return base[index] ?? base[0];
  }
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
  const requested = env.YUKINO_THEME?.toLowerCase();
  if (requested === "dark" || requested === "light") {
    return requested;
  }
  const background = env.COLORFGBG?.split(";").findLast((part) =>
    /^\d+$/u.test(part.trim()),
  );
  if (!background) {
    return undefined;
  }
  return themeForRgb(ansiColor(Number.parseInt(background, 10)));
}

export async function detectTerminalTheme(
  input: TerminalInput,
  timeoutMs = 100,
): Promise<TerminalTheme> {
  const environmentTheme = themeFromEnvironment();
  if (environmentTheme) {
    return environmentTheme;
  }
  const stdin = input.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY || !stdin.setRawMode) {
    return "dark";
  }

  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    let backgroundTheme: TerminalTheme | undefined;
    let settled = false;

    const finish = (theme: TerminalTheme) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      input.off("terminal-response", onData);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        // The terminal may disappear during startup; theme selection can still complete.
      }
      resolve(theme);
    };
    const onData = (report: string) => {
      const colorScheme = parseTerminalColorSchemeReport(report);
      if (colorScheme) {
        finish(colorScheme);
        return;
      }
      const color = parseOsc11BackgroundColor(report);
      if (color) {
        backgroundTheme = themeForRgb(color);
      }
    };
    const timer = setTimeout(() => {
      finish(backgroundTheme ?? "dark");
    }, timeoutMs);

    try {
      stdin.setRawMode(true);
      input.on("terminal-response", onData);
      process.stdout.write("\x1b[?996n\x1b]11;?\x07");
    } catch {
      finish("dark");
    }
  });
}
