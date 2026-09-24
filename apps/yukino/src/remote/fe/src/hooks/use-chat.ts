/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type {
  ChatItem,
  ConnectionStatus,
  PermissionResponse,
  ServerMessage,
  SlashCommand,
  ThinkingItem,
  ToolItem,
  UsagePayload,
} from "@fe/types";
import { toolKey } from "@fe/types";
import { useCallback, useReducer } from "react";

/** Monotonic id generator for newly created chat items. */
let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${String(idCounter)}`;
}

export interface ChatState {
  items: ChatItem[];
  connection: ConnectionStatus;
  session: string;
  cwd: string;
  commands: SlashCommand[];
  usage: UsagePayload | null;
  streaming: boolean;
  /** id of the assistant item currently receiving stream_text, if any. */
  currentAssistantId: string | null;
  /** id of the thinking item currently receiving thinking_text, if any. */
  currentThinkingId: string | null;
  /** Whether the initial "connected" system line has already been shown. */
  greeted: boolean;
}

export const initialState: ChatState = {
  items: [],
  connection: "connecting",
  session: "",
  cwd: "",
  commands: [],
  usage: null,
  streaming: false,
  currentAssistantId: null,
  currentThinkingId: null,
  greeted: false,
};

type Action =
  | { kind: "message"; message: ServerMessage }
  | { kind: "connection"; status: ConnectionStatus }
  | { kind: "respondPermission"; id: string; response: PermissionResponse }
  | { kind: "markAskAnswered"; id: string };

function finalizeCurrentThinking(state: ChatState): ChatState {
  if (state.currentThinkingId === null) {
    return state;
  }
  const id = state.currentThinkingId;
  return {
    ...state,
    currentThinkingId: null,
    items: state.items.map((it) =>
      it.kind === "thinking" && it.id === id ? { ...it, done: true } : it,
    ),
  };
}

function finalizeAssistant(state: ChatState): ChatState {
  if (state.currentAssistantId === null) {
    return state;
  }
  const id = state.currentAssistantId;
  return {
    ...state,
    currentAssistantId: null,
    items: state.items.map((it) =>
      it.kind === "assistant" && it.id === id
        ? { ...it, streaming: false }
        : it,
    ),
  };
}

function applyMessage(state: ChatState, msg: ServerMessage): ChatState {
  switch (msg.type) {
    case "connected": {
      // Defensive: the server now defers "connected" until the agent exists,
      // so session is always non-empty; guard anyway and don't consume the
      // one-shot greeting for an empty session.
      if (!msg.data.session) {
        return { ...state, cwd: msg.data.cwd || state.cwd };
      }
      if (state.greeted) {
        return { ...state, session: msg.data.session, cwd: msg.data.cwd };
      }
      return {
        ...state,
        greeted: true,
        session: msg.data.session,
        cwd: msg.data.cwd,
        items: [
          ...state.items,
          {
            kind: "system",
            id: nextId("sys"),
            content: `Session: ${msg.data.session} | CWD: ${msg.data.cwd}`,
          },
        ],
      };
    }

    case "commands":
      return { ...state, commands: msg.data ?? [] };

    case "system":
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "system", id: nextId("sys"), content: msg.data.message },
        ],
      };

    case "clear":
      return {
        ...state,
        currentAssistantId: null,
        currentThinkingId: null,
        items: [
          {
            kind: "system",
            id: nextId("sys"),
            content: "Conversation cleared.",
          },
        ],
      };

    case "command_done":
      return { ...state, streaming: false };

    case "replay_user":
      return {
        ...state,
        items: [
          ...state.items,
          { kind: "user", id: nextId("usr"), content: msg.data.content },
        ],
      };

    case "replay_assistant":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "assistant",
            id: nextId("ast"),
            content: msg.data.content,
            streaming: false,
          },
        ],
      };

    case "thinking_text": {
      if (state.currentThinkingId === null) {
        const id = nextId("thk");
        const item: ThinkingItem = {
          kind: "thinking",
          id,
          content: msg.data.text,
          done: false,
        };
        return {
          ...state,
          currentThinkingId: id,
          items: [...state.items, item],
        };
      }
      const id = state.currentThinkingId;
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === "thinking" && it.id === id
            ? { ...it, content: it.content + msg.data.text }
            : it,
        ),
      };
    }

    case "stream_text": {
      let next = finalizeCurrentThinking(state);
      if (next.currentAssistantId === null) {
        const id = nextId("ast");
        next = {
          ...next,
          currentAssistantId: id,
          items: [
            ...next.items,
            { kind: "assistant", id, content: msg.data.text, streaming: true },
          ],
        };
      } else {
        const id = next.currentAssistantId;
        next = {
          ...next,
          items: next.items.map((it) =>
            it.kind === "assistant" && it.id === id
              ? { ...it, content: it.content + msg.data.text }
              : it,
          ),
        };
      }
      return next;
    }

    case "stream_end":
      return finalizeAssistant(state);

    case "tool_use": {
      let next = finalizeCurrentThinking(state);
      next = finalizeAssistant(next);
      const key = toolKey(msg.data.toolName, msg.data.toolId);
      const exists = next.items.some(
        (it) => it.kind === "tool" && toolKey(it.toolName, it.toolId) === key,
      );
      if (exists) {
        return next;
      }
      const item: ToolItem = {
        kind: "tool",
        id: nextId("tool"),
        toolId: msg.data.toolId,
        toolName: msg.data.toolName,
        args: msg.data.args,
        status: "running",
        output: "",
        isError: false,
        elapsed: 0,
      };
      return { ...next, items: [...next.items, item] };
    }

    case "tool_result": {
      const key = toolKey(msg.data.toolName, msg.data.toolId);
      let updated = false;
      const items = state.items.map((it) => {
        if (it.kind === "tool" && toolKey(it.toolName, it.toolId) === key) {
          updated = true;
          return {
            ...it,
            status: msg.data.isError ? ("err" as const) : ("ok" as const),
            output: msg.data.output,
            isError: msg.data.isError,
            elapsed: msg.data.elapsed,
          };
        }
        return it;
      });
      if (updated) {
        return { ...state, items };
      }
      const item: ToolItem = {
        kind: "tool",
        id: nextId("tool"),
        toolId: msg.data.toolId,
        toolName: msg.data.toolName,
        args: null,
        status: msg.data.isError ? "err" : "ok",
        output: msg.data.output,
        isError: msg.data.isError,
        elapsed: msg.data.elapsed,
      };
      return { ...state, items: [...state.items, item] };
    }

    case "permission_request":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "permission",
            id: msg.data.id,
            toolName: msg.data.toolName,
            description: msg.data.description,
            responded: false,
            response: null,
          },
        ],
      };

    case "ask_user":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "askUser",
            id: msg.data.id,
            questions: msg.data.questions,
            answered: false,
          },
        ],
      };

    case "turn_complete":
      return state;

    case "loop_complete": {
      let next = finalizeAssistant(state);
      next = finalizeCurrentThinking(next);
      return {
        ...next,
        streaming: false,
        items: [
          ...next.items,
          { kind: "done", id: nextId("done"), elapsed: msg.data.elapsed },
        ],
      };
    }

    case "usage":
      return { ...state, usage: msg.data };

    case "error":
      return {
        ...state,
        streaming: false,
        items: [
          ...state.items,
          { kind: "error", id: nextId("err"), content: msg.data.message },
        ],
      };

    case "compact":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "system",
            id: nextId("sys"),
            content: `⟳ ${msg.data.message}`,
          },
        ],
      };

    case "retry":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "system",
            id: nextId("sys"),
            content: `↻ Retrying: ${msg.data.reason}`,
          },
        ],
      };

    case "pong":
      return state;

    default:
      return state;
  }
}

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.kind) {
    case "connection":
      return { ...state, connection: action.status };

    case "message":
      return applyMessage(state, action.message);

    case "respondPermission":
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === "permission" && it.id === action.id
            ? { ...it, responded: true, response: action.response }
            : it,
        ),
      };

    case "markAskAnswered":
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === "askUser" && it.id === action.id
            ? { ...it, answered: true }
            : it,
        ),
      };

    default:
      return state;
  }
}

export interface ChatApi {
  state: ChatState;
  dispatchMessage: (message: ServerMessage) => void;
  setConnection: (status: ConnectionStatus) => void;
  respondPermission: (id: string, response: PermissionResponse) => void;
  markAskAnswered: (id: string) => void;
}

export function useChat(): ChatApi {
  const [state, dispatch] = useReducer(reducer, initialState);

  const dispatchMessage = useCallback((message: ServerMessage) => {
    dispatch({ kind: "message", message });
  }, []);

  const setConnection = useCallback((status: ConnectionStatus) => {
    dispatch({ kind: "connection", status });
  }, []);

  const respondPermission = useCallback(
    (id: string, response: PermissionResponse) => {
      dispatch({ kind: "respondPermission", id, response });
    },
    [],
  );

  const markAskAnswered = useCallback((id: string) => {
    dispatch({ kind: "markAskAnswered", id });
  }, []);

  return {
    state,
    dispatchMessage,
    setConnection,
    respondPermission,
    markAskAnswered,
  };
}
