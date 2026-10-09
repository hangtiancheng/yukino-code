import ansiEscapes from "ansi-escapes";
import ansiRegex from "ansi-regex";
import chalk from "chalk";
import type {
  MarkedExtension,
  MarkedOptions,
  RendererObject,
  Tokens,
  Parser,
} from "marked";
import * as emoji from "node-emoji";
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import supportsHyperlinks from "supports-hyperlinks";

import { THEME } from "./styles.js";
import { highlightCode } from "./syntax-highlight.js";
import { fitTableToWidth, renderTable } from "./table-layout.js";

type StyleFn = (...text: string[]) => string;

export interface TerminalRendererOptions {
  code: StyleFn;
  blockquote: StyleFn;
  html: StyleFn;
  heading: StyleFn;
  firstHeading: StyleFn;
  hr: StyleFn;
  listitem: StyleFn;
  list: (body: string, ordered: boolean, indent: string) => string;
  table: StyleFn;
  paragraph: StyleFn;
  strong: StyleFn;
  em: StyleFn;
  codespan: StyleFn;
  del: StyleFn;
  link: StyleFn;
  href: StyleFn;
  text: StyleFn;
  image?: (href: string, title: string | null, text: string) => string;
  unescape: boolean;
  emoji: boolean;
  width: number;
  showSectionPrefix: boolean;
  reflowText: boolean;
  tab: number | string;
  sanitize: boolean;
}

const COLON_REPLACER = "*#COLON|*";
const COLON_REPLACER_REGEXP = new RegExp(escapeRegExp(COLON_REPLACER), "g");

const TAB_ALLOWED_CHARACTERS = ["\t"];

const ANSI_REGEXP: RegExp = ansiRegex();
const ANSI_SPLIT_REGEXP = new RegExp(`(${ANSI_REGEXP.source})`, "gu");
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

const HARD_RETURN = "\r";
const HARD_RETURN_RE = new RegExp(HARD_RETURN);
const HARD_RETURN_GFM_RE = new RegExp(HARD_RETURN + "|<br />");

const BULLET_POINT = "* ";
const BULLET_POINT_REGEX = "\\*";
const NUMBERED_POINT_REGEX = "\\d+\\.";
const POINT_REGEX =
  "(?:" + [BULLET_POINT_REGEX, NUMBERED_POINT_REGEX].join("|") + ")";

function asTabNumber(tab: number | string) {
  if (typeof tab === "number") {
    if (tab === 2 || tab === 4 || tab === 8) {
      return tab;
    }
    return 4;
  }

  const tabN = Number.parseInt(tab);
  if (Number.isNaN(tabN)) {
    return 4;
  }
  return asTabNumber(tabN);
}

const DEFAULT_TAB = 4;

// Built per renderer so THEME is only read at render time: evaluating these
// chalk styles at module load would freeze the palette before startup's
// setThemeMode applies the detected terminal theme.
function buildDefaultOptions(): TerminalRendererOptions {
  return {
    code: chalk.hex(THEME.mdCodeBlock),
    blockquote: chalk.italic.hex(THEME.mdQuote),
    html: chalk.hex(THEME.muted),
    heading: chalk.bold.hex(THEME.mdHeading),
    firstHeading: chalk.bold.underline.hex(THEME.mdHeading),
    hr: chalk.reset,
    listitem: chalk.reset,
    list: list,
    table: chalk.reset,
    paragraph: chalk.reset,
    strong: chalk.bold,
    em: chalk.italic,
    codespan: chalk.hex(THEME.mdCode),
    del: chalk.strikethrough.hex(THEME.dim),
    link: chalk.hex(THEME.mdLink),
    href: chalk.underline.hex(THEME.mdLinkUrl),
    text: identity,
    unescape: true,
    emoji: true,
    width: 80,
    showSectionPrefix: true,
    reflowText: false,
    tab: DEFAULT_TAB,
    sanitize: false,
  };
}

class Renderer {
  private readonly config: TerminalRendererOptions;
  private readonly tabStr: string;
  private readonly emojiFn: StyleFn;
  private readonly unescapeFn: StyleFn;
  private readonly transform: StyleFn;

  private parser: Parser | undefined;
  markedOptions: MarkedOptions | undefined;

