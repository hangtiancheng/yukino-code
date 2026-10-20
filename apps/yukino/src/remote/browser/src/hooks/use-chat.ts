import { useCallback, useReducer } from "react";

import type {
  BackgroundTaskInfo,
  ChatItem,
  ConnectionStatus,
  FileCompleteResponsePayload,
  ImageResultPayload,
  ModelListPayload,
  PermissionResponse,
  PlanApprovalPayload,
  ProviderListPayload,
  ReviewItem,
  RewindSnapshot,
  ServerMessage,
  SessionSummary,
  SlashCommand,
  SubagentInfo,
  TeammateInfo,
  ThinkingFormPayload,
  ThinkingItem,
  TodoUpdatePayload,
  ToolItem,
  UsagePayload,
} from "#/types.js";
import { toolKey } from "#/types.js";

/** Monotonic id generator for newly created chat items. */
let idCounter = 0;
const MAX_CHAT_ITEMS = 1000;

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${String(idCounter)}`;
}

function trimChatItems(state: ChatState): ChatState {
  if (state.items.length <= MAX_CHAT_ITEMS) {
    return state;
  }
  const items = state.items.slice(-MAX_CHAT_ITEMS);
  const ids = new Set(items.map((item) => item.id));
  return {
    ...state,
    items,
    currentAssistantId:
      state.currentAssistantId && ids.has(state.currentAssistantId)
        ? state.currentAssistantId
        : null,
    currentThinkingId:
      state.currentThinkingId && ids.has(state.currentThinkingId)
        ? state.currentThinkingId
        : null,
  };
}

export interface ChatState {
  items: ChatItem[];
  transcriptRevision: number;
  connection: ConnectionStatus;
  session: string;
  cwd: string;
  commands: SlashCommand[];
  usage: UsagePayload | null;
  streaming: boolean;
  /** Live status snapshot (model / permission mode / thinking level). */
  model: string;
  permissionMode: string;
  thinkingLevel: string;
  /** Steering messages queued for the in-flight run, not yet delivered. */
  steering: string[];
  /** Open plan approval request, if any. */
  planApproval: PlanApprovalPayload | null;
  /** Open session picker list, if any. */
  sessions: SessionSummary[] | null;
  /** Whether the code review form dialog is open. */
  codeReviewOpen: boolean;
  /** id of the assistant item currently receiving stream_text, if any. */
  currentAssistantId: string | null;
  /** id of the thinking item currently receiving thinking_text, if any. */
  currentThinkingId: string | null;
  /** Prompt history shared with the terminal (↑/↓ navigation). */
  history: string[];
  /** Live task-board snapshot (todo progress line). */
  todos: TodoUpdatePayload | null;
  /** Live subagent/fork activity (Agents panel). */
  subagents: SubagentInfo[];
  /** Background agent/shell tasks. */
  backgroundTasks: BackgroundTaskInfo[];
  /** In-process teammate states. */
  teammates: TeammateInfo[];
  /** Messages queued while steering was unavailable; replayed when idle. */
  followUps: string[];
  /** Active provider name (status payload). */
  provider: string;
  /** Thinking levels the active client supports. */
  thinkingLevels: string[];
  sandboxEnabled: boolean;
  sandboxAutoAllow: boolean;
  /** Open model picker state, if any. */
  modelPicker: ModelListPayload | null;
  /** Open provider dialog state, if any. */
  providerPicker: ProviderListPayload | null;
  /** Open rewind checkpoint list, if any. */
  rewindPicker: RewindSnapshot[] | null;
  /** Open thinking-level picker, if any. */
  thinkingPicker: ThinkingFormPayload | null;
  /** Latest @-mention completion response for the input. */
  fileMatches: FileCompleteResponsePayload | null;
  /** Settled image uploads awaiting consumption by the input. */
  imageResults: ImageResultPayload[];
}

export const initialState: ChatState = {
  items: [],
  transcriptRevision: 0,
  connection: "connecting",
  session: "",
  cwd: "",
  commands: [],
  usage: null,
  streaming: false,
  model: "",
  permissionMode: "",
  thinkingLevel: "",
  steering: [],
  planApproval: null,
  sessions: null,
  codeReviewOpen: false,
  currentAssistantId: null,
  currentThinkingId: null,
  history: [],
  todos: null,
  subagents: [],
  backgroundTasks: [],
  teammates: [],
  followUps: [],
  provider: "",
  thinkingLevels: [],
  sandboxEnabled: false,
  sandboxAutoAllow: false,
  modelPicker: null,
  providerPicker: null,
  rewindPicker: null,
  thinkingPicker: null,
  fileMatches: null,
  imageResults: [],
};

type Action =
  | { kind: "message"; message: ServerMessage }
  | { kind: "connection"; status: ConnectionStatus }
  | { kind: "respondPermission"; id: string; response: PermissionResponse }
  | { kind: "markAskAnswered"; id: string }
  | { kind: "closePlanApproval" }
  | { kind: "closeSessions" }
  | { kind: "closeCodeReview" }
  | { kind: "closeModelPicker" }
  | { kind: "closeProviderPicker" }
  | { kind: "closeRewindPicker" }
  | { kind: "closeThinkingPicker" }
  | { kind: "openThinkingPicker" }
  | { kind: "appendHistory"; text: string }
  | { kind: "consumeImageResult"; clientId: string };

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

/** Marks any open review progress card as finished. */
function finalizeReviews(state: ChatState): ChatState {
  if (!state.items.some((it) => it.kind === "review" && !it.done)) {
    return state;
  }
  return {
    ...state,
    items: state.items.map((it) =>
      it.kind === "review" && !it.done ? { ...it, done: true } : it,
    ),
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled reducer value: ${JSON.stringify(value)}`);
}

