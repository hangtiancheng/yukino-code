import { stripVTControlCharacters } from "node:util";

import { createChildLogger } from "@/logger/index.js";
import { NUMERIC_LITERAL, TOOL_ARGS_SUMMARY_CHARS } from "@/utils/constants.js";

// Submodule namespaces for library consumers (Utils.<Sub>.*).
export * as Constants from "@/utils/constants.js";
export * as FileScan from "@/utils/file-scan.js";
export * as Paths from "@/utils/paths.js";
export * as PublicHttp from "@/utils/public-http.js";
export * as Redact from "@/utils/redact.js";
export * as Slug from "@/utils/slug.js";
export * as XML from "@/utils/xml.js";

const log = createChildLogger({ module: "utils" });

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function asString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return String(value);
}

export function asErrorString(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  return asString(value);
}

export function isObject(value: unknown) {
  return typeof value === "object" && value !== null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toTry<T extends (...args: any) => any>(
  fn: T,
  ctx?: ThisParameterType<T>,
) {
  if (typeof fn !== "function") {
    return fn;
  }
  return function (
    this: ThisParameterType<T>,
    ...args: Parameters<T>
  ): ReturnType<T> | undefined {
    let ret: ReturnType<T>;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      ret = ctx ? fn.call(ctx, ...args) : fn.call(this, ...args);
    } catch (err) {
      log.error({ err }, "utils operation failed");
      return undefined;
    }
    return ret;
  };
}

export const safeJSONParse = toTry(JSON.parse, JSON);

export function asError(err: unknown) {
  if (err instanceof Error) {
    return err;
  }
  return new Error(String(err));
}

// One contract for both JSON numbers and numeric strings: the value must be a
// finite, fully-parsed number, then it is truncated toward zero. Partial parses
// ("12abc"), NaN and Infinity fall back instead of leaking a half-parsed value,
// so the same logical value is accepted or rejected regardless of JSON type.
function toFiniteInt(v: unknown): number | undefined {
  let n: number;
  if (typeof v === "number") {
    n = v;
  } else if (typeof v === "string") {
    const s = v.trim();
    if (!NUMERIC_LITERAL.test(s)) {
      return undefined;
    }
    n = Number(s);
  } else {
    return undefined;
  }
  if (!Number.isFinite(n)) {
    return undefined;
  }
  return Math.trunc(n);
}

export function intArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  return toFiniteInt(args[key]) ?? fallback;
}
export function strList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === "string");
  }
  return [];
}

export function strArg(
  args: Record<string, unknown>,
  key: string,
  fallback?: string,
): string {
  const v = args[key];
  if (typeof v === "string") {
    return v;
  }

  return fallback ?? "";
}

export function boolArg(
  args: Record<string, unknown>,
  key: string,
  fallback?: boolean,
): boolean {
  const v = args[key];
  if (typeof v === "boolean") {
    return v;
  }
  if (typeof v === "string") {
    const normalized = v.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  if (typeof v === "number") {
    if (v === 1) {
      return true;
    }
    if (v === 0) {
      return false;
    }
  }
  return fallback ?? false;
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
