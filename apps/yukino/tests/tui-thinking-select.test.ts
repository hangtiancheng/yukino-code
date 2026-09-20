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

import { stripVTControlCharacters } from "node:util";

import chalk, { Chalk } from "chalk";
import { Box, Text, render, useInput } from "ink";
import type { Instance, Key } from "ink";
import type * as Ink from "ink";
import { act, createElement } from "react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { THINKING_LEVELS, type ThinkingLevel } from "@/config/index.js";
import { ICONS, setThemeMode, thinkingLevelColor } from "@/ui/styles.js";
import { visibleWidth } from "@/ui/terminal-text.js";
import { ThinkingSelect } from "@/ui/thinking-select.js";

vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof Ink>()),
  useInput: vi.fn(),
}));

const noKey: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const initialColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
const initialRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
const initialColorLevel = chalk.level;
const colors = new Chalk({ level: 3 });
let instance: Instance | undefined;
let frame = "";
let raw = "";

function resize(columns: number, rows = 24) {
  act(() => {
    process.stdout.columns = columns;
    process.stdout.rows = rows;
    process.stdout.emit("resize");
  });
}

function mount(props: Partial<ComponentProps<typeof ThinkingSelect>> = {}) {
  const callbacks = { onSelect: vi.fn(), onCancel: vi.fn() };
  act(() => {
    instance = render(
      createElement(ThinkingSelect, {
        currentLevel: "high",
        ...callbacks,
        ...props,
      }),
      { patchConsole: false, interactive: false, debug: true },
    );
  });
  return callbacks;
}

function send(key: Partial<Key>, text = "") {
  const handler = vi.mocked(useInput).mock.calls.at(-1)?.[0];
  if (!handler) {
    throw new Error("Thinking selector input is not mounted");
  }
  act(() => {
    handler(text, { ...noKey, ...key });
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(useInput).mockClear();
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    raw = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    frame = stripVTControlCharacters(raw);
    return true;
  });
  chalk.level = 0;
  resize(80);
  frame = "";
  raw = "";
});

