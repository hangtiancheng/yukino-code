// Chat state model: a flat list of renderable items, reduced from the
// main-process BridgeEvent stream. Kept UI-agnostic so app.tsx stays presentational.

import type {
  BridgeEvent,
  HistoryMessage,
  PermissionRequestPayload,
  PermissionResponse,
  AskRequestPayload,
  UsagePayload,
  InitState,
  SessionSummary,
} from "@shared/ipc-types";

let idCounter = 0;
export function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistant";
      id: string;
      text: string;
      thinking: string;
      streaming: boolean;
    }
  | {
      kind: "tool";
      id: string;
      toolId: string;
      toolName: string;
      args: Record<string, unknown>;
      output: string | null;
      isError: boolean;
      elapsed: number | null;
      running: boolean;
    }
  | { kind: "system"; id: string; text: string; markdown: boolean }
  | { kind: "error"; id: string; text: string }
  | { kind: "marker"; id: string; text: string }
  | {
      kind: "permission";
      id: string;
      payload: PermissionRequestPayload;
      response: PermissionResponse | null;
    }
  | {
      kind: "ask";
      id: string;
      payload: AskRequestPayload;
      answered: boolean;
    };

export interface ChatState {
  items: ChatItem[];
  streaming: boolean;
  usage: UsagePayload | null;
  init: InitState | null;
  initializing: boolean;
  sessions: SessionSummary[];
  /** Session currently loaded in the chat surface (for sidebar highlight). */
  activeSessionId: string | null;
  themeMode: "system" | "light" | "dark";
  themeDark: boolean;
  /** Tool-call ids of live subagents (for the activity indicator). */
  activeSubagents: number;
}

export const initialChatState: ChatState = {
  items: [],
  streaming: false,
  usage: null,
  init: null,
  initializing: true,
  sessions: [],
  activeSessionId: null,
  themeMode: "system",
  themeDark: false,
  activeSubagents: 0,
};

type ChatAction =
  | { type: "event"; event: BridgeEvent }
  | { type: "append_user"; text: string }
  | { type: "init_state"; data: InitState }
  | { type: "set_sessions"; sessions: SessionSummary[] }
  | { type: "set_active_session"; sessionId: string | null }
  | { type: "clear_items" }
  | { type: "load_history"; messages: HistoryMessage[] }
  | { type: "set_theme"; mode: "system" | "light" | "dark" }
  | { type: "set_theme_dark"; dark: boolean }
  | { type: "set_initializing"; value: boolean };

function appendAssistant(state: ChatState): ChatState {
  const item: ChatItem = {
    kind: "assistant",
    id: nextId("a"),
    text: "",
    thinking: "",
    streaming: true,
  };
  return { ...state, items: [...state.items, item] };
}

function mapLast(
  items: ChatItem[],
  fn: (item: ChatItem) => ChatItem,
): ChatItem[] {
  const last = items[items.length - 1];
  if (!last) {
    return items;
  }
  return [...items.slice(0, -1), fn(last)];
}

