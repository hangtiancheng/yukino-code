import palettes from "./palette.json";

export type ThemeMode = "dark" | "light";
export type ThemePalette = typeof palettes.dark;
export const DARK_THEME: ThemePalette = palettes.dark;
export const LIGHT_THEME: ThemePalette = palettes.light;
