import ansiEscapes from "ansi-escapes";
import chalk from "chalk";
import Table from "cli-table3";
import { Marked } from "marked";
import type { TokenizerExtension } from "marked";
import { markedTerminal } from "marked-terminal";
import supportsHyperlinks from "supports-hyperlinks";

import { SCP_STYLE_REMOTE, THEME } from "@/ui/constants.js";
import { highlightCode } from "@/ui/syntax-highlight.js";
import {
  visibleWidth,
  wrapToLines,
  wrapWordsToLines,
} from "@/ui/terminal-text.js";
import { plainTerminalText } from "@/utils/index.js";

chalk.level = 3;

type MarkdownKind = "assistant" | "user" | "thinking";

const scpStyleRemote: TokenizerExtension = {
  name: "scp-style-remote",
  level: "inline",
  tokenizer(source) {
    const remote = SCP_STYLE_REMOTE.exec(source);
    if (!remote) {
      return undefined;
    }
    return { type: "text", raw: remote[0], text: remote[0] };
  },
};

function createMarkdown(width: number, kind: MarkdownKind, streaming = false) {
  const textColor =
    kind === "thinking"
      ? THEME.thinkingText
      : kind === "user"
        ? THEME.userMessageText
        : THEME.text;
  const terminal = markedTerminal({
    blockquote: (value) =>
      value
        .trimEnd()
        .split("\n")
        .flatMap((line) =>
          wrapWordsToLines(line.trimStart(), Math.max(1, width - 2)).map(
            (wrapped) =>
              `${chalk.hex(THEME.mdQuoteBorder)("│")} ${chalk.italic.hex(THEME.mdQuote)(wrapped)}`,
          ),
        )
        .join("\n"),
    code: chalk.hex(THEME.mdCodeBlock),
    codespan: chalk.hex(THEME.mdCode),
    del: chalk.strikethrough.hex(THEME.dim),
    em: chalk.italic,
    hr: chalk.hex(THEME.mdHr),
    href: chalk.underline.hex(THEME.mdLinkUrl),
    link: chalk.hex(THEME.mdLink),
    listitem: chalk.hex(textColor),
    paragraph: chalk.hex(textColor),
    reflowText: false,
    emoji: false,
    showSectionPrefix: false,
    strong: chalk.bold,
    tab: 2,
    table: chalk.hex(textColor),
    text: chalk.hex(textColor),
    width,
  });
  const markdown = new Marked({ breaks: false, gfm: true });
  markdown.use(terminal);
  markdown.use({ extensions: [scpStyleRemote] });
  markdown.use({
    renderer: {
      heading(token) {
        const color = chalk.hex(THEME.mdHeading);
        const heading =
          token.depth === 1
            ? color.bold.underline
            : token.depth === 2
              ? color.bold
              : token.depth === 3
                ? color.bold.italic
                : color.italic;
        return `${heading(this.parser.parseInline(token.tokens))}\n\n`;
      },
      code(token) {
        if (streaming) {
          const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(token.raw)?.[1];
          const lastLine = token.raw.split("\n").at(-1);
          if (
            opening &&
            lastLine &&
            lastLine.length < opening.length &&
            Array.from(lastLine).every((character) => character === opening[0])
          ) {
            token = {
              ...token,
              text: token.text.slice(0, -lastLine.length).replace(/\n$/u, ""),
            };
          }
        }
        const language = token.lang?.trim().split(/\s+/u)[0];
        let body = token.text
          .split("\n")
          .map((line) => "  " + chalk.hex(THEME.mdCodeBlock)(line))
          .join("\n");
        const highlighted = highlightCode(token.text, language);
        if (highlighted !== undefined) {
          body = highlighted
            .split("\n")
            .map((line) => "  " + line)
            .join("\n");
        }
        const border = chalk.hex(THEME.mdCodeBlockBorder);
        return `${border("```" + (token.lang ?? ""))}\n${body.trimEnd()}\n${border("```")}\n\n`;
      },
      list(token) {
        return (
          token.items
            .map((item, index) => {
              const sourceMarker =
                kind === "user"
                  ? /^\s*(\d+[.)])\s/u.exec(item.raw)?.[1]
                  : undefined;
              const marker =
                sourceMarker ??
                (token.ordered
                  ? `${String(Number(token.start) + index)}.`
                  : "•");
              const prefix = item.task ? `[${item.checked ? "x" : " "}] ` : "";
              const body = prefix + this.parser.parse(item.tokens).trimEnd();
              const indent = visibleWidth(marker) + 1;
              return wrapWordsToLines(body, Math.max(1, width - indent))
                .map(
                  (line, lineIndex) =>
                    (lineIndex === 0
                      ? `${chalk.hex(THEME.mdListBullet)(marker)} `
                      : " ".repeat(indent)) + line,
                )
                .join("\n");
            })
            .join("\n") + "\n\n"
        );
      },
      codespan(token) {
        return chalk.hex(THEME.mdCode)(token.text);
      },
      link(token) {
        const text = this.parser.parseInline(token.tokens);
        const href = token.href.replace(/[\u0000-\u001f\u007f]/gu, "");
        if (/^javascript:/iu.test(href)) {
          return text;
        }
        if (supportsHyperlinks.stdout) {
          return chalk.hex(THEME.mdLink)(
            ansiEscapes.link(
              chalk.underline.hex(THEME.mdLinkUrl)(text || href),
              href.replace(/[ \t]/gu, "%20"),
            ),
          );
        }
        const target = chalk.underline.hex(THEME.mdLinkUrl)(href);
        return href === `mailto:${token.text}`
          ? chalk.underline.hex(THEME.mdLinkUrl)(text)
          : chalk.hex(THEME.mdLink)(
              text && text !== href ? `${text} (${target})` : target,
            );
      },
      table(token) {
        const count = token.header.length;
        const columnWidth = Math.floor(
          (width - count - 1) / Math.max(1, count),
        );
        if (columnWidth < 4) {
          return wrapToLines(token.raw.trimEnd(), width).join("\n") + "\n\n";
        }
        const cells = [token.header, ...token.rows].map((row) =>
          row.map((cell) =>
            wrapWordsToLines(
              this.parser.parseInline(cell.tokens),
              columnWidth - 2,
            ).join("\n"),
          ),
        );
        const table = new Table({
          head: cells[0],
          colWidths: Array.from({ length: count }, () => columnWidth),
          style: { head: [], border: [] },
        });
        table.push(...cells.slice(1));
        return chalk.hex(textColor)(table.toString()) + "\n\n";
      },
      text(token) {
        if (kind === "user" && token.type === "escape") {
          return chalk.hex(textColor)(token.raw);
        }
        return terminal.renderer?.text?.call(this, token) ?? "";
      },
    },
  });
  return markdown;
}

