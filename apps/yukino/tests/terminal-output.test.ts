import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VirtualTerminal } from "./helpers/virtual-terminal.js";

import {
  expectStaticTerminalOutput,
  installTerminalOutput,
} from "@/ui/terminal-output.js";

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
let restoreOutput: (() => void) | undefined;

describe("installTerminalOutput", () => {
  it("rebuilds revised history once instead of appending a duplicate transcript", async () => {
    const virtualTerminal = new VirtualTerminal(80, 12);
    const restore = installTerminalOutput(virtualTerminal.stdout);
    try {
      expectStaticTerminalOutput(
        virtualTerminal.stdout,
        false,
        "session:collapsed",
      );
      virtualTerminal.stdout.write("Question\nTool summary\n");
      virtualTerminal.stdout.write("Draft\nFooter\n");
      await virtualTerminal.flush();
      expectStaticTerminalOutput(
        virtualTerminal.stdout,
        false,
        "session:expanded",
      );
      virtualTerminal.stdout.write("\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G");
      virtualTerminal.stdout.write("Question\nTool summary\nExpanded output\n");
      virtualTerminal.stdout.write("Draft\nFooter\n");
      await virtualTerminal.flush();
      expect(
        virtualTerminal
          .bufferLines()
          .filter((line) => line.includes("Question")),
      ).toHaveLength(1);
      expect(
        virtualTerminal
          .bufferLines()
          .filter((line) => line.includes("Expanded output")),
      ).toHaveLength(1);
      const start = virtualTerminal.output.length;
      expectStaticTerminalOutput(
        virtualTerminal.stdout,
        false,
        "session:expanded",
      );
      virtualTerminal.stdout.write("Additional message\n");
      await virtualTerminal.flush();
      expect(virtualTerminal.output.slice(start).join("")).not.toContain(
        "\x1b[3J",
      );
    } finally {
      restore();
      virtualTerminal.dispose();
    }
  });

  it("updates only changed rows without scrolling or replaying long history", async () => {
    const virtualTerminal = new VirtualTerminal(80, 12);
    const restore = installTerminalOutput(virtualTerminal.stdout);
    try {
      expectStaticTerminalOutput(virtualTerminal.stdout, false, "long-session");
      virtualTerminal.stdout.write(
        Array.from(
          { length: 200 },
          (_, index) => `history-${String(index)}\n`,
        ).join(""),
      );
      const lines = [
        "Stable heading",
        "Working 中文",
        "─".repeat(80),
        "draft",
        "─".repeat(80),
        "model · high",
      ];
      const cursor = "\x1b[2A\x1b[6G\x1b[?25h";
      virtualTerminal.stdout.write(lines.join("\n") + "\n" + cursor);
      await virtualTerminal.flush();
      const length = virtualTerminal.terminal.buffer.active.length;
      virtualTerminal.terminal.scrollToTop();
      const viewport = virtualTerminal.terminal.buffer.active.viewportY;
      const start = virtualTerminal.output.length;
      lines[1] = "Done ✓";
      virtualTerminal.stdout.write(
        "\x1b[2B\x1b[2K" +
          "\x1b[1A\x1b[2K".repeat(6) +
          "\x1b[G" +
          lines.join("\n") +
          "\n" +
          cursor,
      );
      await virtualTerminal.flush();
      const update = virtualTerminal.output.slice(start).join("");
      expect(update).toContain("Done ✓");
      expect(update).not.toContain("Stable heading");
      expect(update).not.toContain("model · high");
      expect(update).not.toContain("history-");
      expect(update).not.toContain("\x1b[2K");
      expect(Buffer.byteLength(update)).toBeLessThan(180);
      expect(virtualTerminal.terminal.buffer.active.length).toBe(length);
      expect(virtualTerminal.terminal.buffer.active.viewportY).toBe(viewport);
      const output = virtualTerminal.bufferLines();
      expect(
        output.filter((line) => line.includes("history-199")),
      ).toHaveLength(1);
      expect(output.some((line) => line.includes("Done ✓"))).toBe(true);
      expect(output.some((line) => line.includes("Working 中文"))).toBe(false);
    } finally {
      restore();
      virtualTerminal.dispose();
    }
  });

  beforeEach(() => {
    vi.stubEnv("TERM_PROGRAM", "vscode");
    vi.stubEnv("TMUX", "");
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    restoreOutput?.();
    restoreOutput = undefined;
    process.stdout.write = originalStdoutWrite;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (originalTty) {
      Object.defineProperty(process.stdout, "isTTY", originalTty);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });

  it("corks a frame while preserving raw chunks, callbacks, and backpressure", async () => {
    const encoded = Buffer.from("€", "utf8");
    const firstHalf = encoded.subarray(0, 1);
    const secondHalf = encoded.subarray(1);
    const writes: (string | Uint8Array)[] = [];
    const pendingCallbacks: ((error?: Error | null) => void)[] = [];
    const callback = vi.fn();
    const cork = vi
      .spyOn(process.stdout, "cork")
      .mockImplementation(() => undefined);
    const uncork = vi.spyOn(process.stdout, "uncork").mockImplementation(() => {
      for (const pending of pendingCallbacks.splice(0)) {
        pending();
      }
    });
    vi.spyOn(process.stdout, "write").mockImplementation(
      (chunk, encodingOrCallback, writeCallback) => {
        writes.push(chunk);
        const pending =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : writeCallback;
        if (pending) {
          pendingCallbacks.push(pending);
        }
        return chunk !== secondHalf;
      },
    );

    restoreOutput = installTerminalOutput();

    expect(process.stdout.write(firstHalf, callback)).toBe(true);
    expect(process.stdout.write(secondHalf)).toBe(false);
    expect(cork).toHaveBeenCalledTimes(1);
    expect(uncork).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(writes.slice(0, 3)).toEqual(["\x1b[?2026h", firstHalf, secondHalf]);

    await Promise.resolve();

    expect(writes[3]).toBe("\x1b[?2026l");
    expect(uncork).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    const rawChunks = writes.filter(
      (chunk): chunk is Uint8Array => chunk instanceof Uint8Array,
    );
    expect(Buffer.concat(rawChunks).toString("utf8")).toBe("€");
  });

  it("renders split UTF-8 and ANSI bytes as intact colored terminal cells", async () => {
    const virtualTerminal = new VirtualTerminal(20, 5);
    const restore = installTerminalOutput(virtualTerminal.stdout);
    try {
      const bytes = Buffer.from("\x1b[38;2;10;20;30mあ😁e\u0301€\x1b[0m");
      const written: number[] = [];
      for (let index = 0; index < bytes.length; index++) {
        virtualTerminal.stdout.write(bytes.subarray(index, index + 1), () => {
          written.push(index);
        });
      }
      await virtualTerminal.flush();
      expect(written).toEqual(
        Array.from({ length: bytes.length }, (_, i) => i),
      );
      expect(virtualTerminal.cursor).toEqual({ x: 6, y: 0 });
      const line = virtualTerminal.screenLine(0);
      expect(line?.translateToString(true)).toBe("あ😁e\u0301€");
      for (const [column, text, width] of [
        [0, "あ", 2],
        [2, "😁", 2],
        [4, "e\u0301", 1],
        [5, "€", 1],
      ] as const) {
        const cell = line?.getCell(column);
        expect(cell?.getChars()).toBe(text);
        expect(cell?.getWidth()).toBe(width);
        expect(cell?.getFgColor()).toBe(0x0a141e);
      }
      expect(virtualTerminal.terminal.buffer.active.type).toBe("normal");
      expect(virtualTerminal.terminal.modes.mouseTrackingMode).toBe("none");
      expect(virtualTerminal.terminal.modes.synchronizedOutputMode).toBe(false);
    } finally {
      restore();
      virtualTerminal.dispose();
    }
  });

  it.each([false, true])(
    "keeps history output pending when a live frame with nativeCursor=%s arrives first",
    async (nativeCursor) => {
      const virtualTerminal = new VirtualTerminal(40, 10);
      const restore = installTerminalOutput(virtualTerminal.stdout);
      try {
        const cursor = nativeCursor ? "\x1b[1A\x1b[1G\x1b[?25h" : "";
        const down = nativeCursor ? "\x1b[1B" : "";
        virtualTerminal.stdout.write("Thinking\nWorking\n" + cursor);
        expectStaticTerminalOutput(virtualTerminal.stdout, false);
        virtualTerminal.stdout.write(
          down +
            "\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[GThinking again\nWorking\n" +
            cursor,
        );
        virtualTerminal.stdout.write(
          down + "\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G",
        );
        virtualTerminal.stdout.write(
          "\x1b[48;2;223;231;236m" +
            " ".repeat(40) +
            "\x1b[0m\n" +
            "\x1b[48;2;223;231;236m STEERING_HISTORY 完善环境变量 \x1b[0m\n" +
            "\x1b[48;2;223;231;236m" +
            " ".repeat(40) +
            "\x1b[0m\n",
        );
        virtualTerminal.stdout.write("\x1b[GThinking\nWorking\n" + cursor);
        await virtualTerminal.flush();

        const row = virtualTerminal
          .bufferLines()
          .findIndex((line) => line.includes("STEERING_HISTORY"));
        expect(row).toBeGreaterThanOrEqual(0);
        expect(
          virtualTerminal.terminal.buffer.active.getLine(row)?.isWrapped,
        ).toBe(false);
        virtualTerminal.resize(80, 10);
        await virtualTerminal.flush();
        expect(virtualTerminal.bufferLines().join("\n")).toContain(
          "STEERING_HISTORY 完善环境变量",
        );
      } finally {
        restore();
        virtualTerminal.dispose();
      }
    },
  );

  it("recognizes screen-reader history written together with the frame erase", async () => {
    const virtualTerminal = new VirtualTerminal(40, 10);
    const restore = installTerminalOutput(virtualTerminal.stdout);
    try {
      expectStaticTerminalOutput(virtualTerminal.stdout, true);
      virtualTerminal.stdout.write(
        "\x1b[2K\x1b[1A\x1b[2K\x1b[GHistory\nSTEERING_HISTORY 完善环境变量\n",
      );
      await virtualTerminal.flush();
      expect(virtualTerminal.bufferLines()[1]).toBe(
        "STEERING_HISTORY 完善环境变量",
      );
      expect(virtualTerminal.terminal.buffer.active.getLine(1)?.isWrapped).toBe(
        false,
      );
    } finally {
      restore();
      virtualTerminal.dispose();
    }
  });

  it.each(["vscode", "unknown"])(
    "preserves the viewport and scrollback when forwarding redraws in %s",
    async (terminal) => {
      vi.stubEnv("TERM_PROGRAM", terminal);
      vi.stubEnv("TERM", "xterm-256color");
      const writes: string[] = [];
      const callback = vi.fn();
      vi.spyOn(process.stdout, "write").mockImplementation(
        (
          chunk,
          encodingOrCallback:
            BufferEncoding | ((error?: Error | null) => void) | undefined,
          writeCallback,
        ) => {
          writes.push(String(chunk));
          if (typeof encodingOrCallback === "function") {
            encodingOrCallback();
          } else {
            writeCallback?.();
          }
          return true;
        },
      );
      restoreOutput = installTerminalOutput();
      process.stdout.write("\x1b[2J\x1b[3J\x1b[Hrestored transcript", callback);
      await Promise.resolve();
      expect(writes.join("")).toContain("restored transcript");
      expect(writes.join("")).not.toContain("\x1b[2J");
      expect(writes.join("")).not.toContain("\x1b[3J");
      expect(callback).toHaveBeenCalledOnce();
    },
  );
});
