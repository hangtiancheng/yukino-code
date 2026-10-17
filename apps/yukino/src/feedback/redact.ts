import { z } from "zod";

export const REDACTED = "<redacted>";

// Key names whose values must never leave the machine. camelCase is normalized
// to snake_case before matching so "apiKey" and "API_KEY" behave alike.
const SENSITIVE_KEY =
  /(?:^|[-_])(api[-_]?key|secret|token|password|passwd|credential|authorization|cookie|private[-_]?key)(?:$|[-_])/i;

const UnknownArraySchema = z.array(z.unknown());
const UnknownRecordSchema = z.record(z.string(), z.unknown());

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}

/** Strip credentials and secret-looking query parameters from a URL. */
export function redactUrl(value: string): string {
  // Unwrap nested URLs like "jdbc:postgresql://user:pass@host/db".
  const nested = /^([a-z][a-z0-9+.-]*:)([a-z][a-z0-9+.-]*:\/\/.*)$/i.exec(
    value,
  );
  if (nested) {
    return `${nested[1]}${redactUrl(nested[2])}`;
  }
  try {
    const url = new URL(value);
    let changed = false;
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
      changed = true;
    }
    for (const key of url.searchParams.keys()) {
      if (isSensitiveKey(key)) {
        url.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? url.toString() : value;
  } catch {
    return value;
  }
}

// Ordered: specific prefixes first so the generic sk- pattern cannot shadow them.
const TEXT_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/g, replacement: REDACTED },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, replacement: REDACTED },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, replacement: REDACTED },
  { pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g, replacement: REDACTED },
  { pattern: /\bgh[a-z]_[A-Za-z0-9_]{30,}/g, replacement: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: REDACTED },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replacement: REDACTED },
  {
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}/gi,
    replacement: `$1${REDACTED}`,
  },
];

/** Regex-based redaction for free text (transcripts, logs, issue bodies). */
export function redactText(
  text: string,
  secrets: readonly string[] = [],
): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) {
      out = out.replaceAll(secret, REDACTED);
    }
  }
  out = out.replace(
    /^([ \t]*)(["']?)([\w.-]+)\2:[ \t]*[|>][^\n]*\n((?:\1[ \t]+[^\n]*(?:\n|$))*)/gm,
    (match: string, indent: string, quote: string, key: string) =>
      isSensitiveKey(key)
        ? `${indent}${quote}${key}${quote}: "${REDACTED}"\n`
        : match,
  );
  out = out.replace(/\b[a-z][a-z0-9+.-]{0,63}:\/\/[^\s<>"'`]+/gi, (url) =>
    redactUrl(url),
  );
  out = out.replace(
    /(?<![\w.-])(["']?([\w.-]{1,128})["']?[ \t]*[:=][ \t]*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/g,
    (match: string, prefix: string, key: string, value: string) => {
      if (!isSensitiveKey(key)) {
        return match;
      }
      const quote = value.startsWith('"')
        ? '"'
        : value.startsWith("'")
          ? "'"
          : "";
      return `${prefix}${quote}${REDACTED}${quote}`;
    },
  );
  for (const { pattern, replacement } of TEXT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function secretValues(
  value: unknown,
  seen = new Set<unknown>(),
): string[] {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return [];
  }
  seen.add(value);
  return Object.entries(value).flatMap(([key, child]: [string, unknown]) =>
    isSensitiveKey(key) && typeof child === "string" && child
      ? [child]
      : secretValues(child, seen),
  );
}

function redactString(value: string): string {
  return redactText(redactUrl(value));
}

function redactValue(value: unknown, ancestors = new Set<unknown>()): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (ancestors.has(value)) {
    return "[Circular]";
  }
  const nestedAncestors = new Set(ancestors).add(value);
  const asArray = UnknownArraySchema.safeParse(value);
  if (asArray.success) {
    return asArray.data.map((item) => redactValue(item, nestedAncestors));
  }
  const asRecord = UnknownRecordSchema.safeParse(value);
  if (asRecord.success) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(asRecord.data)) {
      out[key] =
        child !== null && child !== undefined && isSensitiveKey(key)
          ? REDACTED
          : redactValue(child, nestedAncestors);
    }
    return out;
  }
  return value;
}

/** Deep-copy a JSON value while removing values that may contain credentials. */
export function redactJsonValue(value: unknown): unknown {
  return redactValue(value);
}

/**
 * Redact a JSONL document line by line. Malformed lines fall back to plain-text
 * redaction so nothing is silently dropped from the attachment.
 */
export function redactJsonLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        out.push(JSON.stringify(redactJsonValue(parsed)));
        continue;
      } catch {
        // fall through to text redaction
      }
    }
    out.push(redactText(line));
  }
  return out.join("\n");
}
