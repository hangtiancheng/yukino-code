import type { ThemeRegistration } from "shiki";

import { DARK_THEME, LIGHT_THEME, type ThemeMode } from "@/theme/constants.js";

export function defaultSyntaxTheme(
  mode: ThemeMode,
  background: string,
): ThemeRegistration {
  const palette = mode === "light" ? LIGHT_THEME : DARK_THEME;
  return {
    name: `yukino-${mode}`,
    type: mode,
    colors: {
      "editor.background": background,
      "editor.foreground": palette.text,
    },
    tokenColors: [
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: palette.syntaxComment },
      },
      {
        scope: ["keyword", "storage"],
        settings: { foreground: palette.syntaxKeyword },
      },
      {
        scope: ["entity.name.function", "support.function"],
        settings: { foreground: palette.syntaxFunction },
      },
      {
        scope: ["variable", "support.variable"],
        settings: { foreground: palette.syntaxVariable },
      },
      {
        scope: ["string", "markup.inline.raw"],
        settings: { foreground: palette.syntaxString },
      },
      {
        scope: ["constant.numeric", "constant.language"],
        settings: { foreground: palette.syntaxNumber },
      },
      {
        scope: [
          "entity.name.type",
          "entity.name.tag",
          "support.type",
          "support.class",
        ],
        settings: { foreground: palette.syntaxType },
      },
      {
        scope: "keyword.operator",
        settings: { foreground: palette.syntaxOperator },
      },
      {
        scope: "punctuation",
        settings: { foreground: palette.syntaxPunctuation },
      },
      {
        scope: "markup.inserted",
        settings: { foreground: palette.toolDiffAdded },
      },
      {
        scope: "markup.deleted",
        settings: { foreground: palette.toolDiffRemoved },
      },
      {
        scope: "markup.heading",
        settings: { foreground: palette.mdHeading, fontStyle: "bold" },
      },
      { scope: "markup.italic", settings: { fontStyle: "italic" } },
      { scope: "markup.bold", settings: { fontStyle: "bold" } },
    ],
  };
}
