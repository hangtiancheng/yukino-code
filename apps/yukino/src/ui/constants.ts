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
import type { LanguageRegistration } from "shiki/types";

import type { NonPlanPermissionMode } from "@/permissions/index.js";
import type { CodeReviewFormValues } from "@/review/form.js";
import { DARK_THEME, type ThemePalette } from "@/theme/constants.js";

export const THEME: ThemePalette = { ...DARK_THEME };

export const ICONS = {
  active: "◉",
  arrow: "→" satisfies "→" | "←",
  branch: "├─",
  collapsed: "⊞",
  expanded: "⊟",
  inactive: "○",
  lastBranch: "└─",
  prompt: ">",
  success: "✓",
  error: "✗",
  tree: "│",
} as const;

export const FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

export const COMMAND_TAGS = ["[skill]", "[custom]"];

// @-mention cache lifetime: covers edits made outside the app (user editor,
// git) that produce no fileFactsVersion bump.
export const FILE_CACHE_TTL_MS = 30_000;

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

export const PERMISSION_MODE_CYCLE: NonPlanPermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
];

export const MODE_DISPLAY: Record<string, string> = {
  default: "Default",
  acceptEdits: "Accept Edits",
  plan: "Plan",
  bypassPermissions: "YOLO",
};

// Maximum number of recent tool names (deduplicated) passed to the memory recall selector
export const MAX_RECENT_TOOLS = 10;

export const MARKER =
  /\[paste #\d+ (?:\+\d+ lines|\d+ chars)\]|\[Image #\d+\]/g;

export const EMPTY_FORM: CodeReviewFormValues = {
  focus: "",
  from: "",
  to: "",
  commit: "",
  exclude: "",
};

export const PERMISSION_OPTIONS: {
  label: string;
  action: "allow" | "deny" | "allowAlways";
}[] = [
  { label: "Yes", action: "allow" },
  {
    label: "Yes, remember the scopes above for all agents in this project",
    action: "allowAlways",
  },
  { label: "No", action: "deny" },
];

export const PLAN_APPROVAL_OPTIONS = [
  "Yes, enter YOLO mode (auto-approve all)",
  "Yes, manually approve edits",
  "Tell Yukino what to change",
];

export const PROTOCOLS = ["anthropic", "openai", "openai-compat"] as const;

export const RESTORE_OPTIONS = [
  "Restore code and conversation",
  "Restore conversation only",
  "Restore code only",
  "Never mind",
];

/** Focus sentinel for the free-text row; never a real model id. */
export const OTHER = "\u0000other";
export const OTHER_LABEL = "Other (type your own)";

export const TAB_SIZE = 2;

export const OSC_BACKGROUND = "\x1b]11;";
export const COLOR_SCHEME = "\x1b[?997;";
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

export const BSU = "\x1b[?2026h"; // Begin Synchronized Update
export const ESU = "\x1b[?2026l"; // End Synchronized Update

/** TERM_PROGRAM values whose terminal emulator implements synchronized output. */
export const SYNC_OUTPUT_TERM_PROGRAMS = new Set([
  "alacritty",
  "contour",
  "ghostty",
  "iTerm.app",
  "vscode",
  "WarpTerminal",
  "WezTerm",
]);

/** One space of padding on each side of a cell, in terminal columns. */
export const CELL_PADDING = 2;

export const GRAMMAR_MODULES: LanguageRegistration[][] = [
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

export const SUPPORTED_LANGUAGES = new Set(
  GRAMMAR_MODULES.flat().flatMap((grammar) =>
    [grammar.name, ...(grammar.aliases ?? [])].map((name) =>
      name.toLowerCase(),
    ),
  ),
);
