import type { McpApp } from "@/mcp/apps.js";
import type {
  ToolArgs,
  PermissionResponse,
  Question,
} from "@/remote/protocol.js";
export * from "@/remote/protocol.js";
export interface ImageResultPayload {
  clientId: string;
  path?: string;
  message?: string;
}

/* ───────────────────────── Chat item model ───────────────────────── */

export type ConnectionStatus =
  "connecting" | "connected" | "reconnecting" | "unauthorized";

export type ToolStatus = "running" | "ok" | "err";

export interface UserItem {
  kind: "user";
  id: string;
  content: string;
}

export interface AssistantItem {
  kind: "assistant";
  id: string;
  content: string;
  streaming: boolean;
}

export interface SystemItem {
  kind: "system";
  id: string;
  content: string;
  markdown?: boolean;
}

export interface ErrorItem {
  kind: "error";
  id: string;
  content: string;
}

export interface ThinkingItem {
  kind: "thinking";
  id: string;
  content: string;
  /** When true the thinking block is finalized and its header shows "Thought". */
  done: boolean;
}

export interface ToolItem {
  kind: "tool";
  id: string;
  toolId: string;
  toolName: string;
  args: ToolArgs;
  status: ToolStatus;
  output: string;
  isError: boolean;
  elapsed: number;
  mcpApp?: McpApp;
}

export interface PermissionItem {
  kind: "permission";
  id: string;
  toolName: string;
  description: string;
  rememberPatterns?: string[];
  responded: boolean;
  response: PermissionResponse | null;
}

export interface AskUserItem {
  kind: "askUser";
  id: string;
  questions: Question[];
  answered: boolean;
}

export interface DoneItem {
  kind: "done";
  id: string;
  elapsed: number;
}

export type ChatItem =
  | UserItem
  | AssistantItem
  | SystemItem
  | ErrorItem
  | ThinkingItem
  | ToolItem
  | PermissionItem
  | AskUserItem
  | DoneItem;

/* ───────────────────────── Derived helper types ───────────────────────── */

/** A message key used to correlate tool_use with later tool_result events. */
export function toolKey(toolName: string, toolId: string): string {
  return `${toolName}_${toolId}`;
}
