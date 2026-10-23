import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import {
  COLOR_SCHEME,
  OSC_BACKGROUND,
  PASTE_END,
  PASTE_START,
} from "./constants.js";

// Longest suffix of `text` that is also a prefix of `marker` (shorter than the
// marker itself), so a marker split across chunks is still recognized.
function partialSuffixLength(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(marker.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

/** Remove terminal reports before Ink splits them into individual key events. */
export class TerminalInput extends Transform {
  readonly stdin: NodeJS.ReadStream;
  private readonly initialRawMode: boolean;
  private pending = "";
  private pasting = false;
  private readonly decoder = new StringDecoder("utf8");
  private escapeTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly source: NodeJS.ReadStream) {
    super();
    this.initialRawMode = source.isRaw;
    // Keep the real TTY's raw-mode and ref controls, with reads and events
    // supplied by the filtered stream. Ink's public stdin option requires a TTY
    // stream.
    this.stdin = new Proxy(source, {
      get: (target, property) => {
        const owner = property in this ? this : target;
        const value: unknown = Reflect.get(owner, property, owner);
        if (typeof value === "function") {
          const bound: unknown = value.bind(owner);
          return bound;
        }
        return value;
      },
    });
    // Replies can arrive after theme detection resolves, before Ink takes over.
    if (source.isTTY && source.setRawMode) {
      source.setRawMode(true);
    }
    source.pipe(this);
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
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
      if (this.pasting) {
        // Inside a bracketed paste the body is plain text: forward it in one
        // slice up to the end marker instead of byte-by-byte, so multi-MB
        // pastes stay O(n). Keep a tail that could still become a PASTE_END
        // split across chunks.
        const endIdx = this.pending.indexOf(PASTE_END);
        if (endIdx >= 0) {
          output += this.pending.slice(0, endIdx);
          this.pending = this.pending.slice(endIdx);
          continue;
        }
        const keep = partialSuffixLength(this.pending, PASTE_END);
        const flushEnd = this.pending.length - keep;
        output += this.pending.slice(0, flushEnd);
        this.pending = this.pending.slice(flushEnd);
        break;
      }
      // Outside a paste every handled report and the paste-start marker begin
      // with ESC, so forward plain text up to the next ESC in one slice.
      const escIdx = this.pending.indexOf("\x1b");
      if (escIdx > 0) {
        output += this.pending.slice(0, escIdx);
        this.pending = this.pending.slice(escIdx);
        continue;
      }
      if (escIdx < 0) {
        output += this.pending;
        this.pending = "";
        break;
      }
      // pending starts with ESC: hold it while it is still a prefix of a known
      // report, otherwise emit the ESC and keep parsing (arrows, literal Esc).
      const prefixes = [OSC_BACKGROUND, COLOR_SCHEME, PASTE_START];
      if (prefixes.some((prefix) => prefix.startsWith(this.pending))) {
        break;
      }
      output += this.pending[0];
      this.pending = this.pending.slice(1);
    }
    if (output) {
      this.push(output);
    }
    // A literal Escape must still reach Ink: pending bytes are flushed after
    // this timeout unless a paste is in progress or the buffer already starts
    // with a full report prefix (retained until complete, even an ST
    // terminator split at ESC / \).
    const prefixes = [OSC_BACKGROUND, COLOR_SCHEME, PASTE_START];
    const incompleteKnownSequence =
      this.pending !== "\x1b" &&
      prefixes.some((prefix) => prefix.startsWith(this.pending));
    if (
      this.pending &&
      !this.pasting &&
      !incompleteKnownSequence &&
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
    if (this.source.isTTY && this.source.setRawMode) {
      try {
        this.source.setRawMode(this.initialRawMode);
      } catch {
        // The terminal may have disappeared during shutdown.
      }
    }
  }
}
