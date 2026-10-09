import ansiEscapes from "ansi-escapes";
import sliceAnsi from "slice-ansi";

import { truncateToWidth, visibleWidth, wrapToLines } from "./terminal-text.js";

const BSU = "\x1b[?2026h"; // Begin Synchronized Update
const ESU = "\x1b[?2026l"; // End Synchronized Update

/** TERM_PROGRAM values whose terminal emulator implements synchronized output. */
const SYNC_OUTPUT_TERM_PROGRAMS = new Set([
  "alacritty",
  "contour",
  "ghostty",
  "iTerm.app",
  "vscode",
  "WarpTerminal",
  "WezTerm",
]);

/**
 * Detects whether the current terminal supports DEC 2026 synchronized output.
 *
 * Detection reads environment variables instead of sending a DECRQM query
 * (`CSI ? 2026 $ p`), which several terminals do not implement. Terminals that
 * are not recognized count as unsupported: emitting the sequences at a
 * terminal that mishandles them can leave garbage on screen.
 */
function isSyncOutputSupported(): boolean {
  const env = process.env;
  if (env.TMUX) {
    return false;
  }

  const term = env.TERM ?? "";
  const vteVersion = Number.parseInt(env.VTE_VERSION ?? "", 10);

  return Boolean(
    SYNC_OUTPUT_TERM_PROGRAMS.has(env.TERM_PROGRAM ?? "") ||
    term.includes("kitty") ||
    term === "xterm-ghostty" ||
    term.startsWith("foot") ||
    term.includes("alacritty") ||
    env.KITTY_WINDOW_ID ||
    env.ZED_TERM ||
    env.WT_SESSION ||
    vteVersion >= 6800,
  );
}

const staticOutputs = new WeakMap<
  NodeJS.WriteStream,
  (screenReader: boolean, identity?: string) => void
>();
const frameHeights = new WeakMap<NodeJS.WriteStream, () => number>();

export function trackTerminalFrame(
  stdout: NodeJS.WriteStream,
  getHeight: () => number,
): () => void {
  frameHeights.set(stdout, getHeight);
  return () => {
    frameHeights.delete(stdout);
  };
}