function applyMessage(state: ChatState, msg: ServerMessage): ChatState {
  switch (msg.type) {
    case "connected": {
      // Defensive: the server defers "connected" until the agent exists, so
      // session is normally non-empty; keep the guard for empty payloads.
      if (!msg.data.session) {
        return {
          ...state,
          cwd: msg.data.cwd || state.cwd,
          streaming: msg.data.streaming,
        };
      }
      return {
        ...state,
        session: msg.data.session,
        cwd: msg.data.cwd,
        streaming: msg.data.streaming,
      };
    }

    case "commands":
      return { ...state, commands: msg.data ?? [] };

    case "status":
      return {
        ...state,
        model: msg.data.model,
        provider: msg.data.provider,
        permissionMode: msg.data.permissionMode,
        thinkingLevel: msg.data.thinkingLevel,
        thinkingLevels: msg.data.thinkingLevels,
        sandboxEnabled: msg.data.sandboxEnabled,
        sandboxAutoAllow: msg.data.sandboxAutoAllow,
      };

    case "session_list":
      return { ...state, sessions: msg.data.sessions };

    case "plan_approval_closed":
      return state.planApproval?.id === msg.data.id
        ? { ...state, planApproval: null }
        : state;

    case "plan_approval_request":
      return { ...state, planApproval: msg.data };

    case "code_review_form":
      return { ...state, codeReviewOpen: true };

    case "code_review_progress": {
      const open = state.items.findLast(
        (it): it is ReviewItem => it.kind === "review" && !it.done,
      );
      if (open) {
        return {
          ...state,
          items: state.items.map((it) =>
            it.kind === "review" && it.id === open.id
              ? {
                  ...it,
                  phase: msg.data.phase,
                  message: msg.data.message,
                  progress: msg.data.progress ?? null,
                }
              : it,
          ),
        };
      }
      const item: ReviewItem = {
        kind: "review",
        id: nextId("rev"),
        phase: msg.data.phase,
        message: msg.data.message,
        progress: msg.data.progress ?? null,
        done: false,
      };
      return { ...state, items: [...state.items, item] };
    }

    case "steering_queued":
      return { ...state, steering: [...state.steering, msg.data.text] };

    case "steering_delivered": {
      const index = state.steering.indexOf(msg.data.text);
      const steering =
        index === -1
          ? state.steering
          : state.steering.filter((_, i) => i !== index);
      return {
        ...state,
        steering,
        items: [
          ...state.items,
          { kind: "user", id: nextId("usr"), content: msg.data.text },
        ],
      };
    }

    case "system":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "system",
            id: nextId("sys"),
            content: msg.data.message,
            markdown: msg.data.markdown,
          },
        ],
      };

    case "clear":
      return {
        ...state,
        transcriptRevision: state.transcriptRevision + 1,
        currentAssistantId: null,
        currentThinkingId: null,
        steering: [],
        followUps: [],
        planApproval: null,
        sessions: null,
        codeReviewOpen: false,
        items: [
          {
            kind: "system",
            id: nextId("sys"),
            content: "Conversation cleared.",
          },
        ],
      };

    case "command_done":
      return finalizeReviews(state);

    case "run_state": {
      if (msg.data.streaming) {
        return { ...state, streaming: true };
      }
      const next = finalizeReviews(
        finalizeCurrentThinking(finalizeAssistant(state)),
      );
      return { ...next, streaming: false, steering: [] };
    }

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
            mcpApp: msg.data.mcpApp,
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
        mcpApp: msg.data.mcpApp,
      };
      return { ...state, items: [...state.items, item] };
    }

    case "mcp_app_response":
      return state;

    case "permission_request":
      return {
        ...state,
        items: [
          ...state.items.filter(
            (item) => item.kind !== "permission" || item.id !== msg.data.id,
          ),
          {
            kind: "permission",
            id: msg.data.id,
            toolName: msg.data.toolName,
            description: msg.data.description,
            rememberPatterns: msg.data.rememberPatterns,
            responded: false,
            response: null,
          },
        ],
      };

    case "ask_user":
      return {
        ...state,
        items: [
          ...state.items.filter(
            (item) => item.kind !== "askUser" || item.id !== msg.data.id,
          ),
          {
            kind: "askUser",
            id: msg.data.id,
            questions: msg.data.questions,
            answered: false,
          },
        ],
      };

    case "request_expired":
      return {
        ...state,
        items: state.items.map((item) => {
          if (
            msg.data.kind === "permission" &&
            item.kind === "permission" &&
            item.id === msg.data.id
          ) {
            return {
              ...item,
              responded: true,
              response: msg.data.response ?? "deny",
            };
          }
          if (
            msg.data.kind === "ask" &&
            item.kind === "askUser" &&
            item.id === msg.data.id
          ) {
            return { ...item, answered: true };
          }
          return item;
        }),
      };

    case "turn_complete":
      return state;

    case "loop_complete": {
      let next = finalizeAssistant(state);
      next = finalizeCurrentThinking(next);
      next = finalizeReviews(next);
      return {
        ...next,
        items: [
          ...next.items,
          { kind: "done", id: nextId("done"), elapsed: msg.data.elapsed },
        ],
      };
    }

    case "usage":
      return { ...state, usage: msg.data };

    case "error": {
      // Mirror loop_complete: the run is over, so close the streaming
      // assistant/thinking/review items instead of leaving the cursor
      // blinking and currentAssistantId appending future text into them.
      let next = finalizeAssistant(state);
      next = finalizeCurrentThinking(next);
      next = finalizeReviews(next);
      return {
        ...next,
        items: [
          ...next.items,
          { kind: "error", id: nextId("err"), content: msg.data.message },
        ],
      };
    }

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

    case "history":
      return { ...state, history: msg.data.entries };

    case "todo_update":
      return {
        ...state,
        todos:
          msg.data.tasks.length === 0
            ? null
            : { boardId: msg.data.boardId, tasks: msg.data.tasks },
      };

    case "subagents":
      return { ...state, subagents: msg.data.list };

    case "background_tasks":
      return { ...state, backgroundTasks: msg.data.list };

    case "teammates":
      return { ...state, teammates: msg.data.list };

    case "followups":
      return { ...state, followUps: msg.data.list };

    case "model_list":
      return { ...state, modelPicker: msg.data };

    case "provider_list":
      return { ...state, providerPicker: msg.data };

    case "rewind_list":
      return { ...state, rewindPicker: msg.data.snapshots };

    case "thinking_form":
      return { ...state, thinkingPicker: msg.data };

    case "file_complete_response":
      return { ...state, fileMatches: msg.data };

    case "image_saved":
      return {
        ...state,
        imageResults: [
          ...state.imageResults,
          { clientId: msg.data.clientId, path: msg.data.path },
        ],
      };

    case "image_error":
      return {
        ...state,
        imageResults: [
          ...state.imageResults,
          { clientId: msg.data.clientId, message: msg.data.message },
        ],
      };

    case "tool_output": {
      const toolId = msg.data.toolId;
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === "tool" && it.toolId === toolId && it.status === "running"
            ? { ...it, output: msg.data.output }
            : it,
        ),
      };
    }

    default:
      return assertNever(msg);
  }
}