export function renderMarkdown(
  text: string,
  width: number,
  kind: MarkdownKind = "assistant",
): string {
  const rendered = createMarkdown(width, kind).parse(plainTerminalText(text), {
    async: false,
  });
  const wrapped = wrapToLines(rendered.trimEnd(), width).join("\n");
  return kind === "thinking" ? chalk.italic(wrapped) : wrapped;
}

export interface MarkdownCache {
  prefix: string;
  rendered: string;
  width: number;
  theme: string;
}

export function renderStreamingMarkdown(
  text: string,
  width: number,
  cache: MarkdownCache,
): string {
  const normalized = plainTerminalText(text);
  const markdown = createMarkdown(width, "assistant", true);
  const tokens = markdown.lexer(normalized);
  // Reference definitions can restyle earlier blocks, so they cannot use a prefix cache.
  if (Object.keys(tokens.links).length > 0) {
    cache.prefix = "";
    cache.rendered = "";
    return wrapToLines(
      markdown.parse(normalized, { async: false }).trimEnd(),
      width,
    ).join("\n");
  }
  const prefix = tokens
    .slice(0, -1)
    .map((token) => token.raw)
    .join("");
  const theme = JSON.stringify(THEME);
  if (
    cache.prefix !== prefix ||
    cache.width !== width ||
    cache.theme !== theme
  ) {
    cache.prefix = prefix;
    cache.rendered = wrapToLines(
      markdown.parse(prefix, { async: false }),
      width,
    ).join("\n");
    cache.width = width;
    cache.theme = theme;
  }
  const tail = markdown.parse(normalized.slice(prefix.length), {
    async: false,
  });
  return (cache.rendered + wrapToLines(tail, width).join("\n")).trimEnd();
}
