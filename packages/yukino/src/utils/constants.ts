export const REDACTED = "<redacted>";

export const NUMERIC_LITERAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export const MAX_REDIRECTS = 5;
export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** HTTP statuses that never carry a response body, so the stream is not wrapped. */
export const NO_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** Key names whose values are treated as secrets and redacted from output. */
export const SENSITIVE_ENV_KEY_RE =
  /api[_-]?key|token|secret|password|private[_-]?key|credential|dsn/iu;
/** Bearer authorization value; the scheme prefix is captured so it survives redaction. */
export const BEARER_TOKEN_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu;

// IANA special-purpose IPv4 ranges and IPv6 blocks that must never be reached
// from a user-supplied URL.
export const BLOCKED_IPV4_SUBNETS: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
export const BLOCKED_IPV6_SUBNETS: readonly (readonly [string, number])[] = [
  ["::", 3],
  ["4000::", 2],
  ["8000::", 1],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
];

// Skill URL validation failures.
export const SKILL_URL_PROTOCOL_ERROR = "Skill URL must use HTTP or HTTPS";
export const SKILL_URL_CREDENTIALS_ERROR =
  "Skill URL must not contain credentials";
export const SKILL_URL_NON_PUBLIC_ERROR =
  "Skill URL resolves to a non-public network address";
export const SKILL_URL_UNREACHABLE_ERROR =
  "Skill URL has no reachable public address";
export const SKILL_URL_MISSING_LOCATION_ERROR =
  "Skill download redirect is missing a Location header";
export const PUBLIC_HTTP_BODY_UNSUPPORTED_ERROR =
  "fetchPublicHttpUrl does not support a request body";

export const MAX_SYMLINK_DEPTH = 40;
export const TOO_MANY_SYMLINKS_ERROR =
  "Too many symbolic links while resolving path";

export const DEFAULT_SCAN_MAX_FILES = 2000;
export const MIN_SCAN_VISITED_BUDGET = 2000;
export const SCAN_VISITED_BUDGET_MULTIPLIER = 10;
export const DEFAULT_FILE_MATCH_LIMIT = 8;

export const TOOL_ARGS_SUMMARY_CHARS = 80;