export function chatReducer(state: ChatState, action: Action): ChatState {
  switch (action.kind) {
    case "connection":
      return { ...state, connection: action.status };

    case "message":
      return trimChatItems(applyMessage(state, action.message));

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

    case "closePlanApproval":
      return { ...state, planApproval: null };

    case "closeSessions":
      return { ...state, sessions: null };

    case "closeCodeReview":
      return { ...state, codeReviewOpen: false };

    case "closeModelPicker":
      return { ...state, modelPicker: null };

    case "closeProviderPicker":
      return { ...state, providerPicker: null };

    case "closeRewindPicker":
      return { ...state, rewindPicker: null };

    case "closeThinkingPicker":
      return { ...state, thinkingPicker: null };

    case "openThinkingPicker":
      return {
        ...state,
        thinkingPicker: {
          current: state.thinkingLevel,
          levels: state.thinkingLevels,
        },
      };

    case "appendHistory": {
      const text = action.text.trim();
      if (!text) {
        return state;
      }
      const history =
        state.history[state.history.length - 1] === text
          ? state.history
          : [...state.history, text];
      return { ...state, history };
    }

    case "consumeImageResult":
      return {
        ...state,
        imageResults: state.imageResults.filter(
          (entry) => entry.clientId !== action.clientId,
        ),
      };

    default:
      return assertNever(action);
  }
}

