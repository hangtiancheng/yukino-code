import { createHash, createHmac } from "node:crypto";

export interface S3Credentials {
  accessKey: string;
  secretKey: string;
  region: string;
  sessionToken?: string;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
  /** Hex SHA-256 of the payload, or UNSIGNED-PAYLOAD. */
  contentSha256: string;
}

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

/** RFC 3986 percent-encoding used by AWS canonical requests. */
export function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function signingKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/** Encode an object key path, preserving "/" separators between segments. */
function encodeKeyPath(key: string): string {
  return key
    .split("/")
    .map((segment) => rfc3986Encode(segment))
    .join("/");
}

export interface BuildCanonicalUriOptions {
  bucket?: string;
  key?: string;
}

/**
 * Build the canonical (single-encoded) URI for a path-style S3 request.
 * The bucket and each key segment are RFC 3986 encoded; "/" in keys is kept.
 */
export function buildCanonicalUri({
  bucket,
  key,
}: BuildCanonicalUriOptions): string {
  let uri = "/";
  if (bucket) {
    uri += rfc3986Encode(bucket);
    if (key) uri += `/${encodeKeyPath(key)}`;
  } else if (key) {
    uri += encodeKeyPath(key);
  }
  return uri;
}

/**
 * Build the canonical query string: sort by key then value, RFC 3986 encode
 * both, and join. Repeated keys (arrays) expand to multiple pairs.
 */
export function buildCanonicalQuery(
  query: Record<string, string | number | boolean | Array<string | number>>,
): string {
  const pairs: Array<[string, string]> = [];
  for (const [rawKey, rawValue] of Object.entries(query)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      pairs.push([rfc3986Encode(rawKey), rfc3986Encode(String(value))]);
    }
  }
  pairs.sort(([ka, va], [kb, vb]) =>
    ka === kb
      ? va < vb
        ? -1
        : va > vb
          ? 1
          : 0
      : ka < kb
        ? -1
        : ka > kb
          ? 1
          : 0,
  );
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

export interface SignOptions {
  method: string;
  /** Absolute endpoint origin, e.g. http://localhost:9000 (no trailing slash). */
  endpoint: string;
  canonicalUri: string;
  query?: Record<string, string | number | boolean | Array<string | number>>;
  headers?: Record<string, string>;
  payload?: Buffer;
  credentials: S3Credentials;
  /** Sign with UNSIGNED-PAYLOAD instead of hashing the body. */
  unsignedPayload?: boolean;
  /** Service name; defaults to "s3". */
  service?: string;
  now?: Date;
}

/**
 * Produce an AWS Signature Version 4 signed request for an S3-compatible
 * endpoint. Returns the absolute URL, the headers to send (including
 * Authorization, x-amz-date and x-amz-content-sha256) and the payload hash.
 */
export function signRequest(options: SignOptions): SignedRequest {
  const {
    method,
    endpoint,
    canonicalUri,
    query = {},
    headers = {},
    payload = Buffer.alloc(0),
    credentials,
    unsignedPayload = false,
    service = "s3",
    now = new Date(),
  } = options;

  const base = new URL(endpoint);
  const host = base.host;
  const canonicalQuery = buildCanonicalQuery(query);
  const contentSha256 = unsignedPayload
    ? "UNSIGNED-PAYLOAD"
    : payload.length === 0
      ? EMPTY_SHA256
      : sha256Hex(payload);

  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);

  // Lowercase and merge caller headers with the mandatory signed headers.
  const signed: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    signed[key.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  }
  signed["host"] = host;
  signed["x-amz-content-sha256"] = contentSha256;
  signed["x-amz-date"] = amzDate;
  if (credentials.sessionToken) {
    signed["x-amz-security-token"] = credentials.sessionToken;
  }

  const signedHeaderNames = Object.keys(signed).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${signed[name]}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    contentSha256,
  ].join("\n");

  const credentialScope = `${dateStamp}/${credentials.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const key = signingKey(
    credentials.secretKey,
    dateStamp,
    credentials.region,
    service,
  );
  const signature = createHmac("sha256", key)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // Headers to actually send. `host` is set by the HTTP client from the URL, so
  // it is omitted here but was included in the canonical request above.
  const outHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(signed)) {
    if (name === "host") continue;
    outHeaders[name] = value;
  }
  outHeaders["authorization"] = authorization;

  const url = `${base.origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  return { url, headers: outHeaders, contentSha256 };
}
