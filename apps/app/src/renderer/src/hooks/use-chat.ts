// Owns the chat reducer, the bridge event subscription, and every action the
// UI can trigger. Components stay presentational.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type {
  BridgeEvent,
  PermissionResponse,
  SessionSummary,
} from "@shared/ipc-types";
import {
  chatReducer,
  initialChatState,
  type ChatState,
} from "@renderer/lib/chat-state";

export interface UseChat {
  state: ChatState;
  send(text: string): void;
  abort(): void;
  startNewSession(): void;
  refreshSessions(): void;
  resumeSession(sessionId: string): void;
  chooseFolder(): void;
  respondPermission(id: string, response: PermissionResponse): void;
  respondAsk(id: string, answers: Record<string, string>): void;
  themeMode: "system" | "light" | "dark";
  setThemeMode(mode: "system" | "light" | "dark"): void;
  isDark: boolean;
}

export function useChat(): UseChat {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [themeMode, setThemeModeState] = useState<"system" | "light" | "dark">(
    "system",
  );
  const [isDark, setIsDark] = useState(false);
  const initStarted = useRef(false);

  const applyEvent = useCallback((event: BridgeEvent) => {
    dispatch({ type: "event", event });
  }, []);

  // Subscribe to the bridge event stream and native theme changes.
  useEffect(() => {
    const offEvent = window.api.onEvent(applyEvent);
    const offTheme = window.api.onTheme((theme) => setIsDark(theme === "dark"));
    return () => {
      offEvent();
      offTheme();
    };
  }, [applyEvent]);

  // One-time bootstrap: theme, init the agent stack. The init result also
  // arrives as an `init_state` BridgeEvent; the event stream is the single
  // source of truth for chat state (folder changes re-emit it too).
  useEffect(() => {
    if (initStarted.current) return;
    initStarted.current = true;
    void window.api.getTheme().then((theme) => {
      setThemeModeState(theme.mode);
      setIsDark(theme.dark);
    });
    void window.api.init();
  }, []);

  // Reflect the .dark class for the shadcn custom dark variant.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    dispatch({ type: "append_user", text: trimmed });
    void window.api.send(trimmed);
  }, []);

  const abort = useCallback(() => {
    void window.api.abort();
  }, []);

  const refreshSessions = useCallback(() => {
    void window.api.listSessions().then((sessions: SessionSummary[]) => {
      dispatch({ type: "set_sessions", sessions });
    });
  }, []);

  const startNewSession = useCallback(() => {
    dispatch({ type: "clear_items" });
    void window.api.newSession();
  }, []);

  const resumeSession = useCallback((sessionId: string) => {
    dispatch({ type: "clear_items" });
    void window.api.resumeSession(sessionId).then((result) => {
      dispatch({ type: "load_history", messages: result.messages });
    });
  }, []);

  const chooseFolder = useCallback(() => {
    // The bridge re-initializes the agent for the chosen folder and emits a
    // fresh `init_state` event through the stream.
    dispatch({ type: "clear_items" });
    void window.api.selectFolder();
  }, []);

  const respondPermission = useCallback(
    (id: string, response: PermissionResponse) => {
      void window.api.respondPermission(id, response);
    },
    [],
  );

  const respondAsk = useCallback(
    (id: string, answers: Record<string, string>) => {
      void window.api.respondAsk(id, answers);
    },
    [],
  );

  const setThemeMode = useCallback((mode: "system" | "light" | "dark") => {
    setThemeModeState(mode);
    void window.api.setTheme(mode);
    // Apply immediately so the UI doesn't wait for the round-trip broadcast.
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    setIsDark(mode === "dark" || (mode === "system" && prefersDark));
  }, []);

  // Track OS theme flips while in system mode.
  useEffect(() => {
    if (themeMode !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent): void =>
      setIsDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [themeMode]);

  return {
    state,
    send,
    abort,
    startNewSession,
    refreshSessions,
    resumeSession,
    chooseFolder,
    respondPermission,
    respondAsk,
    themeMode,
    setThemeMode,
    isDark,
  };
}
