import type { Key } from "ink";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Used by the provider, model and session selectors; action dialogs retain
// their own shortcuts.
export function updateSelectorQuery(
  query: string,
  input: string,
  key: Key,
): string {
  if (key.ctrl && input === "u") {
    return "";
  }
  if (
    key.ctrl ||
    key.meta ||
    key.super ||
    key.hyper ||
    key.tab ||
    key.escape ||
    key.return ||
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.pageUp ||
    key.pageDown ||
    key.home ||
    key.end
  ) {
    return query;
  }
  if (key.backspace || key.delete) {
    return Array.from(graphemes.segment(query), ({ segment }) => segment)
      .slice(0, -1)
      .join("");
  }
  if (input.includes("\u001b") || /\[<\d+;\d+;\d+[Mm]/.test(input)) {
    return query;
  }
  return query + input.replace(/[\r\n\t]+/g, " ").replace(/\p{Cc}/gu, "");
}
