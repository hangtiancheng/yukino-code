export function getListWindowStart(
  itemCount: number,
  cursor: number,
  visibleCount: number,
): number {
  if (itemCount <= visibleCount) {
    return 0;
  }
  const clampedCursor = Math.max(0, Math.min(cursor, itemCount - 1));
  return Math.min(
    Math.max(0, clampedCursor - visibleCount + 1),
    itemCount - visibleCount,
  );
}
