import { stripVTControlCharacters } from "node:util";

import { render, useInput } from "ink";
import type { Instance, Key } from "ink";
import type * as Ink from "ink";
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiscoveredModel } from "@/llm/model-discovery.js";
import {
  ModelSelect,
  OTHER_LABEL,
  type ModelPickerState,
} from "@/ui/model-select.js";
import { ICONS } from "@/ui/styles.js";

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
let instance: Instance | undefined;
let frame = "";

function resize(columns: number, rows: number) {
  act(() => {
    process.stdout.columns = columns;
    process.stdout.rows = rows;
    process.stdout.emit("resize");
  });
}

function models(...ids: string[]): DiscoveredModel[] {
  return ids.map((id) => ({ id }));
}

function state(
  status: ModelPickerState["status"],
  ...ids: string[]
): ModelPickerState {
  return { models: models(...ids), status };
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

type InputHandler = (input: string, key: Key) => void;

// Every render re-registers handlers, so only the newest one carries current
// state. ModelSelect calls useInput without options; its TextField child passes
// { isActive }, which tells the two apart while both are mounted.
function takeHandler(withOptions: boolean): InputHandler {
  const calls = vi.mocked(useInput).mock.calls;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const [handler, options] = calls[index];
    if ((options !== undefined) === withOptions) {
      return handler;
    }
  }
  throw new Error("ModelSelect input handler is not mounted");
}

function send(input = "", key: Partial<Key> = {}) {
  const handler = takeHandler(false);
  act(() => {
    handler(input, { ...noKey, ...key });
  });
}

function sendText(input = "", key: Partial<Key> = {}) {
  const handler = takeHandler(true);
  act(() => {
    handler(input, { ...noKey, ...key });
  });
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
});

