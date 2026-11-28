import { useSyncExternalStore } from "react";

import { getThemeMode, subscribeThemeMode } from "@/ui/styles.js";

export function useThemeMode() {
  return useSyncExternalStore(subscribeThemeMode, getThemeMode, getThemeMode);
}
