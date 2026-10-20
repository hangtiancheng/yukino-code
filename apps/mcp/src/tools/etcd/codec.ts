/**
 * etcd's v3 JSON gateway maps proto3 `bytes` fields (keys, range ends and
 * values) to base64 strings. Sending a plain string such as "mykey" is either
 * rejected or, worse, silently decoded from base64 into unrelated bytes. These
 * helpers translate between human-friendly UTF-8 strings and the wire format so
 * callers can pass and read keys/values directly.
 */

const BYTES_FIELDS = new Set(["key", "range_end", "value"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `text` is exactly the standard base64 of some byte string. */
function isValidBase64(text: string): boolean {
  if (text.length === 0 || text.length % 4 !== 0) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    return false;
  }
  return Buffer.from(text, "base64").toString("base64") === text;
}

function decodeUtf8Strict(buffer: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

/**
 * Recursively base64-encode plain UTF-8 strings stored in `key`, `range_end`
 * and `value` fields of a request body. Non-string values and other fields are
 * left untouched. Strings that are already valid base64 are re-encoded from
 * their UTF-8 bytes (callers wanting verbatim base64 use raw_base64).
 */
export function encodeRequestBytes(body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map(encodeRequestBytes);
  }
  if (!isRecord(body)) {
    return body;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (BYTES_FIELDS.has(key) && typeof value === "string") {
      out[key] = Buffer.from(value, "utf8").toString("base64");
    } else {
      out[key] = encodeRequestBytes(value);
    }
  }
  return out;
}

/**
 * Recursively base64-decode `key`, `range_end` and `value` fields of a response
 * back to UTF-8 strings when they decode cleanly. Binary values that are not
 * valid UTF-8 are left as their base64 representation.
 */
export function decodeResponseBytes(data: unknown): unknown {
  if (Array.isArray(data)) {
    return data.map(decodeResponseBytes);
  }
  if (!isRecord(data)) {
    return data;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (
      BYTES_FIELDS.has(key) &&
      typeof value === "string" &&
      isValidBase64(value)
    ) {
      const decoded = decodeUtf8Strict(Buffer.from(value, "base64"));
      out[key] = decoded ?? value;
    } else {
      out[key] = decodeResponseBytes(value);
    }
  }
  return out;
}