describe("ModelSelect", () => {
  it("starts at the current model and separates focus from current", () => {
    const onSelect = vi.fn();
    mount(
      createElement(ModelSelect, {
        currentModel: "model-b",
        onCancel: vi.fn(),
        onSelect,
        state: state("ready", "model-a", "model-b", "model-c"),
      }),
    );

    expect(frame).toContain(`${ICONS.arrow} model-b ${ICONS.success}`);
    expect(frame).toContain("2/4");
    expect(frame).toContain("Other (type your own)");
    send("", { return: true });
    expect(onSelect).toHaveBeenCalledWith({ id: "model-b" });
  });

  it("navigates with arrows and selects the focused model", () => {
    const onSelect = vi.fn();
    mount(
      createElement(ModelSelect, {
        currentModel: "model-a",
        onCancel: vi.fn(),
        onSelect,
        state: state("ready", "model-a", "model-b"),
      }),
    );

    send("", { downArrow: true });
    expect(frame).toContain(`${ICONS.arrow} model-b`);
    expect(frame).toContain(`model-a ${ICONS.success}`);
    send("", { upArrow: true });
    expect(frame).toContain(`${ICONS.arrow} model-a`);
    send("", { return: true });
    expect(onSelect).toHaveBeenCalledWith({ id: "model-a" });
  });

  it("filters by query and selects the match", () => {
    const onSelect = vi.fn();
    mount(
      createElement(ModelSelect, {
        currentModel: "fast-model",
        onCancel: vi.fn(),
        onSelect,
        state: state("ready", "fast-model", "reasoning-model"),
      }),
    );

    send("reason");
    expect(frame).toContain("1/2 · 2 total");
    expect(frame).not.toContain("fast-model");
    send("", { return: true });
    expect(onSelect).toHaveBeenCalledWith({ id: "reasoning-model" });
  });

  it("clears the query back to the current model with Ctrl+U", () => {
    mount(
      createElement(ModelSelect, {
        currentModel: "fast-model",
        onCancel: vi.fn(),
        onSelect: vi.fn(),
        state: state("ready", "fast-model", "reasoning-model"),
      }),
    );

    send("reason");
    expect(frame).not.toContain(`${ICONS.arrow} fast-model`);
    send("u", { ctrl: true });
    expect(frame).toContain(`${ICONS.arrow} fast-model ${ICONS.success}`);
    expect(frame).toContain("1/3");
    expect(frame).toContain("Search: type to filter");
    expect(frame).not.toContain("Ctrl+U clear");
  });

  it("cancels on Escape", () => {
    const onCancel = vi.fn();
    mount(
      createElement(ModelSelect, {
        currentModel: "model-a",
        onCancel,
        onSelect: vi.fn(),
        state: state("ready", "model-a"),
      }),
    );
    send("", { escape: true });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("shows only a fetch notice while discovery is loading", () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    mount(
      createElement(ModelSelect, {
        currentModel: "model-a",
        onCancel,
        onSelect,
        state: { models: [], status: "loading" },
      }),
    );

    expect(frame).toContain("Fetching models…");
    expect(frame).toContain("Current model: model-a");
    expect(frame).not.toContain(OTHER_LABEL);
    send("", { return: true });
    expect(onSelect).not.toHaveBeenCalled();
    send("", { escape: true });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("swaps the loading state for the discovered list on rerender", () => {
    const onSelect = vi.fn();
    const props = {
      currentModel: "model-a",
      onCancel: vi.fn(),
      onSelect,
    };
    mount(
      createElement(ModelSelect, {
        ...props,
        state: { models: [], status: "loading" },
      }),
    );
    expect(frame).toContain("Fetching models…");

    rerender(
      createElement(ModelSelect, {
        ...props,
        state: state("ready", "model-a", "model-b"),
      }),
    );
    expect(frame).toContain(`${ICONS.arrow} model-a ${ICONS.success}`);
    expect(frame).not.toContain("Fetching models…");
  });

  it("turns the Other row into an inline free-text field", () => {
    const onSelect = vi.fn();
    mount(
      createElement(ModelSelect, {
        currentModel: "model-a",
        onCancel: vi.fn(),
        onSelect,
        state: state("ready", "model-a", "model-b"),
      }),
    );

    send("", { upArrow: true });
    expect(frame).toContain(`${ICONS.arrow} ${OTHER_LABEL}`);
    send("", { return: true });

    expect(frame).toContain("Search: type to filter");
    expect(frame).toContain("model-a");
    expect(frame).toContain(`${ICONS.arrow} Model id:`);
    expect(frame).not.toContain("Current model:");

    sendText("claude-opus-4-5");
    sendText("", { return: true });
    expect(onSelect).toHaveBeenCalledWith({ id: "claude-opus-4-5" });
  });

  it("prefills the free-text field with an unlisted query", () => {
    const onSelect = vi.fn();
    mount(
      createElement(ModelSelect, {
        currentModel: "model-a",
        onCancel: vi.fn(),
        onSelect,
        state: state("ready", "model-a", "model-b"),
      }),
    );

    send("zzzq-unlisted");
    expect(frame).toContain(`${ICONS.arrow} ${OTHER_LABEL}`);
    send("", { return: true });
    sendText("", { return: true });
    expect(onSelect).toHaveBeenCalledWith({ id: "zzzq-unlisted" });
  });

  it("cancels the picker from the free-text field on Escape", () => {
    const onCancel = vi.fn();
    const onSelect = vi.fn();
    mount(
      createElement(ModelSelect, {
        currentModel: "model-a",
        onCancel,
        onSelect,
        state: state("ready", "model-a", "model-b"),
      }),
    );

    send("", { upArrow: true });
    send("", { return: true });
    expect(frame).toContain("Model id:");
    expect(frame).toContain("Esc cancel");
    expect(frame).toContain("model-a");

    sendText("", { escape: true });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(["empty", "error"] as const)(
    "accepts a typed id when discovery produced no list (%s)",
    (status) => {
      const onSelect = vi.fn();
      mount(
        createElement(ModelSelect, {
          currentModel: "model-a",
          onCancel: vi.fn(),
          onSelect,
          state: { models: [], status },
        }),
      );

      expect(frame).toContain(
        status === "empty"
          ? "No models returned by this provider — type a model id"
          : "Model discovery failed for this provider — type a model id",
      );
      sendText("fallback-model");
      sendText("", { return: true });
      expect(onSelect).toHaveBeenCalledWith({ id: "fallback-model" });
    },
  );

  it("ignores an empty submission from the free-text field", () => {
    const onSelect = vi.fn();
    mount(
      createElement(ModelSelect, {
        currentModel: "model-a",
        onCancel: vi.fn(),
        onSelect,
        state: { models: [], status: "error" },
      }),
    );

    sendText("  ");
    sendText("", { return: true });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
