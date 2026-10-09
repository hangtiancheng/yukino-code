import { readdirSync, statSync } from "fs";
import { join, relative } from "path";

import Fuse from "fuse.js";
import { Box, Text, useInput, usePaste } from "ink";
import type { Key } from "ink";
import { useState, useMemo, useRef, useEffect } from "react";

import { CursorText } from "./cursor-text.js";
import { useInputDraft } from "./input-draft.js";
import type { InputDraft } from "./input-draft.js";
import {
  layoutInputRows,
  locateInputCursor,
  moveInputVertically,
} from "./input-navigation.js";
import {
  collapseImage,
  collapsePaste,
  expandPastes,
  inputBoundary,
} from "./input-paste.js";
import { getListWindowStart } from "./list-window.js";
import { StatusBorder } from "./status-border.js";
import { truncateToWidth, visibleWidth } from "./terminal-text.js";
import {
  useAvailableRows,
  useTerminalDimensions,
} from "./use-terminal-layout.js";
import { parseUserBashCommand } from "./use-user-bash.js";

import type { Command } from "@/commands/commands.js";
import type { CommandUsageTracker } from "@/commands/usage-tracker.js";
import {
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@/config/provider-config.js";
import { saveClipboardImage } from "@/images/clipboard.js";
import { createChildLogger } from "@/logger/index.js";
import type { PermissionMode } from "@/permissions/index.js";
import { SKIP_DIRS } from "@/tools/types.js";
import { ICONS, THEME } from "@/ui/styles.js";

const log = createChildLogger({ module: "input" });

const COMMAND_TAGS = ["[skill]", "[custom]"];
// @-mention cache lifetime: covers edits made outside the app (user editor,
// git) that produce no fileFactsVersion bump.
const FILE_CACHE_TTL_MS = 30_000;
const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

function scanCwdFiles(root: string, max = 2000): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    if (out.length >= max) {
      return;
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      log.error({ err }, "cwd scan failed");
      return;
    }
    for (const name of names) {
      if (out.length >= max) {
        return;
      }
      if (name.startsWith(".") || SKIP_DIRS.has(name)) {
        continue;
      }
      const full = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch (err) {
        log.error({ err }, "cwd scan failed");
        continue;
      }
      if (isDir) {
        walk(full, relPath);
      } else {
        out.push(relPath);
      }
    }
  };
  walk(root, "");
  return out;
}

export type { InputDraft } from "./input-draft.js";

const PERMISSION_MODE_CYCLE: Exclude<PermissionMode, "plan">[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
];

interface InputBoxProps {
  onSubmit: ((text: string) => void) | ((text: string) => boolean);
  /** Atomically pop the latest queued message, only when Up starts on a clean draft. */
  onRecallQueuedMessage?: () => string | undefined;
  onOpenAgents?: () => void;
  disabled?: boolean;
  history?: string[];
  commands?: Command[];
  thinkingLevels?: readonly ThinkingLevel[];
  onEscape?: () => void;
  inputState?: "idle" | "focused" | "agent" | "error";
  borderColor?: string;
  statusLabel?: string;
  usageTracker?: CommandUsageTracker;
  permMode?: PermissionMode;
  onModeChange?: (mode: Exclude<PermissionMode, "plan">) => void;
  cwd?: string;
  sessionId?: string;
  /** Bumped by the parent when workspace file facts change (file writes, agent
   *  run end); the @-mention cache rebuilds when it moves. A short TTL covers
   *  external edits (user editor, git) that produce no bump. */
  fileFactsVersion?: number;
  /** Receives an insert-at-cursor function so the parent can inject text
   *  (e.g. IDE at-mentions) into the input programmatically. */
  insertTextRef?: { current: ((text: string) => void) | null };
  /** Receives a function that clears the input draft, so the parent can
   *  bind it to shortcuts handled outside this component (e.g. Ctrl+C). */
  clearRef?: { current: (() => void) | null };
  /** Owned by the dock so selectors can unmount the input without losing edits. */
  draftRef?: { current: InputDraft | null };
}

