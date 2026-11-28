import { stripVTControlCharacters } from "node:util";

import { TOOL_ARGS_SUMMARY_CHARS } from "@/utils/constants.js";
import { isRecord } from "@/utils/record.js";

export * from "@/utils/cancel.js";
export * from "@/utils/concurrency.js";
export * from "@/utils/constants.js";
export * from "@/utils/file-scan.js";
export { asErrorString, asString } from "@/utils/format.js";
export * from "@/utils/frontmatter.js";
export * from "@/utils/paths.js";
export * from "@/utils/public-http.js";
export * from "@/utils/redact.js";
export * from "@/utils/slug.js";
export * from "@/utils/xml.js";

/**
 * Strips ANSI escape sequences and non-printable control characters and
 * normalizes line endings, so model/tool text can be embedded in plain-text
 * contexts (JSONL logs, the browser UI, single-line summaries).
 */
export function plainTerminalText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\r\n?/gu, "\n")
    .replace(/\p{Cc}/gu, (character) =>
      character === "\n" || character === "\t" ? character : "",
    );
}

/**
 * Convert message content blocks to a plain-text fallback; non-text blocks
 * are reduced to text-only summaries (no base64 payloads).
 */
export function contentToText(
  content: string | Record<string, unknown>[],
): string {
  if (typeof content === "string") {
    return content;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image" && isRecord(block.source)) {
      const mediaType =
        block.source.type === "base64" &&
        typeof block.source.media_type === "string"
          ? block.source.media_type
          : "image";
      parts.push(`[Image: ${mediaType}]`);
    } else if (
      block.type === "tool_reference" &&
      typeof block.tool_name === "string"
    ) {
      parts.push(`[Tool reference: ${block.tool_name}]`);
    } else if (block.type === "search_result") {
      const title =
        typeof block.title === "string" ? block.title : "search result";
      const source =
        typeof block.source === "string" ? ` (${block.source})` : "";
      const nested = Array.isArray(block.content)
        ? contentToText(block.content.filter(isRecord))
        : "";
      parts.push(`${title}${source}${nested ? `\n${nested}` : ""}`);
    } else if (block.type === "document") {
      const title = typeof block.title === "string" ? block.title : "document";
      parts.push(`[Document: ${title}]`);
    }
  }
  return parts.join("\n");
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.fromEntries(value.entries());
  }
  return {};
}

export function isObject(value: unknown) {
  return typeof value === "object" && value !== null;
}

export function strArg(
  args: Record<string, unknown>,
  key: string,
  fallback?: string | null,
): string {
  const v = args[key];
  if (typeof v === "string") {
    return v;
  }

  return fallback ?? "";
}

export function formatToolArgs(args: Record<string, unknown>): string {
  if (args.command) {
    return strArg(args, "command");
  }
  if (args.file_path) {
    return truncate(strArg(args, "file_path"), TOOL_ARGS_SUMMARY_CHARS);
  }
  if (args.pattern) {
    return truncate(strArg(args, "pattern"), TOOL_ARGS_SUMMARY_CHARS);
  }
  if (args.description) {
    return truncate(strArg(args, "description"), TOOL_ARGS_SUMMARY_CHARS);
  }
  return "";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
