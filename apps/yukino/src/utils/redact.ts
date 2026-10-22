import {
  BEARER_TOKEN_RE,
  REDACTED,
  SENSITIVE_ENV_KEY_RE,
} from "@/utils/constants.js";

export function environmentSecrets(): string[] {
  return Object.entries(process.env).flatMap(([key, value]) =>
    SENSITIVE_ENV_KEY_RE.test(key) && value && value.length > 3
      ? [value, encodeURIComponent(value)]
      : [],
  );
}

export function redactCredentials(
  text: string,
  secrets: readonly string[] = environmentSecrets(),
  replacement = REDACTED,
): string {
  let out = text.replace(BEARER_TOKEN_RE, `$1${replacement}`);
  for (const secret of [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    out = out.replaceAll(secret, replacement);
  }
  return out;
}