  constructor(options?: Partial<TerminalRendererOptions>) {
    this.config = { ...buildDefaultOptions(), ...options };
    this.tabStr = sanitizeTab(this.config.tab, asTabNumber(DEFAULT_TAB));
    this.emojiFn = this.config.emoji ? insertEmojis : identity;
    this.unescapeFn = this.config.unescape ? unescapeEntities : identity;
    this.transform = compose(undoColon, this.unescapeFn, this.emojiFn);
  }

  setContext(parser: Parser, options: MarkedOptions): void {
    this.parser = parser;
    this.markedOptions = options;
  }

  private getParser(): Parser {
    if (this.parser === undefined) {
      throw new Error(
        "TerminalRenderer: parser not set. Call setContext() before rendering.",
      );
    }
    return this.parser;
  }

  private getMarkedOptions(this: {
    options?: MarkedOptions | undefined;
    markedOptions?: MarkedOptions | undefined;
  }): MarkedOptions {
    if (this.markedOptions !== undefined) {
      return this.markedOptions;
    }
    // When the renderer is passed directly to marked() (not via the
    // markedTerminal() extension), marked sets `renderer.options` and
    // `renderer.parser` dynamically instead of calling setContext().
    const fallback = this.options;
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(
      "TerminalRenderer: options not set. Call setContext() before rendering.",
    );
  }

  space(_token: Tokens.Space): "" {
    return "";
  }

  text(token: Tokens.Text | Tokens.Escape): string {
    if (token.type === "text" && token.tokens) {
      return this.getParser().parseInline(token.tokens);
    }
    return this.config.text(token.text);
  }

  code(token: Tokens.Code): string {
    return section(
      identify(this.tabStr, highlight(token.text, token.lang, this.config)),
    );
  }

  blockquote(token: Tokens.Blockquote): string {
    const quote = this.getParser().parse(token.tokens);
    return section(this.config.blockquote(identify(this.tabStr, quote.trim())));
  }

  html(token: Tokens.HTML | Tokens.Tag): string {
    return this.config.html(token.text);
  }

  heading(token: Tokens.Heading): string {
    let text = this.getParser().parseInline(token.tokens);
    text = this.transform(text);

    const prefix = this.config.showSectionPrefix
      ? "#".repeat(token.depth) + " "
      : "";
    text = prefix + text;

    if (this.config.reflowText) {
      text = reflowText(
        text,
        this.config.width,
        this.getMarkedOptions().gfm ?? false,
      );
    }

    return section(
      token.depth === 1
        ? this.config.firstHeading(text)
        : this.config.heading(text),
    );
  }

  hr(_token: Tokens.Hr): string {
    return section(
      this.config.hr(hr("-", this.config.reflowText && this.config.width)),
    );
  }

  list(token: Tokens.List): string {
    let body = "";
    for (const item of token.items) {
      body += this.listitem(item);
    }
    body = this.config.list(body, token.ordered, this.tabStr);
    return section(fixNestedLists(indentLines(this.tabStr, body), this.tabStr));
  }

  listitem(item: Tokens.ListItem): string {
    let text = "";

    if (item.task) {
      const checkbox = this.checkbox({
        type: "checkbox",
        raw: item.raw,
        checked: item.checked ?? false,
      });

      if (item.loose) {
        let modified = false;
        if (item.tokens.length > 0) {
          const firstToken = item.tokens[0];
          if (firstToken.type === "paragraph") {
            modified = true;

            firstToken.text = checkbox + " " + String(firstToken.text);
            if (firstToken.tokens && firstToken.tokens.length > 0) {
              const innerFirst = firstToken.tokens[0];
              if (innerFirst.type === "text") {
                innerFirst.text = checkbox + " " + String(innerFirst.text);
              }
            }
          }
        }
        if (!modified) {
          item.tokens.unshift({
            type: "text",
            raw: checkbox + " ",
            text: checkbox + " ",
          });
        }
      } else {
        text += checkbox + " ";
      }
    }

    text += this.getParser().parse(item.tokens);

    const transform = compose(this.config.listitem, this.transform);
    const isNested = text.includes("\n");
    if (isNested) {
      text = text.trim();
    }

    // Use BULLET_POINT as a marker for ordered or unordered list item
    return "\n" + BULLET_POINT + transform(text);
  }

