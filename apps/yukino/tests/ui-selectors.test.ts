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
import { Box, Text, render, renderToString, useInput } from "ink";
import type { Instance, Key } from "ink";
import type * as Ink from "ink";
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderConfig } from "@/config/index.js";
import type { SessionInfo } from "@/session/index.js";
import { AskUserDialog } from "@/ui/ask-user-dialog.js";
import { PermissionDialog } from "@/ui/permission-dialog.js";
import { PlanApprovalDialog } from "@/ui/plan-approval.js";
import { ProviderSelect } from "@/ui/provider-select.js";
import { SelectorFrame } from "@/ui/selector-frame.js";
import { SelectorListRow } from "@/ui/selector-list.js";
import { updateSelectorQuery } from "@/ui/selector-search.js";
import { SessionSelector } from "@/ui/session-selector.js";
import { ICONS, setThemeMode, THEME } from "@/ui/styles.js";
import { visibleWidth } from "@/ui/terminal-text.js";

// Keep Ink's real layout and React hooks; invoke only the captured input callback.
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
const initialColumns = Object.getOwnPropertyDescriptor(
  process.stdout,
  "columns",
);
const initialRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
const initialColorLevel = chalk.level;
const colors = new Chalk({ level: 3 });
let instance: Instance | undefined;
let frame = "";

function resize(columns: number, rows: number) {
  act(() => {
    process.stdout.columns = columns;
    process.stdout.rows = rows;
    process.stdout.emit("resize");
  });
}

function mount(node: ReactNode) {
  act(() => {
    instance = render(node, {
      patchConsole: false,
      interactive: false,
      debug: true,
    });
  });
}

function rerender(node: ReactNode) {
  act(() => {
    instance?.rerender(node);
  });
}

function send(input = "", key: Partial<Key> = {}) {
  const handler = vi.mocked(useInput).mock.calls.at(-1)?.[0];
  if (!handler) {
    throw new Error("Selector input handler is not mounted");
  }
  act(() => {
    handler(input, { ...noKey, ...key });
  });
}

function staticFrame(node: ReactNode, columns: number) {
  let output = "";
  act(() => {
    output = renderToString(node, { columns });
  });
  return stripVTControlCharacters(output);
}

function providers(count = 15): ProviderConfig[] {
  return Array.from({ length: count }, (_, index) => {
    const id = String(index + 1).padStart(2, "0");
    return {
      name: `Provider-${id}`,
      protocol: "openai-compat",
      // base_url is the provider identity, so every entry needs a distinct one.
      base_url: `https://provider-${id}.invalid`,
      model: `local-model-${String(index + 1)}`,
    };
  });
}

