import { useCallback, useEffect, useState } from "react";

import { STORAGE_KEY } from "#/constants.js";
import { DARK_THEME, LIGHT_THEME, type ThemeMode } from "@/theme/constants.js";

function systemTheme(): ThemeMode {
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    return "light";
  }
  return "dark";
}

function initialTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light") {
      return stored;
    }
  } catch {
    // Storage can be unavailable (private mode); fall through to the system pref.
  }
  return systemTheme();
}

/**
 * Drive the `data-theme` attribute on <html>. The inline bootstrap in
 * index.html applies the same value before first paint; this hook keeps it in
 * sync afterwards and persists explicit user choices.
 */
export function useTheme(): { theme: ThemeMode; toggleTheme: () => void } {
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        (theme === "dark" ? DARK_THEME : LIGHT_THEME).background,
      );
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: ThemeMode = current === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Ignore storage failures; the toggle still applies for this page view.
      }
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
