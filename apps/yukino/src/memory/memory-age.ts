/**
 * Memory freshness calculation and staleness reminders. Memories at least
 * 2 days old are rendered with a note instructing the model that the memory
 * may be stale and should be verified before use.
 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
}

export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d === 0) {
    return "today";
  }
  if (d === 1) {
    return "yesterday";
  }
  return `${String(d)} days ago`;
}

export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d <= 1) {
    return "";
  }
  return `Saved ${String(d)} days ago; not live state. Code behavior and file:line citations may be stale. Verify against current code before asserting facts.`;
}
