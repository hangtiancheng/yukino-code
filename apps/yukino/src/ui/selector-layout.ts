export function selectorChrome(rows: number, subtitle: boolean) {
  const borders = rows >= 6;
  const title = rows >= 2;
  const hint = rows >= 3;
  const detail = subtitle && rows >= 8;
  return {
    borders,
    title,
    hint,
    detail,
    height: Number(borders) * 2 + Number(title) + Number(hint) + Number(detail),
  };
}