afterEach(() => {
  act(() => {
    instance?.unmount();
    instance?.cleanup();
  });
  instance = undefined;
  for (const [name, descriptor] of [
    ["columns", initialColumns],
    ["rows", initialRows],
  ] satisfies [string, PropertyDescriptor | undefined][]) {
    if (descriptor) {
      Object.defineProperty(process.stdout, name, descriptor);
    } else {
      Reflect.deleteProperty(process.stdout, name);
    }
  }
  chalk.level = initialColorLevel;
  setThemeMode("dark");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("thinking selector controls", () => {
  it("starts at the current level, shows descriptions, and commits only on Enter", () => {
    const { onSelect, onCancel } = mount();
    for (const level of THINKING_LEVELS) {
      expect(frame).toContain(level);
    }
    expect(frame).toContain(`${ICONS.arrow} high ${ICONS.success}`);
    expect(frame).toContain("Deep reasoning");
    expect(frame).not.toMatch(/Search:|save|default/i);
    expect(onSelect).not.toHaveBeenCalled();
    send({ downArrow: true });
    expect(frame).toContain(`${ICONS.arrow} xhigh`);
    expect(frame).toContain(`high ${ICONS.success}`);
    expect(frame).toContain("Extra-deep reasoning");
    expect(onSelect).not.toHaveBeenCalled();
    send({ return: true });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("xhigh");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("supports both arrow axes and wraps within only the passed levels", () => {
    const levels: readonly ThinkingLevel[] = ["off", "low", "high"];
    const { onSelect } = mount({ currentLevel: "low", levels });
    expect(frame).not.toMatch(/minimal|medium|xhigh|max/);
    send({ leftArrow: true });
    expect(frame).toContain(`${ICONS.arrow} off`);
    send({ upArrow: true });
    expect(frame).toContain(`${ICONS.arrow} high`);
    send({ rightArrow: true });
    expect(frame).toContain(`${ICONS.arrow} off`);
    send({ downArrow: true });
    expect(frame).toContain(`${ICONS.arrow} low ${ICONS.success}`);
    send({ return: true });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("low");
  });

  it("cancels a pending choice without saving or repurposing Ctrl+T", () => {
    const { onSelect, onCancel } = mount();
    send({ rightArrow: true });
    send({ ctrl: true }, "t");
    send({}, "max");
    expect(frame).toContain(`${ICONS.arrow} xhigh`);
    expect(onSelect).not.toHaveBeenCalled();
    send({ escape: true });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("falls back to the first allowed level when current is unavailable", () => {
    const { onSelect } = mount({
      currentLevel: "max",
      levels: ["off", "medium"],
    });
    expect(frame).toContain(`${ICONS.arrow} off`);
    expect(frame).not.toContain(ICONS.success);
    expect(frame).not.toContain("max");
    send({ return: true });
    expect(onSelect).toHaveBeenCalledWith("off");
  });

  it("retains focused identity on reorder and handles removal and empty level updates", () => {
    const callbacks = mount({
      currentLevel: "medium",
      levels: ["low", "medium", "high"],
    });
    const update = (levels: readonly ThinkingLevel[]) => {
      act(() => {
        instance?.rerender(
          createElement(ThinkingSelect, {
            currentLevel: "medium",
            levels,
            ...callbacks,
          }),
        );
      });
    };
    send({ downArrow: true });
    update(["high", "low", "medium"]);
    expect(frame).toContain(`${ICONS.arrow} high`);
    send({ return: true });
    expect(callbacks.onSelect).toHaveBeenLastCalledWith("high");
    update(["low"]);
    send({ return: true });
    expect(callbacks.onSelect).toHaveBeenLastCalledWith("low");
    callbacks.onSelect.mockClear();
    update([]);
    expect(frame).toContain("No levels available");
    for (const key of ["upArrow", "downArrow", "leftArrow", "rightArrow", "return"]) {
      send({ [key]: true });
    }
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    send({ escape: true });
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
  });
});

describe.each(["dark", "light"] satisfies ("dark" | "light")[])(
  "%s thinking selector layout",
  (mode) => {
    it.each([1, 20, 32, 48, 80, 120])("fits %i columns with and without color", (columns) => {
      setThemeMode(mode);
      resize(columns);
      mount();
      expect(frame.split("\n").every((line) => visibleWidth(line) <= columns)).toBe(true);
      expect(raw).toBe(frame);
      if (columns >= 20) {
        expect(frame).toContain(`${ICONS.arrow} high ${ICONS.success}`);
        expect(frame).toContain("Enter");
        expect(frame).toContain("Esc");
        expect(frame).toContain("Deep reasoning");
      }
      chalk.level = 3;
      send({ leftArrow: true });
      expect(raw.split("\n").every((line) => visibleWidth(line) <= columns)).toBe(true);
      if (columns >= 20) {
        for (const level of THINKING_LEVELS) {
          const opening = colors.hex(thinkingLevelColor(level))(" ").split(" ")[0];
          const row = raw
            .split("\n")
            .find(
              (line) =>
                stripVTControlCharacters(line).trim().startsWith(level) ||
                stripVTControlCharacters(line).trim().startsWith(`${ICONS.arrow} ${level}`),
            );
          expect(row).toContain(opening);
        }
        expect(frame).toContain(`${ICONS.arrow} medium`);
        expect(frame).toContain(`high ${ICONS.success}`);
      }
    });

    it("keeps the focused choice and footer visible as the available height shrinks", () => {
      resize(32, 12);
      act(() => {
        instance = render(
          createElement(
            Box,
            { flexDirection: "column" },
            createElement(Text, null, "Live activity\nTeam status"),
            createElement(ThinkingSelect, {
              currentLevel: "max",
              onSelect: vi.fn(),
              onCancel: vi.fn(),
            }),
            createElement(Text, null, "Footer path\nFooter tokens"),
          ),
          { patchConsole: false, interactive: false, debug: true },
        );
      });
      expect(frame.split("\n").length).toBeLessThanOrEqual(12);
      expect(frame).toContain(`${ICONS.arrow} max ${ICONS.success}`);
      expect(frame).toContain("Footer path\nFooter tokens");
      send({ upArrow: true });
      expect(frame).toContain(`${ICONS.arrow} xhigh`);
      resize(20, 10);
      expect(frame.split("\n").length).toBeLessThanOrEqual(10);
      expect(frame).toContain("Footer path\nFooter tokens");
    });
  },
);
