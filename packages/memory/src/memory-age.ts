import { MILLISECONDS_PER_DAY } from "./constants.js";

/** Memory age calculation and short display labels. */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / MILLISECONDS_PER_DAY));
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
