/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import chalk from "chalk";
import { supportsLanguage } from "cli-highlight";
import { Marked } from "marked";
import type { TokenizerExtension } from "marked";

import { visibleWidth, wrapToLines } from "./terminal-text.js";

import { markedTerminal } from "@/ui/marked-terminal.js";
import { THEME } from "@/ui/styles.js";

chalk.level = 3;

type MarkdownKind = "assistant" | "user" | "thinking";

/**
 * An scp-style remote, as in `git clone git@github.com:owner/repo.git`.
 *
 * GFM autolinks the `user@host` part as an email address, and the terminal
 * renderer then prints the mailto target next to it, turning the remote into
 * `git@github.com (mailto:git@github.com):owner/repo.git`. Claiming the pattern
 * before marked's inline url rule sees it keeps such remotes verbatim; the
 * colon has to be followed by a path, so ordinary addresses such as
 * "foo@example.com: see the docs" still autolink.
 */
const SCP_STYLE_REMOTE =
  /^[A-Za-z0-9._+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+:(?=\S)/u;

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
  const terminal = markedTerminal(
    {
      blockquote: (value) =>
        value
          .trimEnd()
          .split("\n")
          .map(
            (line) =>
              `${chalk.hex(THEME.mdQuoteBorder)("│")} ${chalk.italic.hex(THEME.mdQuote)(line.trimStart())}`,
          )
          .join("\n"),
      code: chalk.hex(THEME.mdCodeBlock),
      codespan: chalk.hex(THEME.mdCode),
      del: chalk.strikethrough.hex(THEME.dim),
      em: chalk.italic,
      firstHeading: chalk.bold.underline.hex(THEME.mdHeading),
      heading: chalk.bold.hex(THEME.mdHeading),
      hr: chalk.hex(THEME.mdHr),
      href: chalk.underline.hex(THEME.mdLinkUrl),
      link: chalk.hex(THEME.mdLink),
      listitem: chalk.hex(textColor),
      paragraph: chalk.hex(textColor),
      reflowText: true,
      sanitize: true,
      emoji: false,
      showSectionPrefix: false,
      strong: chalk.bold,
      tab: 2,
      table: chalk.hex(textColor),
      text: chalk.hex(textColor),
      width,
    },
    {
      language: "plaintext",
      theme: {
        addition: chalk.hex(THEME.toolDiffAdded),
        attr: chalk.hex(THEME.syntaxVariable),
        built_in: chalk.hex(THEME.syntaxType),
        class: chalk.hex(THEME.syntaxType),
        comment: chalk.hex(THEME.syntaxComment),
        default: chalk.hex(THEME.syntaxOperator),
        deletion: chalk.hex(THEME.toolDiffRemoved),
        function: chalk.hex(THEME.syntaxFunction),
        keyword: chalk.hex(THEME.syntaxKeyword),
        literal: chalk.hex(THEME.syntaxNumber),
        name: chalk.hex(THEME.syntaxFunction),
        number: chalk.hex(THEME.syntaxNumber),
        params: chalk.hex(THEME.syntaxVariable),
        string: chalk.hex(THEME.syntaxString),
        title: chalk.hex(THEME.syntaxFunction),
        type: chalk.hex(THEME.syntaxType),
        variable: chalk.hex(THEME.syntaxVariable),
      },
    },
  );
  const markdown = new Marked({ breaks: false, gfm: true });
  markdown.use(terminal);
  markdown.use({ extensions: [scpStyleRemote] });
  markdown.use({
    renderer: {
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
        if (language && supportsLanguage(language)) {
          const highlighted = terminal.renderer?.code?.call(this, {
            ...token,
            lang: language,
          });
          if (typeof highlighted === "string") {
            body = highlighted;
          }
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
              return wrapToLines(body, Math.max(1, width - indent))
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
      table(token) {
        const table = terminal.renderer?.table?.call(this, token);
        const rendered = typeof table === "string" ? table : token.raw;
        if (rendered.split("\n").every((line) => visibleWidth(line) <= width)) {
          return rendered;
        }
        return (
          chalk.hex(textColor)(
            wrapToLines(token.raw.trimEnd(), width).join("\n"),
          ) + "\n\n"
        );
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
  const rendered = createMarkdown(width, kind).parse(text, { async: false });
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
  const normalized = text.replace(/\r\n?/gu, "\n");
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
    cache.rendered = markdown.parse(prefix, { async: false });
    cache.width = width;
    cache.theme = theme;
  }
  const tail = markdown.parse(normalized.slice(prefix.length), {
    async: false,
  });
  return wrapToLines((cache.rendered + tail).trimEnd(), width).join("\n");
}
