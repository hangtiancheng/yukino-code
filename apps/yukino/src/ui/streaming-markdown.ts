import { Marked } from "marked";

const markdown = new Marked({ gfm: true });

export function stableStreamingPrefix(text: string): string {
  if (text.length < 2048 || /\[[^\]\n]+\](?!\()/u.test(text)) {
    return "";
  }
  const tokens = markdown.lexer(text);
  if (Object.keys(tokens.links).length > 0) {
    return "";
  }
  let last = tokens.length - 1;
  while (last >= 0 && tokens[last].type === "space") {
    last--;
  }
  // Keep the final block editable: a later delta can extend a list, table or fence.
  return tokens
    .slice(0, Math.max(0, last))
    .map((token) => token.raw)
    .join("");
}
