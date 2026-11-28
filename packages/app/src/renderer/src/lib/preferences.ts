import type { RuntimePreferences } from "@yukino.js/yukino";
import { createContext, useContext } from "react";

export const DEFAULT_PREFERENCES: RuntimePreferences = {
  theme: "auto",
  code_mode: { mode: "off", inline_budget: 12000 },
  display: {
    show_thinking: true,
    expanded_tools: false,
    editor_padding: 1,
    output_padding: 1,
    autocomplete_max_visible: 8,
  },
  auto_compaction: true,
  auto_retry: true,
  steering_mode: "all",
  follow_up_mode: "one-at-a-time",
};
export const PreferencesContext = createContext(DEFAULT_PREFERENCES);
export const usePreferences = (): RuntimePreferences =>
  useContext(PreferencesContext);
