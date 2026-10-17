import DOMPurify from "dompurify";
import { Marked } from "marked";

const markdown = new Marked({ breaks: false, gfm: true });
const userMarkdown = new Marked({ breaks: false, gfm: true });
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
userMarkdown.use({
  renderer: {
    html(token) {
      return escapeHtml(token.text);
    },
    text(token) {
      return token.type === "escape" ? escapeHtml(token.raw) : false;
    },
  },
});

/**
 * Parse markdown into a sanitized HTML string safe for `dangerouslySetInnerHTML`.
 *
 * We strip dangerous tags/attrs via DOMPurify even though the content comes
 * from the local agent — the model may echo untrusted file contents.
 */
export function renderMarkdown(text: string, user = false): string {
  const raw = (user ? userMarkdown : markdown).parse(text, { async: false });
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: [
      "p",
      "br",
      "strong",
      "em",
      "del",
      "code",
      "pre",
      "span",
      "ul",
      "ol",
      "li",
      "blockquote",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "a",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "hr",
      "img",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "start"],
  });
}