function renderStaticOutput(output: string): string {
  return output
    .split("\n")
    .map((line) => line.replace(/ +((?:\x1b\[[\d;]*m)*)$/u, "\x1b[K$1"))
    .join("\n");
}

function renderLiveFrame(
  frame: string,
  columns: number,
  reflowsCursorGroup: boolean,
): string {
  const lines = frame.split("\n");
  if (reflowsCursorGroup) {
    return (
      "\x1b[?7l" +
      lines.map((line) => truncateToWidth(line, columns, "")).join("\r\n") +
      "\x1b[?7h"
    );
  }
  // A single soft-wrapped cursor group stays out of xterm's native resize reflow.
  return (
    "\x1b[?7l" +
    lines
      .map((line, index) => {
        const content = truncateToWidth(line, columns, "");
        if (index === lines.length - 1) {
          return content;
        }
        let edge = sliceAnsi(content, columns - 1, columns);
        if (
          columns > 1 &&
          visibleWidth(content) === columns &&
          visibleWidth(edge) === 0
        ) {
          edge = sliceAnsi(content, columns - 2, columns);
        }
        const edgeWidth = visibleWidth(edge);
        return (
          content +
          "\x1b[?7h\x1b[999999G" +
          (edgeWidth === 2 ? ansiEscapes.cursorBackward(1) : "") +
          (edgeWidth > 0 ? edge : " ") +
          " \r\x1b[?7l"
        );
      })
      .join("") +
    "\x1b[?7h"
  );
}

export function expectStaticTerminalOutput(
  stdout: NodeJS.WriteStream,
  screenReader: boolean,
  identity?: string,
): void {
  staticOutputs.get(stdout)?.(screenReader, identity);
}

export function installTerminalOutput(
  stdout: NodeJS.WriteStream = process.stdout,
): () => void {
  if (!stdout.isTTY) {
    return () => undefined;
  }

  const synchronized = isSyncOutputSupported();
  // Apple Terminal reflows the live cursor group and retains rows below its caret.
  const reflowsCursorGroup = process.env.TERM_PROGRAM === "Apple_Terminal";
  const originalWrite: typeof stdout.write = stdout.write.bind(stdout);
  const originalCork = stdout.cork.bind(stdout);
  const originalUncork = stdout.uncork.bind(stdout);
  let frameRows = 0;
  let frame = "";
  let footprint: string[] = [];
  let cursorSuffix = "";
  let cursorRow = 0;
  let cursorLine = 0;
  let terminalColumns = Math.max(1, stdout.columns || 80);
  let terminalRows = Math.max(1, stdout.rows || 24);
  let resizing = false;
  let pendingFrame = "";
  let pendingCursorSuffix = "";
  let pendingStatic = "";
  let staticExpected = false;
  let staticIncludesErase = false;
  let staticIdentity: string | undefined;
  let staticOutput = "";
  let scheduled = false;

  staticOutputs.set(stdout, (screenReader, identity) => {
    if (staticIdentity !== identity) {
      staticIdentity = identity;
      staticOutput = "";
    }
    staticExpected = true;
    staticIncludesErase = screenReader;
  });

  const eraseFrame = () => {
    const rows = Math.min(frameRows, terminalRows);
    const down = Math.max(0, frameRows - 1 - cursorRow);
    return {
      rows,
      output:
        "\x1b[?25l" +
        (down > 0 ? ansiEscapes.cursorDown(down) : "") +
        ansiEscapes.cursorTo(0) +
        ansiEscapes.eraseLines(rows),
    };
  };

  const keepFootprint = (rows: number): string[] => {
    const retained: string[] = [];
    for (const [index, line] of footprint.entries()) {
      if (rows <= 0) {
        break;
      }
      const wrapped =
        index === cursorLine ? [line] : wrapToLines(line, terminalColumns);
      const count = Math.min(rows, wrapped.length);
      retained.push(wrapped.slice(0, count).join(""));
      rows -= count;
    }
    return retained;
  };

  const flushResize = () => {
    if (!resizing) {
      return;
    }
    resizing = false;
    const { rows, output } = eraseFrame();
    const retainedRows = Math.max(0, frameRows - rows);
    // Reflowed rows and cleared gaps can return from scrollback on a later resize.
    const retained = reflowsCursorGroup ? keepFootprint(retainedRows) : [];
    originalWrite(output);
    if (pendingStatic) {
      originalWrite(renderStaticOutput(pendingStatic));
    }
    const hadStatic = Boolean(pendingStatic);
    pendingStatic = "";
    const lines = pendingFrame.split("\n");
    const visibleLines = lines.slice(-terminalRows);
    const visibleFrame = visibleLines.join("\n");
    const gap =
      reflowsCursorGroup && !hadStatic
        ? Math.max(0, rows - visibleLines.length)
        : 0;
    if (gap > 0) {
      originalWrite(ansiEscapes.cursorDown(gap));
    }
    const visibleCursor = pendingCursorSuffix.replace(
      /\x1b\[(\d+)A/u,
      (_match, up: string) => {
        const distance = Math.min(Number(up), visibleLines.length - 1);
        return distance > 0 ? ansiEscapes.cursorUp(distance) : "";
      },
    );
    stdout.write(visibleFrame + visibleCursor);
    if (reflowsCursorGroup && !hadStatic) {
      footprint = [
        ...retained,
        ...Array.from({ length: gap }, () => ""),
        ...visibleLines,
      ];
      frameRows = retainedRows + gap + visibleLines.length;
      const up = Number(/\x1b\[(\d+)A/u.exec(visibleCursor)?.[1] ?? 0);
      cursorRow = frameRows - 1 - up;
      cursorLine = footprint.length - 1 - up;
    }
  };

  const onResize = () => {
    if (frameRows === 0) {
      return;
    }
    const nextRows = Math.max(1, stdout.rows || 24);
    const nextColumns = Math.max(1, stdout.columns || 80);
    if (reflowsCursorGroup && nextColumns !== terminalColumns) {
      const lineRows = footprint.map((line, index) =>
        index === cursorLine ? 1 : wrapToLines(line, nextColumns).length,
      );
      frameRows = lineRows.reduce((sum, count) => sum + count, 0);
      cursorRow = lineRows
        .slice(0, cursorLine)
        .reduce((sum, count) => sum + count, 0);
    }
    terminalColumns = nextColumns;
    if (!reflowsCursorGroup && nextRows < terminalRows) {
      // Keep rows above the caret: a resize burst can reveal them again before flush.
      frameRows -= Math.min(terminalRows - nextRows, frameRows - 1 - cursorRow);
    }
    terminalRows = nextRows;
    if (!resizing) {
      resizing = true;
      pendingFrame = frame;
      pendingCursorSuffix = cursorSuffix;
      queueMicrotask(flushResize);
    }
  };
  stdout.prependListener("resize", onResize);

  stdout.write = function (
    chunk: Uint8Array | string,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ): boolean {
    if (synchronized && !scheduled) {
      scheduled = true;
      originalCork();
      originalWrite(BSU);
      queueMicrotask(() => {
        try {
          originalWrite(ESU);
        } finally {
          scheduled = false;
          originalUncork();
        }
      });
    }

    let output = chunk;
    if (typeof output === "string") {
      const replaying = output.startsWith(ansiEscapes.clearTerminal);
      if (replaying) {
        // Ink replays Static history when the previous frame exceeds the new height.
        output = output.slice(ansiEscapes.clearTerminal.length);
        const height = frameHeights.get(stdout)?.();
        if (height !== undefined) {
          const lines = output.split("\n");
          const liveRows = height + Number(height < terminalRows);
          const historyLines = lines.slice(0, -liveRows);
          const history =
            historyLines.length > 0 ? historyLines.join("\n") + "\n" : "";
          const fresh = history.startsWith(staticOutput)
            ? history.slice(staticOutput.length)
            : history;
          staticOutput = history;
          if (!resizing) {
            resizing = true;
            pendingFrame = frame;
            pendingCursorSuffix = cursorSuffix;
            queueMicrotask(flushResize);
          }
          if (fresh) {
            pendingStatic += fresh;
            staticExpected = false;
          }
          output = lines.slice(-liveRows).join("\n");
        } else if (output.startsWith(staticOutput)) {
          output = output.slice(staticOutput.length);
        }
      }
      output = output.replaceAll("\x1b[3J", "");
      const erase = /\x1b\[2K(?:\x1b\[1A\x1b\[2K)*\x1b\[G/u.exec(output);
      const cursor = /(?:\x1b\[(\d+)A)?\x1b\[\d+G\x1b\[\?25h$/u.exec(output);
      const content = erase
        ? output.slice(erase.index + erase[0].length)
        : output;
      // A pending live redraw can arrive before the Static write.
      const isStatic =
        !replaying &&
        staticExpected &&
        !cursor &&
        (!erase || staticIncludesErase) &&
        content.includes("\n");
      if (isStatic) {
        staticExpected = false;
        staticOutput += content;
      }
      if (resizing) {
        if (isStatic) {
          pendingStatic += content;
        } else if (content.includes("\n")) {
          pendingFrame = content.slice(0, content.lastIndexOf("\n") + 1);
          pendingCursorSuffix = cursor?.[0] ?? "";
        } else if (cursor) {
          pendingCursorSuffix = cursor[0];
        }
        if (
          isStatic ||
          erase ||
          content.includes("\n") ||
          cursor ||
          output === BSU ||
          output === ESU
        ) {
          output = "";
        }
      }
      if (isStatic) {
        output = renderStaticOutput(output);
      }
      const rendered = erase
        ? output.slice(erase.index + erase[0].length)
        : output;
      if (!isStatic && rendered.includes("\n")) {
        const cleared = reflowsCursorGroup && erase ? eraseFrame() : undefined;
        const retainedRows = cleared
          ? Math.max(0, frameRows - cleared.rows)
          : 0;
        const retained = cleared ? keepFootprint(retainedRows) : [];
        frame = rendered.slice(0, rendered.lastIndexOf("\n") + 1);
        const lines = frame.split("\n");
        const gap = cleared ? Math.max(0, cleared.rows - lines.length) : 0;
        footprint = [
          ...retained,
          ...Array.from({ length: gap }, () => ""),
          ...lines,
        ];
        frameRows = retainedRows + gap + lines.length;
        cursorRow = frameRows - 1;
        cursorLine = footprint.length - 1;
        cursorSuffix = "";
        const prefix = cleared
          ? cleared.output + (gap > 0 ? ansiEscapes.cursorDown(gap) : "")
          : output.slice(0, output.length - rendered.length);
        output =
          prefix +
          renderLiveFrame(
            frame,
            Math.max(1, stdout.columns || 80),
            reflowsCursorGroup,
          ) +
          rendered.slice(frame.length);
      } else if (reflowsCursorGroup && erase && !resizing && output) {
        const cleared = eraseFrame();
        output = cleared.output + rendered;
        footprint = [];
        frameRows = 0;
        cursorRow = 0;
        cursorLine = 0;
      }
      if (cursor && !resizing) {
        cursorRow = frameRows - 1 - Number(cursor[1] ?? 0);
        cursorLine = footprint.length - 1 - Number(cursor[1] ?? 0);
        cursorSuffix = cursor[0];
      }
    }
    if (typeof encodingOrCallback === "function") {
      return originalWrite(output, encodingOrCallback);
    }
    return originalWrite(output, encodingOrCallback, callback);
  };
  return () => {
    resizing = false;
    staticOutputs.delete(stdout);
    stdout.off("resize", onResize);
    stdout.write = originalWrite;
    if (frameRows > 0) {
      const down = Math.max(0, frameRows - 1 - cursorRow);
      originalWrite(
        (down > 0 ? ansiEscapes.cursorDown(down) : "") +
          ansiEscapes.cursorTo(0),
      );
    }
  };
}
