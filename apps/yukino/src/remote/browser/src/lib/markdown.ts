import DOMPurify from "dompurify";
import { Marked, type Token } from "marked";

const markdown = new Marked({ breaks: false, gfm: true });
const userMarkdown = new Marked({ breaks: false, gfm: true });
for (const parser of [markdown, userMarkdown]) {
  parser.use({
    renderer: {
      checkbox({ checked }) {
        return `<span class="task-marker">[${checked ? "x" : " "}]</span> `;
      },
    },
  });
}
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

export function tokenizeMarkdown(text: string, user = false) {
  const tokens = (user ? userMarkdown : markdown).lexer(text);
  let hasCode = false;
  let hasHtml = false;
  void markdown.walkTokens(tokens, (token) => {
    if (token.type === "code") {
      hasCode = true;
    }
    if (token.type === "html") {
      hasHtml = true;
    }
  });
  return {
    blocks:
      hasHtml && !user
        ? [tokens]
        : tokens
            .filter((token) => token.type !== "space")
            .map((token) => [token]),
    references: JSON.stringify(tokens.links),
    hasCode,
  };
}

export function renderMarkdownBlock(tokens: Token[], user = false): string {
  const raw = (user ? userMarkdown : markdown).parser(tokens);
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
