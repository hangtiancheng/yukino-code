const tokenFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatTokens(value: number): string {
  return tokenFormatter.format(Math.max(0, Math.round(value)));
}

export function asString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unprintable value]";
  }
}

export function asErrorString(value: unknown): string {
  return value instanceof Error ? value.message : asString(value);
}
