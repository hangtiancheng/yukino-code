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

import { useInput, useStdout } from "ink";
import { useEffect, useRef, useState, type RefObject } from "react";

interface Options {
  isStreaming: boolean;
  hasRunningWork: boolean;
  clearInputRef: RefObject<(() => void) | null>;
  onInterrupt: () => void;
  onExit: () => void;
  teamsDialogOpen: boolean;
  onToggleTeams: () => void;
  /** Move every running foreground Bash/PowerShell task to the background (Ctrl+B). */
  onBackgroundShells?: () => void;
}

export function useTerminalControls({
  isStreaming,
  hasRunningWork,
  clearInputRef,
  onInterrupt,
  onExit,
  teamsDialogOpen,
  onToggleTeams,
  onBackgroundShells,
}: Options) {
  const { stdout } = useStdout();
  const termWidthRef = useRef(stdout.columns || 80);
  const [termWidth, setTermWidth] = useState(termWidthRef.current);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [ctrlCHint, setCtrlCHint] = useState(false);
  const ctrlCCountRef = useRef(0);
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        const width = stdout.columns || 80;
        if (width === termWidthRef.current) {
          return;
        }
        termWidthRef.current = width;
        // Rewrapped Static rows require a viewport clear; retain native scrollback.
        stdout.write("\x1b[2J\x1b[H");
        setTermWidth(width);
      }, 150);
    };
    stdout.on("resize", onResize);
    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      stdout.off("resize", onResize);
    };
  }, [stdout]);

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

    if (input.includes("[<") && /\[<\d+;\d+;\d+[Mm]/.test(input)) {
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
      // Static content must be remounted to reflect expanded tool output.
      stdout.write("\x1b[2J\x1b[H");
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

  useInput(
    (input, key) => {
      if (key.ctrl && input === "t" && !isStreaming) {
        onToggleTeams();
      }
    },
    { isActive: !teamsDialogOpen },
  );

  return { termWidth, toolsExpanded, ctrlCHint };
}
