import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "yukino-theme";

function systemTheme(): Theme {
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    return "light";
  }
  return "dark";
}

function initialTheme(): Theme {
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
export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
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
