import { PALETTES as paletteData } from "./palettes.js";

export type ThemeMode = "dark" | "light";

export interface ThemePalette {
  accent: string;
  accentHover: string;
  accentBg: string;
  border: string;
  borderAccent: string;
  borderMuted: string;
  success: string;
  successBg: string;
  error: string;
  errorBg: string;
  warning: string;
  warningBg: string;
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
  toolStoppedBg: string;
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

// Validate the JavaScript palette shared with the browser's PostCSS config.
export const PALETTES: {
  dark: ThemePalette;
  light: ThemePalette;
} = paletteData;

export const DARK_THEME: ThemePalette = PALETTES.dark;
export const LIGHT_THEME: ThemePalette = PALETTES.light;
