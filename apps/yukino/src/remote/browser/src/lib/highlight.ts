import { DARK_THEME, LIGHT_THEME } from "@yukino/theme/palette.js";
import { defaultSyntaxTheme } from "@yukino/theme/syntax.js";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "shiki/langs/bash.mjs";
import css from "shiki/langs/css.mjs";
import diff from "shiki/langs/diff.mjs";
import html from "shiki/langs/html.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import jsx from "shiki/langs/jsx.mjs";
import markdown from "shiki/langs/markdown.mjs";
import python from "shiki/langs/python.mjs";
import rust from "shiki/langs/rust.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import yaml from "shiki/langs/yaml.mjs";

const highlighter = createHighlighterCoreSync({
  engine: createJavaScriptRegexEngine(),
  themes: [
    defaultSyntaxTheme("dark", DARK_THEME.codeBg),
    defaultSyntaxTheme("light", LIGHT_THEME.codeBg),
  ],
  langs: [
    bash,
    css,
    diff,
    html,
    javascript,
    json,
    jsx,
    markdown,
    python,
    rust,
    tsx,
    typescript,
    yaml,
  ],
});

export function highlightMarkdown(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const code of template.content.querySelectorAll("pre > code")) {
    const language = /(?:^|\s)language-(\S+)/u
      .exec(code.className)?.[1]
      ?.toLowerCase();
    if (!language || !highlighter.getLoadedLanguages().includes(language)) {
      continue;
    }
    code.parentElement?.replaceWith(
      document.createRange().createContextualFragment(
        highlighter.codeToHtml(code.textContent, {
          lang: language,
          themes: { light: "yukino-light", dark: "yukino-dark" },
          defaultColor: false,
        }),
      ),
    );
  }
  return template.innerHTML;
}
