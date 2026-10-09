import type { ToolArgs } from "@browser/types";

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

/** Parse a leading `<think>...</think>` envelope in streamed text.
 *  Returns the thinking content and the remaining body separately; text
 *  without the envelope is returned entirely as body. */
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
