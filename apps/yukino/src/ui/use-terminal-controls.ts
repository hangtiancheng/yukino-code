import { useInput } from "ink";
import { useEffect, useRef, useState, type RefObject } from "react";

interface Options {
  hasRunningWork: boolean;
  clearInputRef: RefObject<(() => void) | null>;
  onInterrupt: () => void;
  onExit: () => void;
  /** Move every running foreground Bash/PowerShell task to the background (Ctrl+B). */
  onBackgroundShells?: () => void;
}

export function useTerminalControls({
  hasRunningWork,
  clearInputRef,
  onInterrupt,
  onExit,
  onBackgroundShells,
}: Options) {
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [ctrlCHint, setCtrlCHint] = useState(false);
  const ctrlCCountRef = useRef(0);
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (ctrlCTimerRef.current) {
        clearTimeout(ctrlCTimerRef.current);
      }
    },
    [],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (hasRunningWork) {
        onInterrupt();
        ctrlCCountRef.current = 0;
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
      ctrlCCountRef.current = 0;
      setCtrlCHint(false);
      if (ctrlCTimerRef.current) {
        clearTimeout(ctrlCTimerRef.current);
        ctrlCTimerRef.current = null;
      }
    }
  });

  useInput((input, key) => {
    if (key.ctrl && input === "o") {
      setToolsExpanded((expanded) => !expanded);
    }
  });

  // Ctrl+B moves running foreground shell tasks to the background.
  // Under tmux the first press is swallowed as the tmux prefix, so users press
  // twice. The callback is a no-op unless a foreground task is actually
  // running, which keeps the keypress out of unrelated contexts (e.g. the
  // provider-login form also binds Ctrl+B to cursor-back).
  useInput((input, key) => {
    if (key.ctrl && input === "b") {
      onBackgroundShells?.();
    }
  });

  return { toolsExpanded, ctrlCHint };
}