export function InputBox(props: InputBoxProps) {
  const {
    onSubmit,
    onRecallQueuedMessage,
    onOpenAgents,
    disabled,
    history = [],
    commands = [],
    thinkingLevels = THINKING_LEVELS,
    onEscape,
    inputState = "idle",
    borderColor: requestedBorderColor,
    statusLabel,
    usageTracker,
    permMode = "default",
    onModeChange,
    cwd = ".",
    sessionId = "default",
    fileFactsVersion = 0,
    insertTextRef,
    clearRef,
    draftRef,
  } = props;
  const { columns: borderWidth, rows: terminalRows } = useTerminalDimensions();
  const availableRows = useAvailableRows(2);
  const horizontalPadding = borderWidth > 2 ? 1 : 0;
  const rowWidth = borderWidth - horizontalPadding * 2;
  const preferredColumnRef = useRef<{ width: number; column: number } | null>(
    null,
  );

  const {
    lines,
    setLines,
    cursorLine,
    setCursorLine,
    cursorCol,
    setCursorCol,
    historyIndex,
    setHistoryIndex,
    setHistoryDraft,
    pastes,
    setPastes,
    getDraft,
  } = useInputDraft(draftRef);
  const [dropdownIndex, setDropdownIndex] = useState(0);
  const [dropdownDismissed, setDropdownDismissed] = useState(false);
  const [pasteError, setPasteError] = useState("");
  const [statusFrame, setStatusFrame] = useState(0);
  const pasteImageInflightRef = useRef(false);
  const pasteGenerationRef = useRef(0);
  const [isPastingImage, setIsPastingImage] = useState(false);
  const [cwdFiles, setCwdFiles] = useState<string[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!statusLabel || inputState === "error") {
      return;
    }
    const timer = setInterval(() => {
      setStatusFrame((current) => (current + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => {
      clearInterval(timer);
    };
  }, [statusLabel, inputState]);

  useEffect(() => {
    if (!insertTextRef) {
      return;
    }
    insertTextRef.current = (text: string) => {
      const { lines, cursorLine, cursorCol, pastes } = getDraft();
      const line = lines[cursorLine] ?? "";
      const col = inputBoundary(line, cursorCol, "clamp", pastes);
      const before = line.slice(0, col);
      const pad = before.length > 0 && !/\s$/.test(before) ? " " : "";
      const inserted = pad + text;
      preferredColumnRef.current = null;
      setLines((prev) => {
        const updated = [...prev];
        const l = updated[cursorLine] ?? "";
        updated[cursorLine] = l.slice(0, col) + inserted + l.slice(col);
        return updated;
      });
      setCursorCol(col + inserted.length);
    };
    return () => {
      insertTextRef.current = null;
    };
  }, [insertTextRef, getDraft, setLines, setCursorCol]);

  useEffect(() => {
    if (!clearRef) {
      return;
    }
    clearRef.current = () => {
      // While disabled (provider switching) the draft is hidden; leave it
      // intact so it reappears unchanged when the input re-enables.
      if (disabled) {
        return;
      }
      preferredColumnRef.current = null;
      setLines([""]);
      setCursorLine(0);
      setCursorCol(0);
      setHistoryIndex(-1);
      setHistoryDraft(null);
      setPastes(undefined);
      pasteGenerationRef.current++;
      pasteImageInflightRef.current = false;
      setIsPastingImage(false);
      setDropdownIndex(0);
      setDropdownDismissed(false);
      setPasteError("");
    };
    return () => {
      clearRef.current = null;
    };
  }, [
    clearRef,
    disabled,
    setLines,
    setCursorLine,
    setCursorCol,
    setHistoryIndex,
    setHistoryDraft,
    setPastes,
  ]);

  const isMultiline = lines.length > 1;

  const { filteredCmds, recentCount } = useMemo(() => {
    const first = lines[0];
    if (!first.startsWith("/") || isMultiline) {
      return { filteredCmds: [], recentCount: 0 };
    }
    const query = first.slice(1).toLowerCase();
    const thinkingMatch = /^(thinking|think)[ \t]+([a-z]*)$/u.exec(query);
    const thinkingCommand = commands.find(
      (command) => command.name === "thinking",
    );
    if (thinkingMatch && thinkingCommand) {
      return {
        filteredCmds: thinkingLevels
          .filter((level) => level.startsWith(thinkingMatch[2]))
          .map((level) => ({
            ...thinkingCommand,
            name: `${thinkingMatch[1]} ${level}`,
            aliases: [],
            description: `Set thinking to ${level}`,
          })),
        recentCount: 0,
      };
    }
    if (/\s/u.test(query)) {
      return { filteredCmds: [], recentCount: 0 };
    }
    if (!query) {
      if (!usageTracker) {
        return { filteredCmds: commands, recentCount: 0 };
      }
      const recentNames = new Set(usageTracker.getRecentlyUsed(5));
      const recent = commands.filter((c) => recentNames.has(c.name));
      const rest = commands.filter((c) => !recentNames.has(c.name));
      return { filteredCmds: [...recent, ...rest], recentCount: recent.length };
    }

    const seen = new Set<string>();
    const result: Command[] = [];
    const add = (cmd: Command) => {
      if (!seen.has(cmd.name)) {
        seen.add(cmd.name);
        result.push(cmd);
      }
    };

    // Tier 1: exact name
    for (const c of commands) {
      if (c.name.toLowerCase() === query) {
        add(c);
      }
    }
    // Tier 2: prefix name
    for (const c of commands) {
      if (c.name.toLowerCase().startsWith(query)) {
        add(c);
      }
    }
    // Tier 3: fuzzy match
    const fuse = new Fuse(commands, {
      keys: [
        { name: "name", weight: 3 },
        { name: "aliases", weight: 2 },
        { name: "description", weight: 0.5 },
      ],
      threshold: 0.4,
      includeScore: true,
    });

    for (const r of fuse.search(query)) {
      add(r.item);
    }

    return { filteredCmds: result, recentCount: 0 };
  }, [lines, commands, isMultiline, usageTracker, thinkingLevels]);

  const borderRows = Math.min(2, Math.max(0, availableRows - 1));
  const maxVisibleLines = Math.max(
    1,
    Math.min(Math.floor(terminalRows * 0.3), availableRows - borderRows),
  );
  const inputRows = useMemo(
    () => layoutInputRows(lines, rowWidth, pastes),
    [lines, rowWidth, pastes],
  );
  const completionRows = Math.max(
    0,
    Math.min(
      8,
      availableRows -
        borderRows -
        Math.min(inputRows.length, maxVisibleLines) -
        1 -
        Number(!!pasteError || isPastingImage),
    ),
  );
  const showDropdown =
    !disabled &&
    completionRows > 0 &&
    filteredCmds.length > 0 &&
    lines[0].startsWith("/") &&
    !isMultiline &&
    !dropdownDismissed &&
    historyIndex < 0;
  const commandWindowStart = getListWindowStart(
    filteredCmds.length,
    dropdownIndex,
    completionRows,
  );
  const visibleCommands = filteredCmds.slice(
    commandWindowStart,
    commandWindowStart + completionRows,
  );

  // @-file-mention autocomplete is disabled for slash commands and literal shell input.
  const fileCacheRef = useRef<{
    key: string;
    files: string[];
    scannedAt: number;
  } | null>(null);

  const atQuery = useMemo(() => {
    if (
      lines[0].startsWith("/") ||
      parseUserBashCommand(lines.join("\n")) !== null
    ) {
      return null;
    }
    const line = (lines[cursorLine] ?? "").slice(0, cursorCol);
    const m = /(?:^|\s)@([^\s]*)$/.exec(line);
    return m ? m[1] : null;
  }, [lines, cursorLine, cursorCol]);

  const atCompletionActive = atQuery !== null;
  useEffect(() => {
    if (!atCompletionActive) {
      setCwdFiles([]);
      return;
    }
    const key = `${cwd}::${String(fileFactsVersion)}`;
    const cache = fileCacheRef.current;
    if (
      cache?.key === key &&
      Date.now() - cache.scannedAt < FILE_CACHE_TTL_MS
    ) {
      setCwdFiles(cache.files);
      return;
    }
    const handle = setImmediate(() => {
      const files = scanCwdFiles(cwd);
      fileCacheRef.current = { key, files, scannedAt: Date.now() };
      setCwdFiles(files);
    });
    return () => {
      clearImmediate(handle);
    };
  }, [atCompletionActive, fileFactsVersion, cwd]);

  const filteredFiles = useMemo(() => {
    if (atQuery === null) {
      return [];
    }
    const q = atQuery.toLowerCase();
    if (!q) {
      return cwdFiles.slice(0, 8);
    }
    const pre = cwdFiles.filter((f) => f.toLowerCase().startsWith(q));
    const sub = cwdFiles.filter(
      (f) => !f.toLowerCase().startsWith(q) && f.toLowerCase().includes(q),
    );
    return [...pre, ...sub].slice(0, 8);
  }, [atQuery, cwdFiles]);

  const showAtDropdown =
    !disabled &&
    completionRows > 0 &&
    !dropdownDismissed &&
    !showDropdown &&
    atQuery !== null &&
    filteredFiles.length > 0;
  const fileWindowStart = getListWindowStart(
    filteredFiles.length,
    dropdownIndex,
    completionRows,
  );
  const visibleFiles = filteredFiles.slice(
    fileWindowStart,
    fileWindowStart + completionRows,
  );

  const completeAt = (path: string) => {
    const line = lines[cursorLine] ?? "";
    const before = line
      .slice(0, cursorCol)
      .replace(/@([^\s]*)$/, () => `@${path}`);
    const after = line.slice(cursorCol).replace(/^\S*/, "");
    const separator = after.startsWith(" ") ? "" : " ";
    const newLine = before + separator + after;
    setLines((prev) => {
      const u = [...prev];
      u[cursorLine] = newLine;
      return u;
    });
    setCursorCol(before.length + 1);
    setDropdownIndex(0);
  };

  const insertPastedText = (rawText: string, image = false) => {
    const normalized = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized) {
      return;
    }
    preferredColumnRef.current = null;
    const current = getDraft();
    const collapsed = image
      ? collapseImage(normalized, current.pastes)
      : collapsePaste(normalized, current.pastes);
    if (collapsed.store !== current.pastes) {
      setPastes(collapsed.store);
    }
    const cl = current.cursorLine;
    const col = inputBoundary(
      current.lines[cl] ?? "",
      current.cursorCol,
      "clamp",
      current.pastes,
    );
    const before = (current.lines[cl] ?? "").slice(0, col);
    const pad = image && before.length > 0 && !/\s$/.test(before) ? " " : "";
    const pasteLines = (pad + collapsed.text + (image ? " " : "")).split("\n");
    const lastLen = pasteLines[pasteLines.length - 1].length;
    setLines((prev) => {
      const updated = [...prev];
      const line = updated[cl] ?? "";
      const segments = [...pasteLines];
      segments[0] = line.slice(0, col) + segments[0];
      segments[segments.length - 1] =
        segments[segments.length - 1] + line.slice(col);
      updated.splice(cl, 1, ...segments);
      return updated;
    });
    setCursorLine(cl + pasteLines.length - 1);
    setCursorCol(pasteLines.length === 1 ? col + lastLen : lastLen);
    setDropdownIndex(0);
    setDropdownDismissed(true);
  };

  // Save the clipboard image under the session's file-history dir and insert
  // a cwd-relative @ mention; on submit, at-expansion inlines it as an
  // image content block like any other @image reference.
  const pasteImageFromClipboard = async () => {
    if (disabled || pasteImageInflightRef.current) {
      return;
    }
    pasteImageInflightRef.current = true;
    const generation = ++pasteGenerationRef.current;
    setIsPastingImage(true);
    setPasteError("");
    try {
      const result = await saveClipboardImage(sessionId);
      if (!mountedRef.current || generation !== pasteGenerationRef.current) {
        return;
      }
      if (result.ok) {
        insertPastedText(`'@${relative(cwd, result.value)}'`, true);
      } else {
        setPasteError(result.reason);
      }
    } catch (err) {
      if (!mountedRef.current || generation !== pasteGenerationRef.current) {
        return;
      }
      log.error({ err }, "clipboard image paste failed");
      setPasteError("Could not read an image from the clipboard.");
    } finally {
      if (mountedRef.current && generation === pasteGenerationRef.current) {
        pasteImageInflightRef.current = false;
        setIsPastingImage(false);
      }
    }
  };

  usePaste(
    (text) => {
      if (text.length > 0) {
        insertPastedText(text);
      } else {
        void pasteImageFromClipboard();
      }
    },
    { isActive: !disabled },
  );

  const handleInput = (input: string, key: Key) => {
    // Ink can deliver another key before React commits the preceding edit.
    const { lines, cursorLine, cursorCol, historyIndex, historyDraft, pastes } =
      getDraft();
    const isMultiline = lines.length > 1;
    if (!key.upArrow && !key.downArrow) {
      preferredColumnRef.current = null;
    }

    // Escape: key.escape or raw \x1b byte (tmux compat)
    if (key.escape || input === "\x1b") {
      if (showDropdown || showAtDropdown) {
        setDropdownDismissed(true);
        setDropdownIndex(0);
        return;
      }
      onEscape?.();
      return;
    }

    if (disabled) {
      return;
    }

    // Ctrl+V pastes a clipboard image (Alt+V on Windows, where terminals
    // reserve Ctrl+V for text paste).
    if (input === "v" && (process.platform === "win32" ? key.meta : key.ctrl)) {
      void pasteImageFromClipboard();
      return;
    }

    const hasLineBreak = input.includes("\r") || input.includes("\n");
    const hasReturn = key.return || hasLineBreak;
    const cleanInput = input.replace(/[\r\n]/g, "");

    // A chunk containing line breaks plus other content — or a single chunk
    // longer than 1000 characters without Ctrl/Meta modifiers — is a paste,
    // not an Enter press (Enter arrives as a lone "\r", "\n", or "\r\n").
    // Insert it as text at the cursor instead of submitting.
    const isLoneEnter = input === "\r" || input === "\n" || input === "\r\n";
    if (
      (hasLineBreak && !isLoneEnter) ||
      (!key.ctrl && !key.meta && input.length > 1000)
    ) {
      insertPastedText(input);
      return;
    }

    // Shift+Enter or Ctrl+J → newline
    if (hasReturn && (key.shift || (key.ctrl && input === "\n"))) {
      const line = lines[cursorLine] ?? "";

      setLines((prev) => {
        const updated = [...prev];
        updated[cursorLine] = line.slice(0, cursorCol);
        updated.splice(cursorLine + 1, 0, line.slice(cursorCol));
        return updated;
      });
      setCursorLine(cursorLine + 1);
      setCursorCol(0);
      return;
    }

    if (hasReturn) {
      if (showAtDropdown && filteredFiles[dropdownIndex]) {
        completeAt(filteredFiles[dropdownIndex]);
        return;
      }
      if (
        showDropdown &&
        filteredCmds.length > 0 &&
        dropdownIndex < filteredCmds.length &&
        !(lines.length === 1 && /^\/(thinking|think)\s*$/iu.test(lines[0]))
      ) {
        const selected = filteredCmds.at(dropdownIndex);
        if (selected) {
          const newLine = "/" + selected.name + " ";
          setLines([newLine]);
          setCursorLine(0);
          setCursorCol(newLine.length);
          setDropdownIndex(0);
          return;
        }
      }

      const line = lines[cursorLine] ?? "";
      const finalLine = cleanInput
        ? line.slice(0, cursorCol) + cleanInput + line.slice(cursorCol)
        : line;
      const updated = [...lines];
      updated[cursorLine] = finalLine;
      const finalValue = expandPastes(updated.join("\n"), pastes).trim();
      if (finalValue) {
        // A clipboard-image read is still in flight: keep the draft instead
        // of submitting, so nothing is silently dropped.
        if (pasteImageInflightRef.current) {
          return;
        }
        if (onSubmit(finalValue) === false) {
          return;
        }
        setLines([""]);
        setCursorLine(0);
        setCursorCol(0);
        setHistoryIndex(-1);
        setHistoryDraft(null);
        setPastes(undefined);
        setDropdownIndex(0);
        setDropdownDismissed(false);
        setPasteError("");
      }
      return;
    }

    if ((input === "\x1b[Z" || (key.tab && key.shift)) && onModeChange) {
      const idx =
        permMode === "plan" ? -1 : PERMISSION_MODE_CYCLE.indexOf(permMode);
      const next =
        PERMISSION_MODE_CYCLE[(idx + 1) % PERMISSION_MODE_CYCLE.length];
      onModeChange(next);
      return;
    }

    if (key.tab && showAtDropdown && filteredFiles[dropdownIndex]) {
      completeAt(filteredFiles[dropdownIndex]);
      return;
    }

    if (key.tab && lines[0].startsWith("/") && filteredCmds.length > 0) {
      const selected = filteredCmds.at(dropdownIndex);
      if (selected) {
        const newLine = "/" + selected.name + " ";
        setLines([newLine]);
        setCursorLine(0);
        setCursorCol(newLine.length);
        setDropdownIndex(0);
      }
      return;
    }

    if (key.home || (key.ctrl && input === "a")) {
      setCursorCol(0);
      return;
    }
    if (key.end || (key.ctrl && input === "e")) {
      setCursorCol((lines[cursorLine] ?? "").length);
      return;
    }

    if (key.leftArrow) {
      if (cursorCol > 0) {
        setCursorCol(
          inputBoundary(lines[cursorLine] ?? "", cursorCol, "previous", pastes),
        );
      } else if (isMultiline && cursorLine > 0) {
        setCursorLine(cursorLine - 1);
        setCursorCol((lines[cursorLine - 1] ?? "").length);
      }
      return;
    }

    if (key.rightArrow) {
      const lineLen = (lines[cursorLine] ?? "").length;
      if (cursorCol < lineLen) {
        setCursorCol(
          inputBoundary(lines[cursorLine] ?? "", cursorCol, "next", pastes),
        );
      } else if (isMultiline && cursorLine < lines.length - 1) {
        setCursorLine(cursorLine + 1);
        setCursorCol(0);
      }
      return;
    }

    if (key.backspace || key.delete) {
      setDropdownIndex(0);
      const line = lines[cursorLine] ?? "";
      if (key.delete && cursorCol < line.length) {
        const nextCol = inputBoundary(line, cursorCol, "next", pastes);
        setLines((prev) => {
          const updated = [...prev];
          const current = updated[cursorLine] ?? "";
          updated[cursorLine] =
            current.slice(0, cursorCol) + current.slice(nextCol);
          return updated;
        });
      } else if (key.backspace && cursorCol > 0) {
        const previousCol = inputBoundary(line, cursorCol, "previous", pastes);
        setLines((prev) => {
          const updated = [...prev];
          const l = updated[cursorLine] ?? "";
          updated[cursorLine] = l.slice(0, previousCol) + l.slice(cursorCol);
          return updated;
        });
        setCursorCol(previousCol);
      } else if (key.backspace && cursorLine > 0) {
        const prevLen = (lines[cursorLine - 1] ?? "").length;
        const cl = cursorLine;
        setLines((prev) => {
          const updated = [...prev];
          updated[cl - 1] = (updated[cl - 1] ?? "") + (updated[cl] ?? "");
          updated.splice(cl, 1);
          return updated;
        });
        setCursorLine(cl - 1);
        setCursorCol(prevLen);
      } else if (key.delete && cursorLine < lines.length - 1) {
        const cl = cursorLine;
        setLines((prev) => {
          const updated = [...prev];
          updated[cl] = (updated[cl] ?? "") + (updated[cl + 1] ?? "");
          updated.splice(cl + 1, 1);
          return updated;
        });
      }
      return;
    }

    if (key.upArrow || key.downArrow) {
      const direction = key.upArrow ? -1 : 1;
      if (showAtDropdown || showDropdown) {
        preferredColumnRef.current = null;
        const count = showAtDropdown
          ? filteredFiles.length
          : filteredCmds.length;
        setDropdownIndex((index) => (index + direction + count) % count);
        return;
      }
      const preferred = preferredColumnRef.current;
      const position = moveInputVertically(
        layoutInputRows(lines, rowWidth, pastes),
        cursorLine,
        cursorCol,
        direction,
        preferred?.width === rowWidth ? preferred.column : undefined,
      );
      if (position) {
        preferredColumnRef.current = {
          width: rowWidth,
          column: position.preferredColumn,
        };
        setCursorLine(position.cursorLine);
        setCursorCol(position.cursorCol);
        return;
      }
    }

    if (key.upArrow) {
      if (lines.length === 1 && lines[0] === "" && historyIndex === -1) {
        const recalled = onRecallQueuedMessage?.();
        if (recalled !== undefined) {
          const recalledLines = recalled.replace(/\r\n?/g, "\n").split("\n");
          preferredColumnRef.current = null;
          setLines(recalledLines);
          setCursorLine(recalledLines.length - 1);
          setCursorCol(recalledLines[recalledLines.length - 1].length);
          setHistoryIndex(-1);
          setHistoryDraft(null);
          setPastes(undefined);
          pasteGenerationRef.current++;
          pasteImageInflightRef.current = false;
          setIsPastingImage(false);
          setPasteError("");
          setDropdownIndex(0);
          setDropdownDismissed(true);
          return;
        }
      }
      if ((!isMultiline || historyIndex >= 0) && history.length > 0) {
        preferredColumnRef.current = null;
        if (historyIndex === -1) {
          setHistoryDraft({
            lines: [...lines],
            cursorLine,
            cursorCol,
            ...(pastes ? { pastes } : {}),
          });
        }
        const nextIdx =
          historyIndex < history.length - 1 ? historyIndex + 1 : historyIndex;
        setHistoryIndex(nextIdx);
        const entry = history[history.length - 1 - nextIdx] ?? "";
        const entryLines = entry.split("\n");
        setLines(entryLines);
        if (pastes) {
          setPastes(undefined);
        }
        setCursorLine(0);
        setCursorCol(entryLines[0].length);
        return;
      }
      return;
    }

    if (key.downArrow) {
      if (historyIndex === -1) {
        onOpenAgents?.();
        return;
      }
      preferredColumnRef.current = null;
      if (historyIndex > 0) {
        const nextIdx = historyIndex - 1;
        setHistoryIndex(nextIdx);
        const entry = history[history.length - 1 - nextIdx] ?? "";
        const entryLines = entry.split("\n");
        setLines(entryLines);
        if (pastes) {
          setPastes(undefined);
        }
        setCursorLine(0);
        setCursorCol(entryLines[0].length);
      } else {
        setHistoryIndex(-1);
        const draft = historyDraft;
        setHistoryDraft(null);
        if (draft) {
          setLines(draft.lines);
          setCursorLine(draft.cursorLine);
          setCursorCol(draft.cursorCol);
          if (draft.pastes || pastes) {
            setPastes(draft.pastes);
          }
        } else {
          setLines([""]);
          setCursorLine(0);
          setCursorCol(0);
        }
      }
      return;
    }

    if (cleanInput && !key.ctrl && !key.meta) {
      const col = cursorCol;
      setLines((prev) => {
        const updated = [...prev];
        const line = updated[cursorLine] ?? "";
        updated[cursorLine] = line.slice(0, col) + cleanInput + line.slice(col);
        return updated;
      });
      setCursorCol(col + cleanInput.length);
      setDropdownIndex(0);
      setDropdownDismissed(false);
    }
  };
  useInput(handleInput, { isActive: !disabled });

  const borderColor =
    inputState !== "error" && lines[0].startsWith("!")
      ? THEME.bashMode
      : (requestedBorderColor ??
        (inputState === "error"
          ? THEME.error
          : inputState === "idle"
            ? THEME.borderMuted
            : THEME.thinkingHigh));
  const visualCursor = locateInputCursor(inputRows, cursorLine, cursorCol);
  const visibleStart = Math.max(
    0,
    Math.min(
      visualCursor.row - Math.floor(maxVisibleLines / 2),
      inputRows.length - maxVisibleLines,
    ),
  );
  const visibleRows = inputRows.slice(
    visibleStart,
    visibleStart + maxVisibleLines,
  );
  const hiddenAbove = visibleStart;
  const hiddenBelow = Math.max(
    0,
    inputRows.length - visibleStart - visibleRows.length,
  );
  const spinner = SPINNER_FRAMES[statusFrame] ?? SPINNER_FRAMES[0];

  const ghostText = useMemo(() => {
    if (isMultiline || !lines[0].startsWith("/") || lines[0].length <= 1) {
      return "";
    }
    const typed = lines[0].slice(1).toLowerCase();
    const best = filteredCmds.at(0);
    // filteredCmds may be empty when the typed slash command doesn't match
    // any registered command (e.g. /some-slash-command-name). Guard against
    // undefined before accessing .name — mirrors the filteredCmds.length > 0
    // checks used by the dropdown rendering below.
    if (!best?.name.toLowerCase().startsWith(typed)) {
      return "";
    }
    return best.name.slice(typed.length);
  }, [lines, filteredCmds, isMultiline]);

  return (
    <Box flexDirection="column" width={borderWidth}>
      {borderRows === 2 && (
        <StatusBorder
          width={borderWidth}
          color={borderColor}
          statusLabel={statusLabel}
          spinner={inputState === "error" ? "!" : spinner}
          hiddenLineCount={hiddenAbove}
        />
      )}
      <Box
        flexDirection="column"
        paddingLeft={horizontalPadding}
        paddingRight={horizontalPadding}
      >
        {disabled ? (
          <Text color={THEME.muted} wrap="truncate-end">
            Waiting...
          </Text>
        ) : (
          visibleRows.map((row, visibleIndex) => {
            const rowIndex = visibleStart + visibleIndex;
            if (rowIndex !== visualCursor.row) {
              return (
                <Text key={rowIndex} wrap="truncate-end">
                  {row.cells.map((cell) => cell.text).join("")}
                </Text>
              );
            }
            const before = row.cells
              .slice(0, visualCursor.cell)
              .map((cell) => cell.text)
              .join("");
            const caret = row.cells[visualCursor.cell];
            const after = row.cells
              .slice(visualCursor.cell + 1)
              .map((cell) => cell.text)
              .join("");
            const atEnd = caret.offset === (lines[row.line] ?? "").length;
            return (
              <CursorText
                key={rowIndex}
                before={before}
                current={caret.text}
                after={
                  <>
                    {after}
                    {atEnd &&
                    row.line === 0 &&
                    ghostText &&
                    cursorCol === lines[0].length ? (
                      <Text color={THEME.dim}>
                        {truncateToWidth(ghostText, rowWidth - row.width)}
                      </Text>
                    ) : null}
                  </>
                }
              />
            );
          })
        )}
      </Box>
      {borderRows > 0 && (
        <StatusBorder
          width={borderWidth}
          color={borderColor}
          hiddenLineCount={hiddenBelow}
          direction="down"
        />
      )}
      {!disabled && isPastingImage && (
        <Box paddingLeft={horizontalPadding}>
          <Text color={THEME.muted} wrap="truncate-end">
            Reading clipboard image…
          </Text>
        </Box>
      )}
      {!disabled && pasteError && (
        <Box paddingLeft={horizontalPadding}>
          <Text color={THEME.error} wrap="truncate-end">
            Error: {pasteError}
          </Text>
        </Box>
      )}
      {showDropdown && (
        <Box flexDirection="column">
          <Text color={THEME.dim} wrap="truncate-end">
            {recentCount > 0 && commandWindowStart === 0
              ? "RECENTLY USED"
              : "COMMANDS"}
            {filteredCmds.length > completionRows
              ? ` (${String(dropdownIndex + 1)}/${String(filteredCmds.length)})`
              : ""}
          </Text>
          {visibleCommands.map((cmd, visibleIndex) => {
            const selected =
              commandWindowStart + visibleIndex === dropdownIndex;
            const desc = cmd.description.replace(/\s+/g, " ").trim();
            const tag = COMMAND_TAGS.find((tag) => desc.endsWith(tag));
            const body = tag ? desc.slice(0, -tag.length).trimEnd() : desc;
            const label = truncateToWidth(
              `${selected ? ICONS.arrow : " "} /${cmd.name}`,
              rowWidth,
            );
            const descriptionWidth =
              rowWidth -
              visibleWidth(label) -
              1 -
              (tag ? visibleWidth(tag) + 1 : 0);
            const showDescription = borderWidth >= 60 && descriptionWidth >= 10;
            return (
              <Box
                key={cmd.name}
                backgroundColor={selected ? THEME.selectedBg : undefined}
                paddingLeft={horizontalPadding}
                paddingRight={horizontalPadding}
                width="100%"
              >
                <Text
                  wrap="truncate-end"
                  color={selected ? THEME.accent : THEME.muted}
                >
                  {label}
                  {showDescription &&
                    ` ${truncateToWidth(body, descriptionWidth)}`}
                  {showDescription && tag && (
                    <Text color={selected ? THEME.accent : THEME.dim}>
                      {" "}
                      {tag}
                    </Text>
                  )}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
      {showAtDropdown && (
        <Box flexDirection="column">
          <Text color={THEME.dim} wrap="truncate-end">
            {"FILES"}
          </Text>
          {visibleFiles.map((file, i) => (
            <Box
              key={file}
              backgroundColor={
                fileWindowStart + i === dropdownIndex
                  ? THEME.selectedBg
                  : undefined
              }
              paddingLeft={horizontalPadding}
              paddingRight={horizontalPadding}
              width="100%"
            >
              <Text
                color={
                  fileWindowStart + i === dropdownIndex
                    ? THEME.accent
                    : THEME.muted
                }
                wrap="truncate-end"
              >
                {truncateToWidth(
                  `${fileWindowStart + i === dropdownIndex ? ICONS.arrow : " "} @${file}`,
                  rowWidth,
                )}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
