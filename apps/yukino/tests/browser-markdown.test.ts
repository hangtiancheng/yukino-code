import {
  renderMarkdownBlock,
  tokenizeMarkdown,
} from "@yukino.js/remote-browser/lib/markdown.js";
import { load } from "cheerio";
import { describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({
  default: { sanitize: (html: string) => html },
}));

function render(text: string, user = false) {
  const { blocks } = tokenizeMarkdown(text, user);
  return load(
    blocks
      .map((tokens) =>
        load(renderMarkdownBlock(tokens, user), {}, false).html(),
      )
      .join(""),
    {},
    false,
  );
}

describe("browser Markdown fragment boundaries", () => {
  it("keeps quote contents inside an HTML container across blank lines", () => {
    const $ = render(
      "<blockquote>\n\nhello **world**\n\n</blockquote>\n\nafter",
    );
    expect($("blockquote p").text()).toBe("hello world");
    expect($("blockquote strong").text()).toBe("world");
    expect($("blockquote + p").text()).toBe("after");
  });

  it("preserves raw HTML table sections, rows, and cells across blank lines", () => {
    const $ = render(
      "<table>\n\n<thead>\n\n<tr><th>Name</th></tr>\n\n</thead>\n\n<tbody>\n\n<tr><td>Yukino</td></tr>\n\n</tbody>\n\n</table>",
    );
    expect($("table thead tr th").text()).toBe("Name");
    expect($("table tbody tr td").text()).toBe("Yukino");
    expect($("table tr")).toHaveLength(2);
  });

  it("renders an unfinished HTML container correctly as streaming adds its closing tag", () => {
    const prefix = "<blockquote>\n\nfirst\n\n";
    for (const text of [prefix, `${prefix}second\n\n</blockquote>`]) {
      const $ = render(text);
      expect($("blockquote p").first().text()).toBe("first");
      if (text !== prefix) {
        expect($("blockquote p").last().text()).toBe("second");
      }
    }
  });

  it("keeps ordinary Markdown and code containing HTML in independent blocks", () => {
    const { blocks, hasCode } = tokenizeMarkdown(
      "# Heading\n\n```html\n<blockquote>hello</blockquote>\n```\n\nTail",
    );
    expect(blocks).toHaveLength(3);
    expect(hasCode).toBe(true);
    expect(blocks.map((tokens) => tokens.map((token) => token.type))).toEqual([
      ["heading"],
      ["code"],
      ["paragraph"],
    ]);
  });

  it("continues to escape user HTML", () => {
    const $ = render("<blockquote>\n\nhello\n\n</blockquote>", true);
    expect($("blockquote")).toHaveLength(0);
    expect($.text()).toContain("<blockquote>");
    expect($.text()).toContain("</blockquote>");
  });
});
