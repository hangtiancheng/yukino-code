// Shared, IPC-serializable contract between the main process (yukino bridge)
// and the renderer. Everything crossing the contextBridge must be plain JSON —
// no Error objects, no class instances, no functions.

export type PermissionResponse = "allow" | "deny" | "allowAlways";

/** A question posed by the AskUserQuestion tool. */
export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  options: AskQuestionOption[];
  multiSelect: boolean;
}

export interface PermissionRequestPayload {
  id: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Human-readable reason the permission system attached to this request. */
  reason: string;
  rememberPatterns?: string[];
  /** Subagent origin, when the request came from a spawned agent. */
  source?: { agentName: string; cwd: string };
}

export interface AskRequestPayload {
  id: string;
  questions: AskQuestion[];
}

export interface UsagePayload {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface SessionSummary {
  id: string;
  firstMessage: string;
  messageCount: number;
  modTime: number;
}

/** Flattened transcript message sent to the renderer on session resume. */
export interface HistoryMessage {
  role: string;
  /** Plain text, or the text projection of content blocks. */
  content: string;
  timestamp: number;
  toolUses?: {
    toolUseId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }[];
  toolResults?: {
    toolUseId: string;
    content: string;
    isError: boolean;
  }[];
  thinking?: string;
}

export type InitState =
  | {
      ok: true;
      cwd: string;
      providerName: string;
      model: string;
      sessionId: string;
      permissionMode: string;
      contextWindow: number;
      thinkingLevel: string;
    }
  | {
      ok: false;
      error: string;
      /** Path of the config file the user needs to create/edit. */
      configPath?: string;
    };

/** Subagent lifecycle activity (mirrors Remote.RemoteSubagentEvent). */
export type SubagentActivity = {
  toolCallId: string;
  role: string;
  background: boolean;
} & (
  | { type: "started" }
  | { type: "tool_use"; toolId: string; toolName: string }
  | { type: "tool_result"; toolId: string }
  | { type: "turn_complete" }
  | { type: "finished"; status: "completed" | "failed" | "stopped" }
);

/**
 * The full stream of events pushed from main to renderer on the
 * `yukino:event` channel.
 */
export type BridgeEvent =
  | { type: "init_state"; data: InitState }
  | { type: "run_state"; data: { streaming: boolean } }
  | { type: "stream_text"; data: { text: string } }
  | { type: "thinking_text"; data: { text: string } }
  | {
      type: "tool_use";
      data: { toolId: string; toolName: string; args: Record<string, unknown> };
    }
  | {
      type: "tool_result";
      data: {
        toolId: string;
        toolName: string;
        output: string;
        isError: boolean;
        elapsed: number;
      };
    }
  | { type: "turn_complete" }
  | { type: "loop_complete"; data: { stopReason: string } }
  | { type: "usage"; data: UsagePayload }
  | { type: "error"; data: { message: string } }
  | { type: "system"; data: { message: string; markdown?: boolean } }
  | { type: "compact"; data: { message: string } }
  | { type: "retry"; data: { reason: string; delay: number } }
  | { type: "permission_request"; data: PermissionRequestPayload }
  | {
      type: "permission_resolved";
      data: { id: string; response: PermissionResponse };
    }
  | { type: "ask_request"; data: AskRequestPayload }
  | { type: "ask_resolved"; data: { id: string } }
  | { type: "subagent"; data: SubagentActivity }
  | { type: "session_changed"; data: { sessionId: string; cwd: string } }
  /** Pushed after a bridge-side session resume (e.g. the /resume command). */
  | { type: "history"; data: ResumeResult };

/** Payload returned by `yukino:resume-session`. */
export interface ResumeResult {
  sessionId: string;
  messages: HistoryMessage[];
}

/** A slash command surfaced in the composer's command panel. */
export interface CommandSummary {
  name: string;
  description: string;
  type: "local" | "local_ui" | "prompt" | "skill_fork";
}

/** A provider entry as shown in the settings picker. */
export interface ProviderSummary {
  name: string;
  protocol: string;
  baseUrl: string;
  model: string;
}

/** Snapshot of everything the settings page needs. */
export interface SettingsSnapshot {
  providers: ProviderSummary[];
  /** Index into `providers` of the active provider. */
  currentProvider: number;
  model: string;
  thinkingLevel: string;
  thinkingLevels: string[];
}

export interface ModelListResult {
  status: "loading" | "ready" | "empty" | "error";
  models: { id: string; name: string | null }[];
  current: string;
}

/** The API surface exposed to the renderer as `window.api`. */
export interface YukinoApi {
  init(): Promise<InitState>;
  send(text: string): Promise<void>;
  abort(): Promise<void>;
  newSession(): Promise<{ sessionId: string }>;
  listSessions(): Promise<SessionSummary[]>;
  resumeSession(sessionId: string): Promise<ResumeResult>;
  selectFolder(): Promise<{ cwd: string | null }>;
  respondPermission(id: string, response: PermissionResponse): Promise<void>;
  respondAsk(id: string, answers: Record<string, string>): Promise<void>;
  getTheme(): Promise<{ mode: "system" | "light" | "dark"; dark: boolean }>;
  setTheme(mode: "system" | "light" | "dark"): Promise<void>;
  /** Slash commands for the composer's command panel. */
  listCommands(): Promise<CommandSummary[]>;
  /** Runs a slash command; results stream back as BridgeEvents. */
  runCommand(input: string): Promise<void>;
  /** Settings snapshot: providers, current provider/model, thinking levels. */
  getSettings(): Promise<SettingsSnapshot>;
  listModels(): Promise<ModelListResult>;
  setProvider(index: number): Promise<void>;
  setModel(model: string): Promise<void>;
  setThinkingLevel(level: string): Promise<void>;
  onEvent(callback: (event: BridgeEvent) => void): () => void;
  onTheme(callback: (theme: "dark" | "light") => void): () => void;
}
