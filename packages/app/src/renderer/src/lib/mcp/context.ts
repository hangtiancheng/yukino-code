import type { McpAppOperation } from "@shared/ipc-types";
import { createContext } from "react";
export const McpAppContext = createContext<{
  request: (appId: string, operation: McpAppOperation) => Promise<unknown>;
  sendMessage: (text: string) => boolean;
  theme: "dark" | "light";
} | null>(null);