  checkbox(token: Tokens.Checkbox): string {
    return "[" + (token.checked ? "X" : " ") + "] ";
  }

  paragraph(token: Tokens.Paragraph): string {
    let text = this.getParser().parseInline(token.tokens);
    const transform = compose(this.config.paragraph, this.transform);
    text = transform(text);

    if (this.config.reflowText) {
      text = reflowText(
        text,
        this.config.width,
        this.getMarkedOptions().gfm ?? false,
      );
    }

    return section(text);
  }

  table(token: Tokens.Table): string {
    const rows = [token.header, ...token.rows].map((row) =>
      row.map((cell) =>
        this.transform(this.getParser().parseInline(cell.tokens)),
      ),
    );

    const fitted = fitTableToWidth(
      rows,
      token.header.length,
      this.config.width,
    );

    return section(
      this.config.table(
        renderTable(fitted?.rows ?? rows, fitted?.columnWidths),
      ),
    );
  }

  strong(token: Tokens.Strong): string {
    const text = this.getParser().parseInline(token.tokens);
    return this.config.strong(text);
  }

  em(token: Tokens.Em): string {
    let text = this.getParser().parseInline(token.tokens);
    text = fixHardReturn(text, this.config.reflowText);
    return this.config.em(text);
  }

  codespan(token: Tokens.Codespan): string {
    const text = fixHardReturn(token.text, this.config.reflowText);
    const protectedText = this.config.emoji
      ? text.replace(/:/g, COLON_REPLACER)
      : text;
    return this.config.codespan(protectedText);
  }

  br(_token: Tokens.Br): string {
    return this.config.reflowText ? HARD_RETURN : "\n";
  }

  del(token: Tokens.Del): string {
    const text = this.getParser().parseInline(token.tokens);
    return this.config.del(text);
  }

  link(token: Tokens.Link): string {
    const href = token.href;
    const text = this.getParser().parseInline(token.tokens);

    if (this.config.sanitize) {
      try {
        const prot = decodeURIComponent(href)
          .replace(/[^\w:]/g, "")
          .toLowerCase();
        if (prot.startsWith("javascript:")) {
          return "";
        }
      } catch {
        return "";
      }
    }

    const hasText = text !== "" && text !== href;
    let out = "";

    if (supportsHyperlinks.stdout) {
      const linkText = text ? this.emojiFn(text) : href;
      const styledLink = this.config.href(linkText);
      out = ansiEscapes.link(styledLink, href.replace(/\+/g, "%20"));
    } else if (
      token.autolink &&
      token.text !== "" &&
      href === `mailto:${token.text}`
    ) {
      // An autolinked address is its own target, so appending the `mailto:`
      // destination in parentheses would only repeat the address.
      out = this.config.href(token.text);
    } else {
      if (hasText) {
        out += this.emojiFn(text) + " (";
      }
      out += this.config.href(href);
      if (hasText) {
        out += ")";
      }
    }

    return this.config.link(out);
  }

  image(token: Tokens.Image): string {
    if (this.config.image !== undefined) {
      return this.config.image(token.href, token.title, token.text);
    }
    let out = "![" + token.text;
    if (token.title) {
      out += " – " + token.title;
    }
    return out + "](" + token.href + ")\n";
  }

  def(_token: Tokens.Def): string {
    return "";
  }
}

