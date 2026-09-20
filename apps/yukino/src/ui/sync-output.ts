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

const BSU = "\x1b[?2026h"; // Begin Synchronized Update
const ESU = "\x1b[?2026l"; // End Synchronized Update

/** Terminal programs whose emulator implements synchronized output. */
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
 * terminal that ignores them can leave garbage on screen.
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

/**
 * Installs synchronized output by monkey-patching process.stdout.write.
 * Uses queueMicrotask to batch all writes within the same synchronous frame
 * into a single BSU/ESU-wrapped write.
 *
 * Ink's onRender is synchronous: multiple stdout.write calls within it occur
 * in the same microtask and are naturally coalesced into a single BSU...ESU envelope.
 */
export function installSyncOutput(): void {
  if (!isSyncOutputSupported()) {
    return;
  }

  const originalWrite: typeof process.stdout.write = process.stdout.write.bind(process.stdout);
  let frameBuffer = "";
  let scheduled = false;

  process.stdout.write = function (
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((err?: Error) => void),
    callback?: (err?: Error) => void,
  ): boolean {
    const str =
      typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    frameBuffer += str;

    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => {
        const data = BSU + frameBuffer + ESU;
        frameBuffer = "";
        scheduled = false;
        originalWrite(data);
      });
    }

    if (typeof encodingOrCallback === "function") {
      encodingOrCallback();
    } else if (typeof callback === "function") {
      callback();
    }

    return true;
  };
}
