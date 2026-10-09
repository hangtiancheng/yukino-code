import { PassThrough } from "node:stream";
import { setImmediate as nextTick } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";

import { Text, render, type Instance } from "ink";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "@/ui/chat.js";
import type { InputDraft } from "@/ui/input-draft.js";
import { InputBox } from "@/ui/input.js";
import { ProviderSelect } from "@/ui/provider-select.js";
import { TerminalInput } from "@/ui/terminal-input.js";
import { TerminalLayout } from "@/ui/terminal-layout.js";
import { installTerminalOutput } from "@/ui/terminal-output.js";
import { detectTerminalTheme } from "@/ui/terminal-theme.js";
import { Transcript } from "@/ui/transcript.js";

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
      if (typeof value === "function") {
        const bound: unknown = value.bind(owner);
        return bound;
      }
      return value;
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
  vi.useRealTimers();
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
  it("appends complete history on the primary screen while preserving prompt recall and paste", async () => {
    const printed: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(
      (
        chunk,
        encodingOrCallback:
          BufferEncoding | ((error?: Error | null) => void) | undefined,
        callback,
      ) => {
        printed.push(String(chunk));
        if (typeof encodingOrCallback === "function") {
          encodingOrCallback();
        } else {
          callback?.();
        }
        return true;
      },
    );
    installTerminalOutput();
    const draftRef: { current: InputDraft | null } = { current: null };
    let expanded = false;
    let revision = 0;
    let sessionId = "history-test";
    let messages: ChatMessage[] = [
      { role: "user", content: "original prompt" },
      {
        role: "assistant",
        content: Array.from(
          { length: 100 },
          (_, row) => `history-${String(row).padStart(3, "0")}`,
        ).join("\n\n"),
      },
      {
        role: "turn_summary",
        content: "",
        toolSummary: [
          {
            toolName: "ReadFile",
            argsSummary: "source.ts",
            output: Array.from(
              { length: 20 },
              (_, row) => `detail-${String(row).padStart(3, "0")}`,
            ).join("\n"),
            isError: false,
            elapsed: 1,
          },
        ],
      },
    ];
    let activity = "";
    const scene = () =>
      createElement(TerminalLayout, {
        transcript: createElement(Transcript, {
          messages,
          sessionId,
          expanded,
          revision,
          model: "test-model",
          provider: "test-provider",
          cwd: "/workspace",
        }),
        activity: createElement(Text, {}, activity),
        status: null,
        dock: createElement(InputBox, {
          onSubmit: vi.fn(),
          draftRef,
          history: ["older prompt", "newer prompt"],
        }),
        footer: createElement(Text, {}, "Footer"),
      });
    await act(async () => {
      instance = render(scene(), {
        stdin: input.stdin,
        interactive: true,
        patchConsole: false,
        exitOnCtrlC: false,
      });
      await nextTick();
    });
    await instance?.waitUntilRenderFlush();
    const send = async (text: string) => {
      await act(async () => {
        terminal.stream.write(text);
        await nextTick();
      });
      await instance?.waitUntilRenderFlush();
    };
    await send("saved draft");
    const before = structuredClone(draftRef.current);
    await send("\x1b[A");
    expect(draftRef.current?.lines).toEqual(["newer prompt"]);
    await send("\x1b[B");
    expect(draftRef.current).toEqual(before);
    await send("\x1b[200~日本語\nsecond line\x1b[201~");
    expect(draftRef.current?.lines).toEqual([
      "saved draft日本語",
      "second line",
    ]);
    await send("\x1b[H");
    expect(draftRef.current?.cursorCol).toBe(0);
    await send("\x1b[F");
    expect(draftRef.current?.cursorCol).toBe("second line".length);
    const pasted = structuredClone(draftRef.current);
    activity = "streaming tail\n".repeat(100);
    act(() => instance?.rerender(scene()));
    await instance?.waitUntilRenderFlush();
    messages = [
      ...messages,
      { role: "assistant", content: "completed response" },
    ];
    activity = "";
    act(() => instance?.rerender(scene()));
    await instance?.waitUntilRenderFlush();
    const output = stripVTControlCharacters(printed.join(""));
    expect(output).toContain("original prompt");
    expect(output).toContain("history-000");
    expect(output).toContain("history-099");
    expect(output.match(/history-000/gu)).toHaveLength(1);
    expect(output.match(/completed response/gu)).toHaveLength(1);
    expect(output).not.toContain("detail-015");
    expanded = true;
    act(() => instance?.rerender(scene()));
    await instance?.waitUntilRenderFlush();
    expect(stripVTControlCharacters(printed.join(""))).toContain("detail-015");
    expect(stripVTControlCharacters(printed.join(""))).toContain("history-000");
    revision++;
    messages = [{ role: "user", content: "rewound conversation" }];
    act(() => instance?.rerender(scene()));
    await instance?.waitUntilRenderFlush();
    expect(stripVTControlCharacters(printed.join(""))).toContain(
      "rewound conversation",
    );
    sessionId = "restored-session";
    messages = [{ role: "assistant", content: "restored session response" }];
    act(() => instance?.rerender(scene()));
    await instance?.waitUntilRenderFlush();
    expect(stripVTControlCharacters(printed.join(""))).toContain(
      "restored session response",
    );
    expect(draftRef.current).toEqual(pasted);
    expect(printed.join("")).not.toMatch(
      /\x1b\[\?(?:1049|1000|1002|1003|1006)h/u,
    );
    expect(printed.join("")).not.toContain("\x1b[3J");
  });

  it("buffers typing during detection and consumes a later, split OSC terminator", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const theme = detectTerminalTheme(input);
    terminal.stream.write("anth" + colorScheme);
    expect(await theme).toBe("light");
    expect(terminal.controls.isRaw).toBe(false);
    terminal.stream.write(osc.slice(0, -1));
    await vi.advanceTimersByTimeAsync(120);
    expect(readInput()).toBe("anth");
    terminal.stream.write("\\ropic");
    await nextTick();
    expect(readInput()).toBe("ropic");
  });

  it("filters responses arriving after the detection timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const theme = detectTerminalTheme(input, 5);
    await vi.advanceTimersByTimeAsync(5);
    expect(await theme).toBe("dark");
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const text = "\\path/日本語😁\x1b[A\x1b[1;5D\x03";
    const paste = "\x1b[200~" + osc + colorScheme + "\\\x1b[201~";
    for (const byte of Buffer.from(text + paste)) {
      terminal.stream.write(Buffer.from([byte]));
    }
    await nextTick();
    expect(readInput()).toBe(text + paste);
    terminal.stream.write("\x1b");
    await vi.advanceTimersByTimeAsync(40);
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
