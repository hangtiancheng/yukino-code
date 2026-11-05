import { electronAPI } from "@electron-toolkit/preload";
import type {
  BridgeEvent,
  CommandSummary,
  InitState,
  ModelListResult,
  McpAppOperation,
  PermissionResponse,
  ProviderInput,
  ResumeResult,
  SessionSummary,
  SettingsSnapshot,
} from "@shared/ipc-types";
import type {
  FileEntry,
  FileSnapshot,
  WorkspaceSnapshot,
  RuntimeSnapshot,
} from "@shared/workspace-types";
import { contextBridge, ipcRenderer } from "electron";

/**
 * Typed facade over the main-process yukino bridge. Exposed as `window.api`.
 * Every method is a thin wrapper around an ipcRenderer.invoke/on call so the
 * renderer never touches Node or Electron internals directly.
 */
const api = {
  saveProvider: (input: ProviderInput): Promise<void> =>
    ipcRenderer.invoke("yukino:save-provider", input),
  requestMcpApp: (
    appId: string,
    operation: McpAppOperation,
  ): Promise<unknown> => ipcRenderer.invoke("yukino:mcp-app", appId, operation),
  respondPlan: (
    id: string,
    choice: "approve" | "feedback",
    feedback?: string,
  ): Promise<void> =>
    ipcRenderer.invoke("yukino:respond-plan", id, choice, feedback),
  workspaceList: (path?: string): Promise<FileEntry[]> =>
    ipcRenderer.invoke("workspace:list", path),
  workspaceRead: (path: string): Promise<FileSnapshot> =>
    ipcRenderer.invoke("workspace:read", path),
  workspaceSave: (
    path: string,
    content: string,
    revision: string,
  ): Promise<FileSnapshot> =>
    ipcRenderer.invoke("workspace:save", path, content, revision),
  workspaceSnapshot: (): Promise<WorkspaceSnapshot> =>
    ipcRenderer.invoke("workspace:snapshot"),
  getRuntime: (): Promise<RuntimeSnapshot> =>
    ipcRenderer.invoke("yukino:runtime"),
  setPermissionMode: (
    mode: "default" | "acceptEdits" | "plan" | "bypassPermissions",
  ): Promise<void> => ipcRenderer.invoke("yukino:permission-mode", mode),
  rewind: (
    id: string,
    mode: "code_only" | "conversation_only" | "code_and_conversation",
  ): Promise<void> => ipcRenderer.invoke("yukino:rewind", id, mode),
  openConfig: (): Promise<void> => ipcRenderer.invoke("yukino:open-config"),
  selectAttachments: (): Promise<string[]> =>
    ipcRenderer.invoke("yukino:attachments"),
  init: (): Promise<InitState> => ipcRenderer.invoke("yukino:init"),
  send: (text: string): Promise<void> =>
    ipcRenderer.invoke("yukino:send", text),
  abort: (): Promise<void> => ipcRenderer.invoke("yukino:abort"),
  newSession: (): Promise<{ sessionId: string }> =>
    ipcRenderer.invoke("yukino:new-session"),
  listSessions: (): Promise<SessionSummary[]> =>
    ipcRenderer.invoke("yukino:list-sessions"),
  resumeSession: (sessionId: string, cwd?: string): Promise<ResumeResult> =>
    ipcRenderer.invoke("yukino:resume-session", sessionId, cwd),
  selectFolder: (): Promise<{ cwd: string | null }> =>
    ipcRenderer.invoke("yukino:select-folder"),
  respondPermission: (
    id: string,
    response: PermissionResponse,
  ): Promise<void> =>
    ipcRenderer.invoke("yukino:respond-permission", id, response),
  respondAsk: (id: string, answers: Record<string, string>): Promise<void> =>
    ipcRenderer.invoke("yukino:respond-ask", id, answers),
  getTheme: (): Promise<{
    mode: "system" | "light" | "dark";
    dark: boolean;
  }> => ipcRenderer.invoke("yukino:get-theme"),
  setTheme: (mode: "system" | "light" | "dark"): Promise<void> =>
    ipcRenderer.invoke("yukino:set-theme", mode),
  listCommands: (): Promise<CommandSummary[]> =>
    ipcRenderer.invoke("yukino:list-commands"),
  runCommand: (input: string): Promise<void> =>
    ipcRenderer.invoke("yukino:run-command", input),
  getSettings: (): Promise<SettingsSnapshot> =>
    ipcRenderer.invoke("yukino:get-settings"),
  listModels: (): Promise<ModelListResult> =>
    ipcRenderer.invoke("yukino:list-models"),
  setProvider: (index: number): Promise<void> =>
    ipcRenderer.invoke("yukino:set-provider", index),
  setModel: (model: string): Promise<void> =>
    ipcRenderer.invoke("yukino:set-model", model),
  setThinkingLevel: (level: string): Promise<void> =>
    ipcRenderer.invoke("yukino:set-thinking-level", level),

  /** Subscribe to the agent event stream. Returns an unsubscribe function. */
  onEvent: (callback: (event: BridgeEvent) => void): (() => void) => {
    const listener = (_: unknown, event: BridgeEvent): void => {
      callback(event);
    };
    ipcRenderer.on("yukino:event", listener);
    return () => ipcRenderer.removeListener("yukino:event", listener);
  },

  /** Subscribe to native theme changes. Returns an unsubscribe function. */
  onTheme: (callback: (theme: "dark" | "light") => void): (() => void) => {
    const listener = (_: unknown, theme: "dark" | "light"): void => {
      callback(theme);
    };
    ipcRenderer.on("yukino:theme", listener);
    return () => ipcRenderer.removeListener("yukino:theme", listener);
  },
};

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  window.electron = electronAPI;
  window.api = api;
}
