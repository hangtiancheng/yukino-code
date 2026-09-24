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

import { PassThrough } from "node:stream";
import {
  setImmediate as nextTick,
  setTimeout as delay,
} from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

import { render, type Instance } from "ink";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderSelect } from "@/ui/provider-select.js";
import { TerminalInput } from "@/ui/terminal-input.js";
import { detectTerminalTheme } from "@/ui/terminal-theme.js";

function fakeTerminal() {
  const stream = new PassThrough();
  const controls = {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn((enabled: boolean): NodeJS.ReadStream => {
      controls.isRaw = enabled;
      return stdin;
    }),
    ref: vi.fn(),
    unref: vi.fn(),
  };
  const stdin: NodeJS.ReadStream = new Proxy(process.stdin, {
    get: (_target, property) => {
      const owner = property in controls ? controls : stream;
      const value: unknown = Reflect.get(owner, property, owner);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return typeof value === "function" ? value.bind(owner) : value;
    },
  });
  return { stream, stdin, controls };
}

const colorScheme = "\x1b[?997;2n";
const osc = "\x1b]11;rgb:eeee/eeee/eeee\x1b\\";
const originalTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
let terminal: ReturnType<typeof fakeTerminal>;
let input: TerminalInput;
let instance: Instance | undefined;

beforeEach(() => {
  terminal = fakeTerminal();
  input = new TerminalInput(terminal.stdin);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });
  vi.stubEnv("YUKINO_THEME", "");
  vi.stubEnv("COLORFGBG", "");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  act(() => instance?.unmount());
  instance = undefined;
  input.dispose();
  terminal.stream.destroy();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (originalTty) {
    Object.defineProperty(process.stdout, "isTTY", originalTty);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
});

function readInput(): string {
  const value: unknown = input.read();
  return Buffer.isBuffer(value)
    ? value.toString("utf8")
    : typeof value === "string"
      ? value
      : "";
}

describe("terminal input report filtering", () => {
  it("buffers typing during detection and consumes a later, split OSC terminator", async () => {
    const theme = detectTerminalTheme(input);
    terminal.stream.write("anth" + colorScheme);
    expect(await theme).toBe("light");
    expect(terminal.controls.isRaw).toBe(false);
    terminal.stream.write(osc.slice(0, -1));
    await delay(120);
    expect(readInput()).toBe("anth");
    terminal.stream.write("\\ropic");
    await nextTick();
    expect(readInput()).toBe("ropic");
  });

  it("filters responses arriving after the detection timeout", async () => {
    expect(await detectTerminalTheme(input, 5)).toBe("dark");
    terminal.stream.write(osc + colorScheme + "\\/user");
    await nextTick();
    expect(readInput()).toBe("\\/user");
  });

  it("accepts every split point of OSC and CSI reports, including BEL", async () => {
    for (const report of [osc, osc.replace("\x1b\\", "\x07"), colorScheme]) {
      for (let offset = 1; offset < report.length; offset++) {
        terminal.stream.write(report.slice(0, offset));
        await nextTick();
        terminal.stream.write(report.slice(offset) + "x");
        await nextTick();
        expect(readInput()).toBe("x");
      }
    }
  });

  it("preserves UTF-8, backslashes, keyboard sequences and bracketed paste", async () => {
    const text = "\\path/日本語😁\x1b[A\x1b[1;5D\x03";
    const paste = "\x1b[200~" + osc + colorScheme + "\\\x1b[201~";
    for (const byte of Buffer.from(text + paste)) {
      terminal.stream.write(Buffer.from([byte]));
    }
    await nextTick();
    expect(readInput()).toBe(text + paste);
    terminal.stream.write("\x1b");
    await delay(40);
    expect(readInput()).toBe("\x1b");
  });

  it("keeps the real provider search empty after late responses and accepts a typed backslash", async () => {
    const theme = detectTerminalTheme(input);
    terminal.stream.write(colorScheme);
    await theme;
    const onSelect = vi.fn();
    let frame = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      frame = stripVTControlCharacters(String(chunk));
      return true;
    });
    await act(async () => {
      instance = render(
        createElement(ProviderSelect, {
          providers: [
            {
              name: "test-provider",
              model: "test-model",
              protocol: "openai",
              base_url: "https://example.test",
              api_key: "test",
            },
          ],
          onSelect,
        }),
        {
          stdin: input.stdin,
          interactive: false,
          debug: true,
          patchConsole: false,
        },
      );
      await nextTick();
    });
    await act(async () => {
      terminal.stream.write(osc.slice(0, -1));
      await nextTick();
      terminal.stream.write("\\");
      await nextTick();
    });
    expect(frame).toContain("test-provider");
    expect(frame).not.toContain("No matching providers");
    expect(frame).not.toContain("Search: \\");
    await act(async () => {
      terminal.stream.write("\\");
      await nextTick();
    });
    expect(frame).toContain("Search: \\");
    expect(frame).toContain("No matching providers");
    await act(async () => {
      terminal.stream.write("\x15");
      await nextTick();
    });
    await act(async () => {
      terminal.stream.write("\r");
      await nextTick();
    });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ name: "test-provider" }),
    );
  });
});