function sessions(count = 15): SessionInfo[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${String(index + 1).padStart(2, "0")}`,
    firstMessage: `Conversation-${String(index + 1).padStart(2, "0")}`,
    messageCount: index + 1,
    size: 100,
    modTime: new Date("2026-01-01T00:00:00Z"),
  }));
}

function dock(node: ReactNode) {
  return createElement(
    Box,
    { flexDirection: "column" },
    createElement(Text, null, "Live activity\nTeam status"),
    node,
    createElement(Text, null, "Footer path\nFooter tokens"),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(useInput).mockClear();
  vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      frame = stripVTControlCharacters(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    },
  );
  resize(80, 24);
  frame = "";
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  chalk.level = initialColorLevel;
  setThemeMode("dark");
});

describe("provider selector", () => {
  it("starts at the current provider, limits the window to ten, and separates focus from current", () => {
    const onSelect = vi.fn();
    mount(
      createElement(ProviderSelect, {
        providers: providers(),
        currentBaseUrl: "https://provider-12.invalid",
        onSelect,
      }),
    );
    expect(frame).toContain(`${ICONS.arrow} Provider-12 ${ICONS.success}`);
    expect(frame).toContain("12/15");
    expect(frame.match(/Provider-\d+/g)).toHaveLength(10);
    expect(frame).not.toContain("Provider-02");
    expect(frame).toContain("openai-compat · local-model");
    send("", { downArrow: true });
    expect(frame).toContain(`${ICONS.arrow} Provider-13`);
    expect(frame).toContain(`Provider-12 ${ICONS.success}`);
    expect(frame).not.toContain(`${ICONS.arrow} Provider-12`);
    send("", { return: true });
    expect(onSelect).toHaveBeenCalledWith(providers()[12]);
  });

  it("fuzzy searches local names, models and protocols, then clears back to the current item", () => {
    const configured = [
      {
        ...providers(1)[0],
        name: "Development",
        base_url: "https://dev.invalid",
        model: "fast-model",
        protocol: "openai",
      },
      {
        ...providers(1)[0],
        name: "Production",
        base_url: "https://prod.invalid",
        model: "reasoning-model",
      },
    ] satisfies ProviderConfig[];
    const onSelect = vi.fn();
    mount(
      createElement(ProviderSelect, {
        providers: configured,
        currentBaseUrl: "https://prod.invalid",
        onSelect,
      }),
    );
    send("Develpment");
    expect(frame).toContain(`${ICONS.arrow} Development`);
    expect(frame).toContain("1/1 · 2 total");
    send("", { return: true });
    expect(onSelect).toHaveBeenLastCalledWith(configured[0]);
    send("u", { ctrl: true });
    expect(frame).toContain(`${ICONS.arrow} Production ${ICONS.success}`);
    send("reasoning");
    send("", { return: true });
    expect(onSelect).toHaveBeenLastCalledWith(configured[1]);
    send("u", { ctrl: true });
    send("compat");
    expect(frame).toContain("1/1 · 2 total");
    expect(frame).toContain("Production");
  });

  it("handles no results and Escape cancels without first clearing the search", () => {
    const onCancel = vi.fn();
    const onSelect = vi.fn();
    mount(
      createElement(ProviderSelect, {
        providers: providers(),
        onCancel,
        onSelect,
      }),
    );
    send("zzzzzzzzzzzzzz");
    expect(frame).toContain("No matching providers");
    expect(frame).toContain("0/0 · 15 total");
    send("", { upArrow: true });
    send("", { downArrow: true });
    send("", { return: true });
    expect(onSelect).not.toHaveBeenCalled();
    send("", { escape: true });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("retains item identity on reorder and clamps safely after removal and empty list updates", () => {
    const configured = providers(3);
    const onSelect = vi.fn();
    const view = (items: ProviderConfig[]) =>
      createElement(ProviderSelect, {
        providers: items,
        currentBaseUrl: configured[1].base_url,
        onSelect,
      });
    mount(view(configured));
    rerender(view([configured[2], configured[0], configured[1]]));
    expect(frame).toContain("3/3");
    send("", { return: true });
    expect(onSelect).toHaveBeenLastCalledWith(configured[1]);
    rerender(view([configured[2]]));
    expect(frame).toContain("1/1");
    send("", { return: true });
    expect(onSelect).toHaveBeenLastCalledWith(configured[2]);
    onSelect.mockClear();
    rerender(view([]));
    send("", { upArrow: true });
    send("", { return: true });
    expect(frame).toContain("No providers configured");
    expect(onSelect).not.toHaveBeenCalled();
    rerender(view(configured));
    send("", { downArrow: true });
    expect(frame).toContain("3/3");
  });

  it("wraps navigation and uses the first item when the current provider is absent", () => {
    const onSelect = vi.fn();
    mount(
      createElement(ProviderSelect, {
        providers: providers(3),
        currentBaseUrl: "https://missing.invalid",
        onSelect,
      }),
    );
    send("", { upArrow: true });
    expect(frame).toContain("3/3");
    send("", { downArrow: true });
    expect(frame).toContain("1/3");
    send("", { return: true });
    expect(onSelect).toHaveBeenCalledWith(providers(3)[0]);
    expect(() => {
      send("", { escape: true });
    }).not.toThrow();
  });

  it("distinguishes providers with the same display name by base URL", () => {
    const configured = [
      { ...providers(1)[0], name: "Shared", base_url: "https://first.invalid" },
      {
        ...providers(1)[0],
        name: "Shared",
        base_url: "https://second.invalid",
      },
    ];
    const onSelect = vi.fn();
    mount(
      createElement(ProviderSelect, {
        providers: configured,
        currentBaseUrl: "https://second.invalid",
        onSelect,
      }),
    );

    // The rows carry the same display name; base_url is what keeps them apart.
    expect(frame).toContain("2/2");
    send("", { return: true });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ base_url: "https://second.invalid" }),
    );

    // …and it is searchable, so a same-named provider can still be found.
    onSelect.mockClear();
    send("first.invalid");
    expect(frame).toContain("1/1");
    send("", { return: true });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ base_url: "https://first.invalid" }),
    );

    send("u", { ctrl: true });
    send("second.invalid");
    expect(frame).toContain("1/1");
  });
});

describe("session selector", () => {
  it("starts at the current session with a two-line, focus-following window", () => {
    mount(
      createElement(SessionSelector, {
        sessions: sessions(),
        currentSessionId: "session-12",
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    expect(frame).toContain(`${ICONS.arrow} Conversation-12 ${ICONS.success}`);
    expect(frame.match(/Conversation-\d+/g)).toHaveLength(8);
    expect(frame).toContain("session-12 · 12 messages");
    expect(frame).toContain("12/15");
    send("", { downArrow: true });
    expect(frame).toContain(`${ICONS.arrow} Conversation-13`);
    expect(frame).toContain(`Conversation-12 ${ICONS.success}`);
  });

  it("shrinks the visible window when the page reserves extra footer rows", () => {
    mount(
      createElement(SessionSelector, {
        sessions: sessions(),
        currentSessionId: "session-12",
        reservedRows: 8,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    const rendered = frame.match(/Conversation-\d+/g)?.length ?? 0;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(8);
  });

  it("searches first messages past the beginning and IDs, and restores selection on backspace", () => {
    const saved = sessions(2);
    saved[1].firstMessage = `${"Earlier context. ".repeat(10)}Fix deployment pipeline`;
    const onSelect = vi.fn();
    mount(
      createElement(SessionSelector, {
        sessions: saved,
        currentSessionId: saved[1].id,
        onSelect,
        onCancel: vi.fn(),
      }),
    );
    send("deploymnt");
    expect(frame).toContain("1/1 · 2 total");
    send("", { return: true });
    expect(onSelect).toHaveBeenLastCalledWith(saved[1].id);
    send("u", { ctrl: true });
    send(saved[0].id);
    send("", { return: true });
    expect(onSelect).toHaveBeenLastCalledWith(saved[0].id);
    send("u", { ctrl: true });
    send("x");
    send("", { backspace: true });
    expect(frame).toContain("2/2");
    send("", { return: true });
    expect(onSelect).toHaveBeenLastCalledWith(saved[1].id);
  });

  it("handles no results, empty lists and list shrink without selecting a missing session", () => {
    const saved = sessions();
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const view = (items: SessionInfo[]) =>
      createElement(SessionSelector, {
        sessions: items,
        currentSessionId: saved[14].id,
        onSelect,
        onCancel,
      });
    mount(view(saved));
    rerender(view([saved[0]]));
    expect(frame).toContain("1/1");
    send("", { return: true });
    expect(onSelect).toHaveBeenCalledWith(saved[0].id);
    onSelect.mockClear();
    send("zzzzzzzzzz");
    expect(frame).toContain("No matching sessions");
    send("", { return: true });
    send("", { escape: true });
    expect(onCancel).toHaveBeenCalledOnce();
    send("u", { ctrl: true });
    rerender(view([]));
    send("", { upArrow: true });
    send("", { downArrow: true });
    send("", { return: true });
    expect(frame).toContain("No saved sessions");
    expect(frame).toContain("0/0");
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("selector layout", () => {
  it.each(["dark", "light"] satisfies ("dark" | "light")[])(
    "uses quiet rules and accent titles/focus in %s mode without relying on color",
    (mode) => {
      setThemeMode(mode);
      for (const columns of [1, 20, 32, 48, 80, 120]) {
        for (const colorLevel of [0, 3] satisfies (0 | 3)[]) {
          chalk.level = colorLevel;
          let output = "";
          act(() => {
            output = renderToString(
              createElement(SelectorFrame, {
                compact: true,
                title: "Select provider",
                width: columns,
                hint: "↑↓ navigate · Enter select · Escape cancel · Ctrl+U clear",
                children: createElement(Text, null, "choice"),
              }),
              { columns },
            );
          });
          const plain = stripVTControlCharacters(output);
          expect(
            plain.split("\n").every((line) => visibleWidth(line) <= columns),
          ).toBe(true);
          if (columns >= 20) {
            expect(plain).toContain("Select provider");
            expect(plain).toContain("Enter");
            expect(plain).toMatch(/Esc(?:ape)?/);
            expect(plain.split("\n")[1].startsWith(" Select")).toBe(true);
          }
          if (colorLevel === 0) {
            expect(output).toBe(plain);
          } else {
            expect(output).toContain(
              colors.hex(THEME.borderMuted)("─".repeat(columns)),
            );
            if (columns >= 20) {
              expect(output).toContain(
                colors.hex(THEME.accent)("Select provider"),
              );
            }
          }
        }
      }
      chalk.level = 3;
      let selected = "";
      act(() => {
        selected = renderToString(
          createElement(SelectorListRow, {
            width: 40,
            label: "Selected",
            current: true,
            focused: true,
          }),
          { columns: 40 },
        );
      });
      expect(selected).toContain(
        `${colors.hex(THEME.accent)(" ").split(" ")[0]}${ICONS.arrow} Selected`,
      );
      expect(stripVTControlCharacters(selected)).toContain(
        `${ICONS.arrow} Selected ${ICONS.success}`,
      );
    },
  );

  it.each([8, 12, 16, 24, 40])(
    "keeps providers and the footer within %i rows, including content above the dock",
    (rows) => {
      resize(80, rows);
      mount(
        dock(
          createElement(ProviderSelect, {
            providers: providers(),
            currentBaseUrl: "https://provider-15.invalid",
            onSelect: vi.fn(),
          }),
        ),
      );
      expect(frame.split("\n").length).toBeLessThanOrEqual(rows);
      expect(frame).toContain("Footer path\nFooter tokens");
      expect((frame.match(/Provider-\d+/g) ?? []).length).toBeLessThanOrEqual(
        10,
      );
      if (rows >= 12) {
        expect(frame).toContain(`${ICONS.arrow} Provider-15 ${ICONS.success}`);
        expect(frame.match(/Provider-\d+/g)).toHaveLength(
          Math.min(10, rows - 10),
        );
      }
    },
  );

  it.each([8, 12, 16, 24, 40])(
    "budgets two rows per session without pushing out the footer at %i rows",
    (rows) => {
      resize(80, rows);
      mount(
        dock(
          createElement(SessionSelector, {
            sessions: sessions(),
            currentSessionId: "session-15",
            onSelect: vi.fn(),
            onCancel: vi.fn(),
          }),
        ),
      );
      expect(frame.split("\n").length).toBeLessThanOrEqual(rows);
      expect(frame).toContain("Footer path\nFooter tokens");
      if (rows >= 12) {
        expect(frame).toContain(
          `${ICONS.arrow} Conversation-15 ${ICONS.success}`,
        );
        expect(frame.match(/Conversation-\d+/g)).toHaveLength(
          Math.min(10, Math.floor((rows - 10) / 2)),
        );
      }
    },
  );

  it("recalculates the window on terminal resize and changing live content", () => {
    const selector = createElement(SessionSelector, {
      sessions: sessions(),
      currentSessionId: "session-15",
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });
    mount(dock(selector));
    resize(28, 14);
    expect(frame.split("\n").length).toBeLessThanOrEqual(14);
    expect(frame.match(/Conversation-\d+/g)).toHaveLength(2);
    expect(frame).toContain(`${ICONS.arrow} Conversation-15 ${ICONS.success}`);
    for (const line of frame.split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(28);
    }
    rerender(
      createElement(
        Box,
        { flexDirection: "column" },
        selector,
        createElement(Text, null, "Footer path\nFooter tokens"),
      ),
    );
    expect(frame.match(/Conversation-\d+/g)).toHaveLength(3);
    expect(frame).toContain("Footer tokens");
  });

  it.each([4, 20, 80])(
    "renders ANSI/CJK names within %i columns and drops descriptions before names",
    (width) => {
      const output = staticFrame(
        createElement(
          Box,
          { width },
          createElement(SelectorListRow, {
            width,
            focused: true,
            current: true,
            label: "\u001b[31m日本語開発\u001b[0m",
            description: "openai · local-model",
          }),
        ),
        width,
      );
      for (const line of output.split("\n")) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
      if (width >= 20) {
        expect(output).toContain(`日本語開発 ${ICONS.success}`);
      }
      expect(output.includes("local-model")).toBe(width === 80);
    },
  );

  it("keeps long headers, subtitles and hints to one line in the non-modal frame", () => {
    const output = staticFrame(
      createElement(SelectorFrame, {
        title: "日本語タイトル".repeat(10),
        subtitle: "A long\nsubtitle".repeat(10),
        hint: "Long hint ".repeat(10),
        width: 20,
        children: createElement(Text, null, "choice"),
      }),
      20,
    );
    expect(output.split("\n")).toHaveLength(7);
    for (const line of output.split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }
    expect(output).toContain("─".repeat(20));
  });
});

describe("search input boundaries and independent dialog controls", () => {
  it("does not treat navigation, tab, control shortcuts or mouse events as search text", () => {
    for (const key of [
      "tab",
      "leftArrow",
      "rightArrow",
      "home",
      "end",
      "pageUp",
      "pageDown",
      "ctrl",
      "meta",
      "super",
    ] satisfies (keyof Key)[]) {
      expect(updateSelectorQuery("find", "x", { ...noKey, [key]: true })).toBe(
        "find",
      );
    }
    expect(updateSelectorQuery("find", "\u001b[<0;1;2M", noKey)).toBe("find");
    expect(updateSelectorQuery("find", "[<0;1;2M", noKey)).toBe("find");
    expect(updateSelectorQuery("", "12 日本語\n検索", noKey)).toBe(
      "12 日本語 検索",
    );
    expect(updateSelectorQuery("a😁", "", { ...noKey, backspace: true })).toBe(
      "a",
    );
    expect(
      updateSelectorQuery("ae\u0301", "", { ...noKey, delete: true }),
    ).toBe("a");
    expect(updateSelectorQuery("find", "u", { ...noKey, ctrl: true })).toBe("");
  });

  it("preserves permission Escape denial", () => {
    const onComplete = vi.fn();
    mount(
      createElement(PermissionDialog, {
        toolName: "Write",
        argsSummary: "file.ts",
        reason: "Approval required",
        onComplete,
      }),
    );
    send("", { escape: true });
    expect(onComplete).toHaveBeenCalledWith("deny");
    expect(frame).not.toContain("Search:");
  });

  it("preserves plan feedback text, Shift+Tab submission and Escape manual approval", () => {
    const onSelect = vi.fn();
    mount(createElement(PlanApprovalDialog, { onSelect }));
    send("", { downArrow: true });
    send("", { downArrow: true });
    send("revise 12 steps");
    send("", { tab: true, shift: true });
    expect(onSelect).toHaveBeenCalledWith("feedback", "revise 12 steps");
    send("", { escape: true });
    expect(onSelect).toHaveBeenLastCalledWith("manual");
    expect(frame).not.toContain("Search:");
  });

  it("preserves AskUser numeric shortcuts, free text and tab navigation", () => {
    const onComplete = vi.fn();
    mount(
      createElement(AskUserDialog, {
        questions: [
          {
            header: "First",
            question: "First choice?",
            options: [{ label: "One", description: "First option" }],
            multiSelect: false,
          },
          {
            header: "Second",
            question: "Second choice?",
            options: [{ label: "Two", description: "Second option" }],
            multiSelect: false,
          },
        ],
        onComplete,
      }),
    );
    send("2");
    send("", { return: true });
    send("custom 123");
    send("", { return: true });
    expect(frame).toContain("Second choice?");
    send("", { tab: true, shift: true });
    expect(frame).toContain("First choice?");
    send("", { tab: true });
    send("1");
    send("", { return: true });
    send("", { return: true });
    expect(onComplete).toHaveBeenCalledWith({
      "First choice?": "custom 123",
      "Second choice?": "Two",
    });
    expect(frame).not.toContain("Search:");
  });
});
