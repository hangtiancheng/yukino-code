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

import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const OSC_BACKGROUND = "\x1b]11;";
const COLOR_SCHEME = "\x1b[?997;";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Remove terminal reports before Ink splits them into individual key events. */
export class TerminalInput extends Transform {
  readonly stdin: NodeJS.ReadStream;
  private pending = "";
  private pasting = false;
  private readonly decoder = new StringDecoder("utf8");
  private escapeTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly source: NodeJS.ReadStream) {
    super();
    // Keep the real TTY's raw-mode/ref controls, with reads and events supplied
    // by the filtered stream. Ink's public stdin option requires a TTY stream.
    this.stdin = new Proxy(source, {
      get: (target, property) => {
        const owner = property in this ? this : target;
        const value: unknown = Reflect.get(owner, property, owner);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return typeof value === "function" ? value.bind(owner) : value;
      },
    });
    source.pipe(this);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    clearTimeout(this.escapeTimer);
    this.pending += this.decoder.write(chunk);
    let output = "";
    while (this.pending) {
      if (!this.pasting && this.pending.startsWith(OSC_BACKGROUND)) {
        const end = /\x07|\x1b\\/.exec(this.pending);
        if (!end) {
          break;
        }
        const length = end.index + end[0].length;
        this.emit("terminal-response", this.pending.slice(0, length));
        this.pending = this.pending.slice(length);
        continue;
      }
      if (!this.pasting && this.pending.startsWith(COLOR_SCHEME)) {
        const end = this.pending.indexOf("n", COLOR_SCHEME.length);
        if (end < 0) {
          break;
        }
        this.emit("terminal-response", this.pending.slice(0, end + 1));
        this.pending = this.pending.slice(end + 1);
        continue;
      }
      const pasteMarker = this.pasting ? PASTE_END : PASTE_START;
      if (this.pending.startsWith(pasteMarker)) {
        this.pasting = !this.pasting;
        output += pasteMarker;
        this.pending = this.pending.slice(pasteMarker.length);
        continue;
      }
      const prefixes = this.pasting ? [PASTE_END] : [OSC_BACKGROUND, COLOR_SCHEME, PASTE_START];
      if (prefixes.some((prefix) => prefix.startsWith(this.pending))) {
        break;
      }
      output += this.pending[0];
      this.pending = this.pending.slice(1);
    }
    if (output) {
      this.push(output);
    }
    // A literal Escape must still reach Ink. Once a report has started, retain
    // it across the theme timeout, including an ST terminator split at ESC / \.
    if (
      this.pending &&
      !this.pasting &&
      !this.pending.startsWith(OSC_BACKGROUND) &&
      !this.pending.startsWith(COLOR_SCHEME)
    ) {
      this.escapeTimer = setTimeout(() => {
        this.push(this.pending);
        this.pending = "";
      }, 25);
    }
    callback();
  }

  dispose(): void {
    clearTimeout(this.escapeTimer);
    this.source.unpipe(this);
    this.destroy();
  }
}
