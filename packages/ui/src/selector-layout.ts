export function selectorChrome(
  rows: number,
  subtitle: boolean,
  compact: boolean,
) {
  const borders = rows >= 6;
  const title = rows >= 2;
  const hint = rows >= 3;
  const detail = subtitle && rows >= 8;
  const gap = !compact && rows >= 10;
  return {
    borders,
    title,
    hint,
    detail,
    gap,
    height:
      Number(borders) * 2 +
      Number(title) +
      Number(hint) +
      Number(detail) +
      Number(gap),
  };
}
