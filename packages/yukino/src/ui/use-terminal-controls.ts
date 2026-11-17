import { useInput } from "ink";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

interface Options {
  hasRunningWork: boolean;
  clearInputRef: RefObject<(() => void) | null>;
  onInterrupt: () => void;
  onExit: () => void;
  /** Move every running foreground Bash/PowerShell task to the background (Ctrl+B). */
  onBackgroundShells?: () => void;
  /**
   * True while a modal dialog owns the keyboard. Global shortcuts that belong
   * to the main chat input (Ctrl+B backgrounding) stand down so a dialog's own
   * Ctrl+B (cursor-back in its TextField) is not double-fired — Ink dispatches
   * every mounted useInput handler.
   */
  modalActive?: boolean;
}

export function useTerminalControls({
  hasRunningWork,
  clearInputRef,
  onInterrupt,
  onExit,
  onBackgroundShells,
  modalActive,
}: Options) {
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [ctrlCHint, setCtrlCHint] = useState(false);
  const ctrlCCountRef = useRef(0);
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Single reset for the exit-prompt state so the hint, the press count and the
  // pending timer never drift apart (e.g. a stale "press again to exit" left
  // over after an interrupt).
  const resetCtrlC = useCallback(() => {
    ctrlCCountRef.current = 0;
    setCtrlCHint(false);
    if (ctrlCTimerRef.current) {
      clearTimeout(ctrlCTimerRef.current);
      ctrlCTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      if (ctrlCTimerRef.current) {
        clearTimeout(ctrlCTimerRef.current);
      }
    },
    [],
  );

  // Starting work invalidates any pending idle exit prompt.
  useEffect(() => {
    if (hasRunningWork) {
      resetCtrlC();
    }
  }, [hasRunningWork, resetCtrlC]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (hasRunningWork) {
        onInterrupt();
        resetCtrlC();
        return;
      }
      ctrlCCountRef.current += 1;
      if (ctrlCCountRef.current >= 2) {
        onExit();
        return;
      }
      clearInputRef.current?.();
      setCtrlCHint(true);
      if (ctrlCTimerRef.current) {
        clearTimeout(ctrlCTimerRef.current);
      }
      ctrlCTimerRef.current = setTimeout(() => {
        ctrlCCountRef.current = 0;
        setCtrlCHint(false);
      }, 2000);
      return;
    }

    if (ctrlCCountRef.current > 0) {
      resetCtrlC();
    }
  });

  useInput((input, key) => {
    if (key.ctrl && input === "o") {
      setToolsExpanded((expanded) => !expanded);
    }
  });

  // Ctrl+B moves running foreground shell tasks to the background.
  // Under tmux the first press is swallowed as the tmux prefix, so users press
  // twice. Suppressed while any modal dialog owns the keyboard (modalActive) so
  // a dialog TextField's own Ctrl+B cursor-back is not double-fired; the
  // callback is additionally a no-op unless a foreground task is running.
  useInput((input, key) => {
    if (key.ctrl && input === "b" && !modalActive) {
      onBackgroundShells?.();
    }
  });

  return { toolsExpanded, ctrlCHint };
}