export function markedTerminal(
  options?: Partial<TerminalRendererOptions>,
): MarkedExtension {
  const r = new Renderer(options);

  const renderer: RendererObject = {
    space() {
      r.setContext(this.parser, this.options);
      return "";
    },
    text(token) {
      r.setContext(this.parser, this.options);
      return r.text(token);
    },
    code(token) {
      r.setContext(this.parser, this.options);
      return r.code(token);
    },
    blockquote(token) {
      r.setContext(this.parser, this.options);
      return r.blockquote(token);
    },
    html(token) {
      r.setContext(this.parser, this.options);
      return r.html(token);
    },
    heading(token) {
      r.setContext(this.parser, this.options);
      return r.heading(token);
    },
    hr(token) {
      r.setContext(this.parser, this.options);
      return r.hr(token);
    },
    list(token) {
      r.setContext(this.parser, this.options);
      return r.list(token);
    },
    listitem(token) {
      r.setContext(this.parser, this.options);
      return r.listitem(token);
    },
    checkbox(token) {
      r.setContext(this.parser, this.options);
      return r.checkbox(token);
    },
    paragraph(token) {
      r.setContext(this.parser, this.options);
      return r.paragraph(token);
    },
    table(token) {
      r.setContext(this.parser, this.options);
      return r.table(token);
    },
    strong(token) {
      r.setContext(this.parser, this.options);
      return r.strong(token);
    },
    em(token) {
      r.setContext(this.parser, this.options);
      return r.em(token);
    },
    codespan(token) {
      r.setContext(this.parser, this.options);
      return r.codespan(token);
    },
    br(token) {
      r.setContext(this.parser, this.options);
      return r.br(token);
    },
    del(token) {
      r.setContext(this.parser, this.options);
      return r.del(token);
    },
    link(token) {
      r.setContext(this.parser, this.options);
      return r.link(token);
    },
    image(token) {
      r.setContext(this.parser, this.options);
      return r.image(token);
    },
    def(token) {
      r.setContext(this.parser, this.options);
      return r.def(token);
    },
  };

  return { renderer };
}

function textLength(str: string): number {
  // Column count, not UTF-16 length: CJK characters occupy two columns and
  // some emoji even more, so wrapping arithmetic must agree with what the
  // terminal actually renders.
  return stringWidth(str.replace(ANSI_REGEXP, ""));
}

function fixHardReturn(text: string, reflow: boolean): string {
  return reflow ? text.replace(HARD_RETURN_RE, "\n") : text;
}

function reflowText(text: string, width: number, gfm: boolean): string {
  const splitRe = gfm ? HARD_RETURN_GFM_RE : HARD_RETURN_RE;
  const sections = text.split(splitRe);
  const reflowed: string[] = [];

  for (const sectionStr of sections) {
    const fragments = sectionStr.split(ANSI_SPLIT_REGEXP);
    let column = 0;
    let currentLine = "";
    let lastWasEscapeChar = false;

    while (fragments.length > 0) {
      const fragment = fragments[0];

      if (fragment === "") {
        fragments.splice(0, 1);
        lastWasEscapeChar = false;
        continue;
      }

      if (textLength(fragment) === 0) {
        currentLine += fragment;
        fragments.splice(0, 1);
        lastWasEscapeChar = true;
        continue;
      }

      const words = fragment.split(/[ \t\n]+/);

      for (const word of words) {
        const addSpace = column !== 0 && !lastWasEscapeChar;
        const wordWidth = stringWidth(word);

        if (column + wordWidth + (addSpace ? 1 : 0) > width) {
          if (wordWidth <= width) {
            reflowed.push(currentLine);
            currentLine = word;
            column = wordWidth;
          } else {
            if (addSpace) {
              currentLine += " ";
              column++;
            }
            let remaining = word;
            while (remaining.length > 0) {
              const available = width - column;
              if (available <= 0) {
                reflowed.push(currentLine);
                currentLine = "";
                column = 0;
                continue;
              }
              const chunk = takeColumns(remaining, available);
              if (chunk.length === 0) {
                break;
              }
              currentLine += chunk;
              column += stringWidth(chunk);
              remaining = remaining.slice(chunk.length);
              if (remaining.length > 0) {
                reflowed.push(currentLine);
                currentLine = "";
                column = 0;
              }
            }
          }
        } else {
          if (addSpace) {
            currentLine += " ";
            column++;
          }
          currentLine += word;
          column += wordWidth;
        }

        lastWasEscapeChar = false;
      }

      fragments.splice(0, 1);
    }

    if (textLength(currentLine) > 0) {
      reflowed.push(currentLine);
    }
  }

  return reflowed.join("\n");
}

function takeColumns(text: string, width: number): string {
  const sliced = sliceAnsi(text, 0, width);
  if (sliced) {
    return sliced;
  }
  return (
    GRAPHEME_SEGMENTER.segment(text)[Symbol.iterator]().next().value?.segment ??
    ""
  );
}

