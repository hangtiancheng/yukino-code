export const REDACTED = "<redacted>";

export function environmentSecrets(): string[] {
  return Object.entries(process.env).flatMap(([key, value]) =>
    /api[_-]?key|token|secret|password|private[_-]?key|credential|dsn/iu.test(
      key,
    ) &&
    value &&
    value.length > 3
      ? [value, encodeURIComponent(value)]
      : [],
  );
}

export function redactCredentials(
  text: string,
  secrets: readonly string[] = environmentSecrets(),
  replacement = REDACTED,
): string {
  let out = text.replace(
    /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu,
    `$1${replacement}`,
  );
  for (const secret of [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    out = out.replaceAll(secret, replacement);
  }
  return out;
}
