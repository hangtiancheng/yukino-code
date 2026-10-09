import chalk from "chalk";
import { createHighlighterCoreSync, isPlainLang } from "shiki/core";
import type { HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "shiki/langs/bash.mjs";
import c from "shiki/langs/c.mjs";
import clojure from "shiki/langs/clojure.mjs";
import coffeescript from "shiki/langs/coffeescript.mjs";
import consoleLang from "shiki/langs/console.mjs";
import cpp from "shiki/langs/cpp.mjs";
import csharp from "shiki/langs/csharp.mjs";
import css from "shiki/langs/css.mjs";
import csv from "shiki/langs/csv.mjs";
import dart from "shiki/langs/dart.mjs";
import diff from "shiki/langs/diff.mjs";
import dockerfile from "shiki/langs/dockerfile.mjs";
import elixir from "shiki/langs/elixir.mjs";
import erlang from "shiki/langs/erlang.mjs";
import fsharp from "shiki/langs/fsharp.mjs";
import go from "shiki/langs/go.mjs";
import graphql from "shiki/langs/graphql.mjs";
import groovy from "shiki/langs/groovy.mjs";
import haskell from "shiki/langs/haskell.mjs";
import hcl from "shiki/langs/hcl.mjs";
import html from "shiki/langs/html.mjs";
import http from "shiki/langs/http.mjs";
import ini from "shiki/langs/ini.mjs";
import java from "shiki/langs/java.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import jsonc from "shiki/langs/jsonc.mjs";
import jsx from "shiki/langs/jsx.mjs";
import kotlin from "shiki/langs/kotlin.mjs";
import less from "shiki/langs/less.mjs";
import log from "shiki/langs/log.mjs";
import lua from "shiki/langs/lua.mjs";
import makefile from "shiki/langs/makefile.mjs";
import markdown from "shiki/langs/markdown.mjs";
import objectiveC from "shiki/langs/objective-c.mjs";
import ocaml from "shiki/langs/ocaml.mjs";
import perl from "shiki/langs/perl.mjs";
import php from "shiki/langs/php.mjs";
import powershell from "shiki/langs/powershell.mjs";
import prisma from "shiki/langs/prisma.mjs";
import protobuf from "shiki/langs/protobuf.mjs";
import python from "shiki/langs/python.mjs";
import r from "shiki/langs/r.mjs";
import ruby from "shiki/langs/ruby.mjs";
import rust from "shiki/langs/rust.mjs";
import scala from "shiki/langs/scala.mjs";
import scss from "shiki/langs/scss.mjs";
import sql from "shiki/langs/sql.mjs";
import svelte from "shiki/langs/svelte.mjs";
import swift from "shiki/langs/swift.mjs";
import toml from "shiki/langs/toml.mjs";
import tsx from "shiki/langs/tsx.mjs";
import typescript from "shiki/langs/typescript.mjs";
import vim from "shiki/langs/vim.mjs";
import vue from "shiki/langs/vue.mjs";
import xml from "shiki/langs/xml.mjs";
import yaml from "shiki/langs/yaml.mjs";
import zig from "shiki/langs/zig.mjs";
import type { LanguageRegistration, ThemeRegistrationAny } from "shiki/types";

import { THEME } from "./styles.js";

const THEME_NAME = "yukino";

const GRAMMAR_MODULES: LanguageRegistration[][] = [
  bash,
  c,
  clojure,
  coffeescript,
  consoleLang,
  cpp,
  csharp,
  css,
  csv,
  dart,
  diff,
  dockerfile,
  elixir,
  erlang,
  fsharp,
  go,
  graphql,
  groovy,
  haskell,
  hcl,
  html,
  http,
  ini,
  java,
  javascript,
  json,
  jsonc,
  jsx,
  kotlin,
  less,
  log,
  lua,
  makefile,
  markdown,
  objectiveC,
  ocaml,
  perl,
  php,
  powershell,
  prisma,
  protobuf,
  python,
  r,
  ruby,
  rust,
  scala,
  scss,
  sql,
  swift,
  svelte,
  toml,
  tsx,
  typescript,
  vim,
  vue,
  xml,
  yaml,
  zig,
];

const SUPPORTED_LANGUAGES = new Set(
  GRAMMAR_MODULES.flat().flatMap((grammar) =>
    [grammar.name, ...(grammar.aliases ?? [])].map((name) =>
      name.toLowerCase(),
    ),
  ),
);

// Shared across palettes: the engine caches compiled rules per pattern, so a
// rebuilt highlighter keeps tokenizing without recompiling grammars.
const engine = createJavaScriptRegexEngine();

// One highlighter per palette snapshot: setThemeMode swaps the fixed dark and
// light palettes, and baked-in theme colors cannot be replaced in place.
const highlighters = new Map<string, HighlighterCore>();

function buildTheme(): ThemeRegistrationAny {
  return {
    name: THEME_NAME,
    fg: THEME.syntaxOperator,
    settings: [
      { settings: { foreground: THEME.syntaxOperator } },
      {
        scope: ["comment", "punctuation.definition.comment", "string.comment"],
        settings: { foreground: THEME.syntaxComment },
      },
      {
        scope: [
          "string",
          "punctuation.definition.string",
          "string.regexp",
          "markup.inline.raw",
          "markup.underline.link",
        ],
        settings: { foreground: THEME.syntaxString },
      },
      {
        scope: [
          "constant.character",
          "constant.character.escape",
          "constant.language",
          "constant.numeric",
          "constant.other",
          "entity.name.constant",
          "support.constant",
          "variable.other.constant",
        ],
        settings: { foreground: THEME.syntaxNumber },
      },
      {
        scope: [
          "keyword",
          "storage",
          "entity.name.tag",
          "markup.heading",
          "entity.name.section",
          "variable.language",
        ],
        settings: { foreground: THEME.syntaxKeyword },
      },
      {
        scope: ["keyword.operator", "punctuation"],
        settings: { foreground: THEME.syntaxOperator },
      },
      {
        scope: [
          "entity.name.function",
          "support.function",
          "meta.function-call",
          "meta.require",
        ],
        settings: { foreground: THEME.syntaxFunction },
      },
      {
        scope: [
          "entity.name.type",
          "entity.name.namespace",
          "entity.other.inherited-class",
          "support.class",
          "support.function.builtin",
          "support.type",
        ],
        settings: { foreground: THEME.syntaxType },
      },
      {
        scope: [
          "variable",
          "entity.name.variable",
          "entity.other.attribute-name",
          "meta.definition.variable",
          "support.type.property-name",
        ],
        settings: { foreground: THEME.syntaxVariable },
      },
      {
        scope: ["markup.inserted"],
        settings: { foreground: THEME.toolDiffAdded },
      },
      {
        scope: ["markup.deleted"],
        settings: { foreground: THEME.toolDiffRemoved },
      },
    ],
  };
}

function getHighlighter(): HighlighterCore {
  const key = JSON.stringify(THEME);
  let highlighter = highlighters.get(key);
  if (highlighter === undefined) {
    highlighter = createHighlighterCoreSync({
      engine,
      themes: [buildTheme()],
      langs: GRAMMAR_MODULES,
    });
    highlighters.set(key, highlighter);
  }
  return highlighter;
}

export function isLanguageSupported(language: string): boolean {
  const normalized = language.toLowerCase();
  return SUPPORTED_LANGUAGES.has(normalized) || isPlainLang(normalized);
}

/**
 * Highlight `code` as ANSI for the terminal, or return undefined when the
 * language is unknown or highlighting fails so callers fall back to plain
 * styling. Tokens without a resolved color get the default foreground, which
 * is what plain-text fences render as.
 */
export function highlightCode(
  code: string,
  language: string | undefined,
): string | undefined {
  const normalized = (language ?? "plaintext").toLowerCase();
  try {
    const { tokens } = getHighlighter().codeToTokens(code, {
      lang: normalized,
      theme: THEME_NAME,
    });
    return tokens
      .map((line) =>
        line
          .map((token) =>
            token.content === ""
              ? ""
              : chalk.hex(token.color ?? THEME.syntaxOperator)(token.content),
          )
          .join(""),
      )
      .join("\n");
  } catch {
    return undefined;
  }
}