export interface ChatApi {
  state: ChatState;
  dispatchMessage: (message: ServerMessage) => void;
  setConnection: (status: ConnectionStatus) => void;
  respondPermission: (id: string, response: PermissionResponse) => void;
  markAskAnswered: (id: string) => void;
  closePlanApproval: () => void;
  closeSessions: () => void;
  closeCodeReview: () => void;
  closeModelPicker: () => void;
  closeProviderPicker: () => void;
  closeRewindPicker: () => void;
  closeThinkingPicker: () => void;
  openThinkingPicker: () => void;
  appendHistory: (text: string) => void;
  consumeImageResult: (clientId: string) => void;
}

export function useChat(): ChatApi {
  const [state, dispatch] = useReducer(chatReducer, initialState);

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

  const closePlanApproval = useCallback(() => {
    dispatch({ kind: "closePlanApproval" });
  }, []);

  const closeSessions = useCallback(() => {
    dispatch({ kind: "closeSessions" });
  }, []);

  const closeCodeReview = useCallback(() => {
    dispatch({ kind: "closeCodeReview" });
  }, []);

  const closeModelPicker = useCallback(() => {
    dispatch({ kind: "closeModelPicker" });
  }, []);

  const closeProviderPicker = useCallback(() => {
    dispatch({ kind: "closeProviderPicker" });
  }, []);

  const closeRewindPicker = useCallback(() => {
    dispatch({ kind: "closeRewindPicker" });
  }, []);

  const closeThinkingPicker = useCallback(() => {
    dispatch({ kind: "closeThinkingPicker" });
  }, []);

  const openThinkingPicker = useCallback(() => {
    dispatch({ kind: "openThinkingPicker" });
  }, []);

  const appendHistory = useCallback((text: string) => {
    dispatch({ kind: "appendHistory", text });
  }, []);

  const consumeImageResult = useCallback((clientId: string) => {
    dispatch({ kind: "consumeImageResult", clientId });
  }, []);

  return {
    state,
    dispatchMessage,
    setConnection,
    respondPermission,
    markAskAnswered,
    closePlanApproval,
    closeSessions,
    closeCodeReview,
    closeModelPicker,
    closeProviderPicker,
    closeRewindPicker,
    closeThinkingPicker,
    openThinkingPicker,
    appendHistory,
    consumeImageResult,
  };
}
