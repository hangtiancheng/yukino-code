import { Box, Text, render } from "ink";
import type { Instance } from "ink";
import { act, createElement, memo } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VirtualTerminal } from "./helpers/virtual-terminal.js";

import { CursorText } from "@/ui/cursor-text.js";
import type { InputDraft } from "@/ui/input-draft.js";
import { InputBox } from "@/ui/input.js";
import { renderInteractionSummary } from "@/ui/interaction-summary.js";
import { TerminalLayout } from "@/ui/terminal-layout.js";
import { installTerminalOutput } from "@/ui/terminal-output.js";
import { TextField } from "@/ui/text-field.js";
import { Transcript } from "@/ui/transcript.js";

let instance: Instance | undefined;
let virtualTerminal: VirtualTerminal;
let stdout: NodeJS.WriteStream;
let stdin: NodeJS.ReadStream;
let output: string[];
let restoreOutput: () => void;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("TERM_PROGRAM", "vscode");
  vi.stubEnv("TMUX", "");
  virtualTerminal = new VirtualTerminal(40, 24);
  ({ stdout, stdin, output } = virtualTerminal);
  restoreOutput = installTerminalOutput(stdout);
});

afterEach(async () => {
  await act(async () => {
    const exit = instance?.waitUntilExit();
    instance?.unmount();
    await exit;
    instance?.cleanup();
  });
  instance = undefined;
  restoreOutput();
  virtualTerminal.dispose();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function mount(node: ReactNode) {
  act(() => {
    instance = render(node, {
      stdout,
      stdin,
      stderr: stdout,
      interactive: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });
  });
  await instance?.waitUntilRenderFlush();
}

async function input(text: string) {
  await act(async () => {
    virtualTerminal.inputStream.write(text);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await instance?.waitUntilRenderFlush();
}

describe("native input cursor", () => {
  it("prints the exit summary below the footer without overwriting it", async () => {
    await mount(
      createElement(
        Box,
        { flexDirection: "column" },
        createElement(Text, {}, "Transcript"),
        createElement(CursorText, { before: "> " }),
        createElement(Text, {}, "Working directory · session-123"),
        createElement(Text, {}, "Context usage"),
      ),
    );
    await virtualTerminal.flush();
    expect(virtualTerminal.cursor.y).toBe(1);

    await act(async () => {
      instance?.unmount();
      await instance?.waitUntilExit();
    });
    restoreOutput();
    restoreOutput = () => undefined;
    stdout.write(
      `\n${renderInteractionSummary(
        {
          agentActiveMs: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          failedToolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          sessionId: "session-123",
          startedAt: 1_000,
          successfulToolCalls: 0,
          toolTimeMs: 0,
        },
        { columns: stdout.columns, color: true, endedAt: 3_000 },
      )}\n`,
    );
    await virtualTerminal.flush();

    const lines = virtualTerminal.bufferLines().map((line) => line.trim());
    const footerIndex = lines.indexOf("Context usage");
    const summaryIndex = lines.indexOf("Session session-123");
    expect(lines).toContain("Working directory · session-123");
    expect(footerIndex).toBeGreaterThan(-1);
    expect(summaryIndex).toBeGreaterThan(footerIndex);
    expect(lines).toContain("Session session-123");
    expect(lines).toContain("yukino --resume session-123");
  });

  it("keeps the actual terminal caret on the composer row through primary-screen updates and Japanese input", async () => {
    const draftRef: { current: InputDraft | null } = { current: null };
    const expectComposerCaret = () => {
      const cursor = virtualTerminal.cursor;
      expect(cursor.x).toBe(1 + 2 * (draftRef.current?.cursorCol ?? 0));
      expect(
        virtualTerminal.screenLine(cursor.y + 1)?.translateToString(true),
      ).toContain("─");
      expect(
        virtualTerminal.screenLine(cursor.y)?.translateToString(true),
      ).toContain(draftRef.current?.lines[0] ?? "");
    };
    const view = (activity = "") =>
      createElement(TerminalLayout, {
        transcript: createElement(Transcript, {
          messages: [],
          sessionId: "cursor-test",
          expanded: false,
          model: "test-model",
          provider: "test-provider",
          cwd: "/workspace",
        }),
        activity: createElement(Text, {}, activity),
        status: null,
        dock: createElement(InputBox, { onSubmit: vi.fn(), draftRef }),
        footer: createElement(Text, {}, "Working directory\nContext usage"),
      });
    await mount(view());
    expectComposerCaret();
    for (const text of ["カーソル位置", "\x1b[D", "\x1b[D", "\x1b[C", "\x7f"]) {
      await input(text);
      expectComposerCaret();
    }
    for (const chunk of [
      "Streaming",
      "Streaming\n".repeat(50),
      "Streaming finished",
    ]) {
      act(() => {
        instance?.rerender(view(chunk));
      });
      await instance?.waitUntilRenderFlush();
      expectComposerCaret();
    }
    await input("\x1b[5~");
    expectComposerCaret();
    await input("\x1b[F");
    expectComposerCaret();
    for (const [columns, rows] of [
      [20, 12],
      [80, 30],
      [40, 24],
    ]) {
      act(() => {
        virtualTerminal.resize(columns, rows);
      });
      await instance?.waitUntilRenderFlush();
      expectComposerCaret();
    }
  });

  it("tracks sibling-driven row movement even when the cursor row is memoized", async () => {
    const MemoCursor = memo(CursorText);
    const view = (header: string) =>
      createElement(
        Box,
        { flexDirection: "column" },
        createElement(Text, {}, header),
        createElement(MemoCursor, { before: "edit" }),
      );
    await mount(view("header"));
    expect(virtualTerminal.cursor).toEqual({ x: 4, y: 1 });
    act(() => {
      instance?.rerender(view("first\nsecond\nthird"));
    });
    await instance?.waitUntilRenderFlush();
    expect(virtualTerminal.cursor).toEqual({ x: 4, y: 3 });
  });

  it("positions a bar at the grapheme cell without replacing its text, and restores terminal style", async () => {
    const view = (padding: number) =>
      createElement(
        Box,
        { flexDirection: "column", paddingLeft: padding },
        createElement(Text, {}, "Header"),
        createElement(CursorText, {
          before: "あe\u0301",
          current: "😁",
          after: "next",
        }),
      );
    await mount(view(2));
    expect(virtualTerminal.cursor).toEqual({ x: 5, y: 1 });
    const line = virtualTerminal.screenLine(1);
    expect(line?.getCell(2)?.getChars()).toBe("あ");
    expect(line?.getCell(2)?.getWidth()).toBe(2);
    expect(line?.getCell(3)?.getWidth()).toBe(0);
    expect(line?.getCell(4)?.getChars()).toBe("e\u0301");
    expect(line?.getCell(4)?.getWidth()).toBe(1);
    expect(line?.getCell(5)?.getChars()).toBe("😁");
    expect(line?.getCell(5)?.getWidth()).toBe(2);
    expect(line?.getCell(6)?.getWidth()).toBe(0);
    expect(line?.translateToString(true).trimEnd()).toBe("  あe\u0301😁next");
    expect(output.join("")).toContain("\x1b[5 q");
    expect(output.join("")).not.toContain("\x1b[7m");
    act(() => {
      instance?.rerender(view(4));
    });
    await instance?.waitUntilRenderFlush();
    expect(virtualTerminal.cursor).toEqual({ x: 7, y: 1 });
    await act(async () => {
      const exit = instance?.waitUntilExit();
      instance?.unmount();
      await exit;
      instance?.cleanup();
    });
    instance = undefined;
    await virtualTerminal.flush();
    expect(output.join("")).toContain("\x1b[0 q");
  });

  it("does not emit cursor-style controls for non-TTY output or inactive fields", async () => {
    stdout.isTTY = false;
    await mount(
      createElement(CursorText, {
        before: "read",
        current: "o",
        after: "nly",
        active: false,
      }),
    );
    expect(output.join("")).not.toMatch(/\x1b\[[05] q/);
    act(() => {
      instance?.rerender(createElement(CursorText, { before: "text" }));
    });
    expect(output.join("")).not.toMatch(/\x1b\[[05] q/);
  });

  it("edits Unicode and bracketed multiline paste at the actual caret with real Ink input", async () => {
    const onSubmit = vi.fn();
    await mount(createElement(TextField, { initialValue: "あ😁z", onSubmit }));
    await input("\x1b[D");
    await input("\x1b[D");
    expect(virtualTerminal.cursor).toEqual({ x: 2, y: 0 });
    await input("\x1b[200~a\r\nb\x1b[201~");
    await input("\r");
    expect(onSubmit).toHaveBeenCalledWith("あa\nb😁z");
    expect(virtualTerminal.cursor).toEqual({ x: 1, y: 1 });
    expect(
      virtualTerminal.screenLine(0)?.translateToString(true).trimEnd(),
    ).toBe("あa");
    expect(
      virtualTerminal.screenLine(1)?.translateToString(true).trimEnd(),
    ).toBe("b😁z");
  });

  it("tracks hard wrapping, Home/End, and terminal resize using measured field width", async () => {
    const onSubmit = vi.fn();
    virtualTerminal.resize(12);
    await mount(
      createElement(
        Box,
        { paddingLeft: 2, paddingRight: 2 },
        createElement(TextField, { initialValue: "abcdefghijk", onSubmit }),
      ),
    );
    expect(virtualTerminal.cursor).toEqual({ x: 5, y: 1 });
    await input("\x1b[H");
    expect(virtualTerminal.cursor).toEqual({ x: 2, y: 0 });
    await input("\x1b[F");
    expect(virtualTerminal.cursor).toEqual({ x: 5, y: 1 });
    act(() => {
      virtualTerminal.resize(24);
    });
    await instance?.waitUntilRenderFlush();
    expect(virtualTerminal.cursor).toEqual({ x: 13, y: 0 });
    await input("\r");
    expect(onSubmit).toHaveBeenCalledWith("abcdefghijk");
  });

  it("keeps long drafts bounded while preserving the full submitted value", async () => {
    virtualTerminal.resize(40, 10);
    const onSubmit = vi.fn();
    const value = Array.from({ length: 20 }, (_, index) => `line${index}`).join(
      "\n",
    );
    await mount(createElement(TextField, { initialValue: value, onSubmit }));
    expect(virtualTerminal.cursor.y).toBeLessThan(5);
    expect(output.join("")).toContain("more lines");
    await input("\r");
    expect(onSubmit).toHaveBeenCalledWith(value);
  });

  it("preserves word boundaries when pasting lines into single-line fields", async () => {
    const onSubmit = vi.fn();
    await mount(createElement(TextField, { multiline: false, onSubmit }));
    await input("\x1b[200~first\nsecond\x1b[201~");
    await input("\r");
    expect(onSubmit).toHaveBeenCalledWith("first second");
  });
});
