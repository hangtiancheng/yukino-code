import { PALETTES as paletteData } from "./palettes.js";

export type ThemeMode = "dark" | "light";

export interface ThemePalette {
  accent: string;
  border: string;
  borderAccent: string;
  borderMuted: string;
  success: string;
  error: string;
  warning: string;
  muted: string;
  dim: string;
  text: string;
  thinkingText: string;
  selectedBg: string;
  userMessageBg: string;
  userMessageText: string;
  customMessageBg: string;
  customMessageText: string;
  customMessageLabel: string;
  toolPendingBg: string;
  toolSuccessBg: string;
  toolErrorBg: string;
  toolTitle: string;
  toolOutput: string;
  mdHeading: string;
  mdLink: string;
  mdLinkUrl: string;
  mdCode: string;
  mdCodeBlock: string;
  mdCodeBlockBorder: string;
  mdQuote: string;
  mdQuoteBorder: string;
  mdHr: string;
  mdListBullet: string;
  toolDiffAdded: string;
  toolDiffRemoved: string;
  toolDiffContext: string;
  syntaxComment: string;
  syntaxKeyword: string;
  syntaxFunction: string;
  syntaxVariable: string;
  syntaxString: string;
  syntaxNumber: string;
  syntaxType: string;
  syntaxOperator: string;
  syntaxPunctuation: string;
  thinkingOff: string;
  thinkingMinimal: string;
  thinkingLow: string;
  thinkingMedium: string;
  thinkingHigh: string;
  thinkingMax: string;
  bashMode: string;
  thinkingXHigh: string;
  background: string;
  surface: string;
  codeBg: string;
  bright: string;
  accentContrast: string;
}

// The values live in palettes.js (plain JS) so the browser PostCSS config can
// import them without a TypeScript loader. This annotation is what keeps that
// data honest: a missing or renamed key fails `pnpm typecheck`.
export const PALETTES: {
  dark: ThemePalette;
  light: ThemePalette;
} = paletteData;

export const DARK_THEME: ThemePalette = PALETTES.dark;
export const LIGHT_THEME: ThemePalette = PALETTES.light;
