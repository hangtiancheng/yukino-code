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

import type { ToolArgs } from "@fe/types";

/** Format a token count with K/M suffixes for compact display. */
export function formatTokens(n: number): string {
  if (n > 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n > 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return String(n);
}

/** Truncate long tool output for display. */
export function truncateOutput(output: string, max = 5000): string {
  if (output.length > max) {
    return `${output.slice(0, max)}\n... (truncated)`;
  }
  return output;
}

/** Pretty-print tool args as indented JSON, or empty string when absent. */
export function formatArgs(args: ToolArgs): string {
  if (!args) {
    return "";
  }
  return JSON.stringify(args, null, 2);
}

/** Extract a short, human-readable preview from well-known tool arg fields. */
export function argsPreview(args: ToolArgs): string {
  if (!args) {
    return "";
  }
  const candidates = ["command", "file_path", "pattern", "path"] as const;
  for (const key of candidates) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) {
      return v;
    }
  }
  return "";
}

/** Parse a `<think ...>...</think ...>` envelope embedded in streamed text.
 *  Returns the separated thinking and body fragments. */
export function splitThinking(text: string): {
  thinking: string;
  body: string;
} {
  const match = /^<think\s*>([\s\S]*?)<\/think\s*>\s*([\s\S]*)$/.exec(text);
  if (match) {
    return { thinking: match[1].trim(), body: match[2].trim() };
  }
  return { thinking: "", body: text };
}

/** Detect an open (not yet closed) `<think ...>` tag at the start of a stream. */
export function isOpenThinking(text: string): boolean {
  return /^<think\s*>/.test(text) && !/<\/think\s*>/.test(text);
}

/** Strip the leading `<think ...>` marker from an in-progress thinking stream. */
export function stripThinkOpen(text: string): string {
  return text.replace(/^<think\s*>\s*/, "");
}
