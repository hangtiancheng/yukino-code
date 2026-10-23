import { createContext } from "react";

import type { RequestApp } from "#/lib/mcp-app-requests.js";

export const McpAppContext = createContext<{
  request: RequestApp;
  sendMessage: (text: string) => boolean;
  theme: "dark" | "light";
} | null>(null);
