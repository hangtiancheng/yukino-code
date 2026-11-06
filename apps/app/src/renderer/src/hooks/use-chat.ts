// Owns the chat reducer, the bridge event subscription, and every action the
// UI can trigger. Components stay presentational.

import {
  chatReducer,
  initialChatState,
  type ChatState,
} from "@renderer/lib/chat-state";
import type {
  BridgeEvent,
  PermissionResponse,
  SessionSummary,
} from "@shared/ipc-types";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";

export interface UseChat {
  state: ChatState;
  send: (text: string) => void;
  abort: () => void;
  startNewSession: () => void;
  resumeSession: (sessionId: string, cwd?: string) => void;
  chooseFolder: () => void;
  respondPermission: (id: string, response: PermissionResponse) => void;
  respondAsk: (id: string, answers: Record<string, string>) => void;
  themeMode: "system" | "light" | "dark";
  setThemeMode: (mode: "system" | "light" | "dark") => void;
  isDark: boolean;
  retry: () => void;
}

const reportError = (error: unknown): void => {
  toast.error(error instanceof Error ? error.message : String(error));
};

export function useChat(): UseChat {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [themeMode, setThemeModeState] = useState<"system" | "light" | "dark">(
    "system",
  );
  const [isDark, setIsDark] = useState(false);
  const initStarted = useRef(false);
  const navigating = useRef(false);

  const refreshSessions = useCallback(() => {
    void window.api
      .listSessions()
      .then((sessions: SessionSummary[]) => {
        dispatch({ type: "set_sessions", sessions });
      })
      .catch(reportError);
  }, []);

  const applyEvent = useCallback(
    (event: BridgeEvent) => {
      dispatch({ type: "event", event });
      // Session files change on disk when a run finishes or a session is
      // created/loaded — keep the sidebar list in sync.
      if (
        event.type === "init_state" ||
        event.type === "session_changed" ||
        event.type === "loop_complete"
      ) {
        refreshSessions();
      }
    },
    [refreshSessions],
  );

  // Subscribe to the bridge event stream and native theme changes.
  useEffect(() => {
    let frame: number | undefined;
    let pending: BridgeEvent[] = [];
    const flush = (): void => {
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
        frame = undefined;
      }
      const events = pending;
      pending = [];
      for (const event of events) {
        applyEvent(event);
      }
    };
    const offEvent = window.api.onEvent((event) => {
      if (event.type === "stream_text" || event.type === "thinking_text") {
        const last = pending.at(-1);
        if (last?.type === event.type) {
          last.data.text += event.data.text;
        } else {
          pending.push({ ...event, data: { ...event.data } });
        }
        frame ??= requestAnimationFrame(flush);
      } else {
        flush();
        applyEvent(event);
      }
    });
    const offTheme = window.api.onTheme((theme) => {
      setIsDark(theme === "dark");
    });
    return () => {
      offEvent();
      offTheme();
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
    };
  }, [applyEvent]);

  // One-time bootstrap: theme, init the agent stack. The init result also
  // arrives as an `init_state` BridgeEvent; the event stream is the single
  // source of truth for chat state (folder changes re-emit it too).
  useEffect(() => {
    if (initStarted.current) {
      return;
    }
    initStarted.current = true;
    void window.api
      .getTheme()
      .then((theme) => {
        setThemeModeState(theme.mode);
        setIsDark(theme.dark);
      })
      .catch(reportError);
    void window.api
      .init()
      .then((data) => {
        dispatch({ type: "init_state", data });
      })
      .catch((error: unknown) => {
        dispatch({
          type: "init_state",
          data: {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      });
  }, []);

  // Reflect the .dark class for the shadcn custom dark variant.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || navigating.current) {
      return;
    }
    dispatch({ type: "append_user", text: trimmed });
    void window.api.send(trimmed).catch(reportError);
  }, []);

  const abort = useCallback(() => {
    void window.api.abort().catch(reportError);
  }, []);

  const navigate = useCallback((operation: () => Promise<unknown>) => {
    if (navigating.current) {
      return;
    }
    navigating.current = true;
    dispatch({ type: "set_initializing", value: true });
    void operation()
      .catch(reportError)
      .finally(() => {
        navigating.current = false;
        dispatch({ type: "set_initializing", value: false });
      });
  }, []);

  const startNewSession = useCallback(() => {
    navigate(() => window.api.newSession());
  }, [navigate]);

  const resumeSession = useCallback(
    (sessionId: string, cwd?: string) => {
      navigate(async () => {
        const result = await window.api.resumeSession(sessionId, cwd);
        dispatch({ type: "load_history", messages: result.messages });
        if (result.switchedCwd) {
          toast.success("已切换项目");
        }
      });
    },
    [navigate],
  );

  const chooseFolder = useCallback(() => {
    navigate(async () => {
      const result = await window.api.selectFolder();
      if (result.cwd) {
        dispatch({ type: "clear_items" });
      }
    });
  }, [navigate]);

  const respondPermission = useCallback(
    (id: string, response: PermissionResponse) => {
      void window.api.respondPermission(id, response).catch(reportError);
    },
    [],
  );

  const respondAsk = useCallback(
    (id: string, answers: Record<string, string>) => {
      void window.api.respondAsk(id, answers).catch(reportError);
    },
    [],
  );

  const setThemeMode = useCallback((mode: "system" | "light" | "dark") => {
    setThemeModeState(mode);
    void window.api.setTheme(mode).catch(reportError);
    // Apply immediately so the UI doesn't wait for the round-trip broadcast.
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    setIsDark(mode === "dark" || (mode === "system" && prefersDark));
  }, []);

  // Track OS theme flips while in system mode.
  useEffect(() => {
    if (themeMode !== "system") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent): void => {
      setIsDark(event.matches);
    };
    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, [themeMode]);

  return {
    state,
    send,
    abort,
    startNewSession,
    resumeSession,
    chooseFolder,
    respondPermission,
    respondAsk,
    themeMode,
    setThemeMode,
    isDark,
    retry: () => {
      dispatch({ type: "set_initializing", value: true });
      void window.api
        .init()
        .then((data) => {
          dispatch({ type: "init_state", data });
        })
        .catch((error: unknown) => {
          dispatch({ type: "set_initializing", value: false });
          reportError(error);
        });
    },
  };
}