function applyEvent(state: ChatState, event: BridgeEvent): ChatState {
  switch (event.type) {
    case "init_state":
      return {
        ...state,
        init: event.data,
        initializing: false,
        activeSessionId: event.data.ok ? event.data.sessionId : null,
        items: event.data.ok
          ? state.items
          : [
              ...state.items,
              {
                kind: "error",
                id: nextId("err"),
                text: `${event.data.error}${event.data.configPath ? `\nConfig file: ${event.data.configPath}` : ""}`,
              },
            ],
      };

    case "run_state":
      return { ...state, streaming: event.data.streaming };

    case "stream_text": {
      const last = state.items[state.items.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        return {
          ...state,
          items: mapLast(state.items, (item) =>
            item.kind === "assistant"
              ? { ...item, text: item.text + event.data.text }
              : item,
          ),
        };
      }
      const next = appendAssistant(state);
      return {
        ...next,
        items: mapLast(next.items, (item) =>
          item.kind === "assistant" ? { ...item, text: event.data.text } : item,
        ),
      };
    }

    case "thinking_text": {
      const last = state.items[state.items.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        return {
          ...state,
          items: mapLast(state.items, (item) =>
            item.kind === "assistant"
              ? { ...item, thinking: item.thinking + event.data.text }
              : item,
          ),
        };
      }
      const next = appendAssistant(state);
      return {
        ...next,
        items: mapLast(next.items, (item) =>
          item.kind === "assistant"
            ? { ...item, thinking: event.data.text }
            : item,
        ),
      };
    }

    case "tool_use": {
      // A tool call closes any open streaming assistant text block.
      const closed = state.items.map((item) =>
        item.kind === "assistant" && item.streaming
          ? { ...item, streaming: false }
          : item,
      );
      return {
        ...state,
        items: [
          ...closed,
          {
            kind: "tool",
            id: nextId("tool"),
            toolId: event.data.toolId,
            toolName: event.data.toolName,
            args: event.data.args,
            output: null,
            isError: false,
            elapsed: null,
            running: true,
          },
        ],
      };
    }

    case "tool_result":
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === "tool" && item.toolId === event.data.toolId
            ? {
                ...item,
                output: event.data.output,
                isError: event.data.isError,
                elapsed: event.data.elapsed,
                running: false,
              }
            : item,
        ),
      };

    case "turn_complete":
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === "assistant" && item.streaming
            ? { ...item, streaming: false }
            : item,
        ),
      };

    case "loop_complete":
      return {
        ...state,
        streaming: false,
        items: state.items.map((item) =>
          item.kind === "assistant" && item.streaming
            ? { ...item, streaming: false }
            : item,
        ),
      };

    case "usage":
      return { ...state, usage: event.data };

    case "error":
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "error", id: nextId("err"), text: event.data.message },
        ],
      };

    case "system":
      return event.data.message
        ? {
            ...state,
            items: [
              ...state.items,
              {
                kind: "system",
                id: nextId("sys"),
                text: event.data.message,
                markdown: event.data.markdown ?? false,
              },
            ],
          }
        : state;

    case "compact":
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "marker", id: nextId("mk"), text: event.data.message },
        ],
      };

    case "retry":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "marker",
            id: nextId("mk"),
            text: `Retrying in ${Math.round(event.data.delay / 1000)}s — ${event.data.reason}`,
          },
        ],
      };

    case "permission_request":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "permission",
            id: nextId("perm"),
            payload: event.data,
            response: null,
          },
        ],
      };

    case "permission_resolved":
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === "permission" && item.payload.id === event.data.id
            ? { ...item, response: event.data.response }
            : item,
        ),
      };

    case "ask_request":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "ask",
            id: nextId("ask"),
            payload: event.data,
            answered: false,
          },
        ],
      };

    case "ask_resolved":
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === "ask" && item.payload.id === event.data.id
            ? { ...item, answered: true }
            : item,
        ),
      };

    case "subagent":
      return event.data.type === "started"
        ? { ...state, activeSubagents: state.activeSubagents + 1 }
        : event.data.type === "finished"
          ? {
              ...state,
              activeSubagents: Math.max(0, state.activeSubagents - 1),
            }
          : state;

    case "session_changed":
      return { ...state, activeSessionId: event.data.sessionId };

    case "history":
      return {
        ...state,
        activeSessionId: event.data.sessionId,
        items: historyToItems(event.data.messages),
        usage: null,
      };
  }
}

function historyToItems(messages: HistoryMessage[]): ChatItem[] {
  // In the transcript format, tool results ride on the user-role message
  // that follows the assistant's tool_uses; index them globally by id.
  const resultsByToolUseId = new Map<
    string,
    { content: string; isError: boolean }
  >();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      resultsByToolUseId.set(result.toolUseId, result);
    }
  }

  const items: ChatItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      // Skip tool-result carriers; only genuine user prompts render.
      if (message.content.trim() && !message.toolResults?.length) {
        items.push({
          kind: "user",
          id: nextId("u"),
          text: message.content,
        });
      }
      continue;
    }
    if (message.role === "assistant") {
      if (message.thinking || message.content.trim()) {
        items.push({
          kind: "assistant",
          id: nextId("a"),
          text: message.content,
          thinking: message.thinking ?? "",
          streaming: false,
        });
      }
      for (const use of message.toolUses ?? []) {
        const result = resultsByToolUseId.get(use.toolUseId);
        items.push({
          kind: "tool",
          id: nextId("tool"),
          toolId: use.toolUseId,
          toolName: use.toolName,
          args: use.arguments,
          output: result?.content ?? null,
          isError: result?.isError ?? false,
          elapsed: null,
          running: false,
        });
      }
    }
  }
  return items;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "event":
      return applyEvent(state, action.event);
    case "append_user":
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "user", id: nextId("u"), text: action.text },
        ],
      };
    case "init_state":
      return { ...state, init: action.data, initializing: false };
    case "set_sessions":
      return { ...state, sessions: action.sessions };
    case "set_active_session":
      return { ...state, activeSessionId: action.sessionId };
    case "clear_items":
      return { ...state, items: [], usage: null };
    case "load_history":
      return { ...state, items: historyToItems(action.messages), usage: null };
    case "set_theme":
      return { ...state, themeMode: action.mode };
    case "set_theme_dark":
      return { ...state, themeDark: action.dark };
    case "set_initializing":
      return { ...state, initializing: action.value };
  }
}
