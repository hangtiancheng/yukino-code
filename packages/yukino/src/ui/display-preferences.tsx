import { createContext, useContext } from "react";

import { DisplayPreferencesSchema } from "@/config/preferences.js";

export const DisplayPreferencesContext = createContext(
  DisplayPreferencesSchema.parse({}),
);
export function useDisplayPreferences() {
  return useContext(DisplayPreferencesContext);
}
