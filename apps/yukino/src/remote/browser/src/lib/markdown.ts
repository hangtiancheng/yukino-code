import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ breaks: true, gfm: true });

/**
 * Parse markdown into a sanitized HTML string safe for `dangerouslySetInnerHTML`.
 *
 * We strip dangerous tags/attrs via DOMPurify even though the content comes
 * from the local agent — the model may echo untrusted file contents.
 */
export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false });
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
    ALLOWED_ATTR: ["href", "src", "alt", "title", "class"],
  });
}