function indentLines(indent: string, text: string): string {
  return text.replace(/(^|\n)(.+)/g, "$1" + indent + "$2");
}

function identify(indent: string, text: string): string {
  if (!text) {
    return text;
  }
  return indent + text.split("\n").join("\n" + indent);
}

// Prevents nested lists from joining their parent list's last line
function fixNestedLists(body: string, indent: string): string {
  const regex = new RegExp(
    "(\\S(?: |  )?)" + // Last char of current point, plus one or two spaces
      // to allow trailing spaces
      "((?:" +
      indent +
      ")+)" + // Indentation of sub point
      "(" +
      POINT_REGEX +
      "(?:.*)+)$",
    "gm",
  ); // Body of sub point
  return body.replace(regex, "$1\n" + indent + "$2$3");
}

function isPointedLine(line: string, indent: string): boolean {
  return new RegExp("^(?:" + indent + ")*" + POINT_REGEX).test(line);
}

function toSpaces(str: string): string {
  return " ".repeat(str.length);
}

function bulletPointLine(indent: string, line: string): string {
  return isPointedLine(line, indent) ? line : toSpaces(BULLET_POINT) + line;
}

function bulletPointLines(lines: string, indent: string): string {
  return lines
    .split("\n")
    .filter(identity)
    .map((line) => bulletPointLine(indent, line))
    .join("\n");
}

function numberedPoint(n: number): string {
  return String(n) + ". ";
}

function numberedLine(
  indent: string,
  line: string,
  num: number,
): { num: number; line: string } {
  if (isPointedLine(line, indent)) {
    return {
      num: num + 1,
      line: line.replace(BULLET_POINT, numberedPoint(num + 1)),
    };
  }
  return {
    num: num,
    line: toSpaces(numberedPoint(num)) + line,
  };
}

function numberedLines(lines: string, indent: string): string {
  let num = 0;
  return lines
    .split("\n")
    .filter(identity)
    .map((line) => {
      const result = numberedLine(indent, line, num);
      num = result.num;
      return result.line;
    })
    .join("\n");
}

function list(body: string, ordered: boolean, indent: string): string {
  const trimmed = body.trim();
  return ordered
    ? numberedLines(trimmed, indent)
    : bulletPointLines(trimmed, indent);
}

function section(text: string): string {
  return text + "\n\n";
}

function highlight(
  code: string,
  language: string | undefined,
  opts: TerminalRendererOptions,
): string {
  if (chalk.level === 0) {
    return code;
  }

  code = fixHardReturn(code, opts.reflowText);
  return highlightCode(code, language) ?? opts.code(code);
}

function insertEmojis(text: string): string {
  return text.replace(/:([A-Za-z0-9_\-+]+?):/g, (emojiString) => {
    const emojiSign = emoji.get(emojiString);
    if (emojiSign === undefined) {
      return emojiString;
    }
    return emojiSign + " ";
  });
}

function hr(inputHrStr: string, length: number | false): string {
  const cols = length || process.stdout.columns || 80;
  // Array(cols + 1): join inserts cols separators between the elements, so
  // an off-by-one here used to render one column fewer than requested.
  return new Array(cols + 1).join(inputHrStr);
}

function undoColon(str: string): string {
  return str.replace(COLON_REPLACER_REGEXP, ":");
}

function escapeRegExp(str: string): string {
  return str.replace(/[-[\]{}()*+?./\\^$|]/g, "\\$&");
}

function unescapeEntities(html: string): string {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function identity(str: string): string {
  return str;
}

function compose(
  ...funcs: ((text: string) => string)[]
): (text: string) => string {
  return (input: string): string => {
    let result = input;
    for (let i = funcs.length - 1; i >= 0; i--) {
      result = funcs[i](result);
    }
    return result;
  };
}

function isAllowedTabString(str: string): boolean {
  return TAB_ALLOWED_CHARACTERS.some((char) =>
    new RegExp("^(" + char + ")+$").test(str),
  );
}

function sanitizeTab(tab: number | string, fallbackTab: number): string {
  if (typeof tab === "number") {
    return " ".repeat(tab);
  } else if (typeof tab === "string" && isAllowedTabString(tab)) {
    return tab;
  }
  return " ".repeat(fallbackTab);
}
