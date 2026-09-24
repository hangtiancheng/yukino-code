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

import { render, renderToString, useInput, usePaste, useWindowSize } from "ink";
import type { Instance, Key } from "ink";
import type * as Ink from "ink";
import { act, createElement } from "react";
import stringWidth from "string-width";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderConfig } from "@/config/index.js";
import { ProviderLogin } from "@/ui/provider-login.js";

vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof Ink>()),
  useInput: vi.fn(),
  usePaste: vi.fn(),
  useWindowSize: vi.fn(),
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

const validProvider: ProviderConfig = {
  name: "Anthropic",
  protocol: "anthropic",
  base_url: "https://api.anthropic.com/v1/messages",
  api_key: "sk-secret-value",
  model: "claude-sonnet-4-6",
  thinking: "high",
  context_window: 1_000_000,
  max_output_tokens: 128_000,
};

let instance: Instance | undefined;
let outputChunks: string[] = [];
const fetchMock = vi.fn<typeof fetch>();
const stdoutColumns = Object.getOwnPropertyDescriptor(
  process.stdout,
  "columns",
);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(Response.json({ data: [] }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(useWindowSize).mockReturnValue({ columns: 80, rows: 24 });
  outputChunks = [];
  vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      outputChunks.push(String(chunk));
      return true;
    },
  );
});

afterEach(() => {
  act(() => {
    instance?.unmount();
    instance?.cleanup();
  });
  instance = undefined;
  if (stdoutColumns) {
    Object.defineProperty(process.stdout, "columns", stdoutColumns);
  } else {
    Reflect.deleteProperty(process.stdout, "columns");
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(
  initialValues: Partial<ProviderConfig> = validProvider,
  onSubmit = vi.fn(),
  onCancel = vi.fn(),
) {
  act(() => {
    instance = render(
      createElement(ProviderLogin, { initialValues, onSubmit, onCancel }),
      {
        patchConsole: false,
        interactive: false,
        debug: true,
      },
    );
  });
  return { onSubmit, onCancel };
}

function send(input = "", key: Partial<Key> = {}): void {
  const handler = vi.mocked(useInput).mock.calls.at(-1)?.[0];
  if (typeof handler !== "function") {
    throw new Error("ProviderLogin input handler is not mounted");
  }
  act(() => {
    handler(input, { ...noKey, ...key });
  });
}

function paste(text: string): void {
  const handler = vi.mocked(usePaste).mock.calls.at(-1)?.[0];
  if (typeof handler !== "function") {
    throw new Error("ProviderLogin paste handler is not mounted");
  }
  act(() => {
    handler(text);
  });
}

function terminalOutput(): string {
  return stripVTControlCharacters(outputChunks.join(""));
}

function nextFields(count: number): void {
  for (let index = 0; index < count; index += 1) {
    send("", { tab: true });
  }
}

async function advance(milliseconds = 400): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function submit(): Promise<void> {
  send("", { return: true });
  await act(async () => {
    await Promise.resolve();
  });
}

function deferredResponse() {
  let resolve: (response: Response) => void = () => {
    throw new Error("Response promise is not initialized");
  };
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mockModels(...ids: string[]): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      Response.json({
        data: ids.map((id) => ({ id })),
      }),
    ),
  );
}

describe("ProviderLogin", () => {
  it.each([32, 48])(
    "renders defaults and masks the API key at %s columns",
    (columns) => {
      vi.mocked(useWindowSize).mockReturnValue({ columns, rows: 24 });
      let rendered = "";
      act(() => {
        rendered = stripVTControlCharacters(
          renderToString(
            createElement(ProviderLogin, {
              initialValues: validProvider,
              onSubmit: vi.fn(),
              onCancel: vi.fn(),
            }),
            { columns },
          ),
        );
      });

      expect(
        rendered.split("\n").every((line) => stringWidth(line) <= columns),
      ).toBe(true);
      expect(rendered).toContain("type/paste any ID");
      expect(rendered).toContain("Provider login");
      expect(rendered).toContain("1000000");
      expect(rendered).toContain("128000");
      expect(rendered).toContain("high");
      expect(rendered).not.toContain("sk-secret-value");
    },
  );

  it("preserves pasted text, supports Ctrl+U, and submits ProviderConfig", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mount({ ...validProvider, name: "existing" }, onSubmit);

    send("u", { ctrl: true });
    paste("provider name with spaces");
    send("", { return: true });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onSubmit).toHaveBeenCalledWith({
      ...validProvider,
      name: "provider name with spaces",
    });
  });

  it("navigates with Tab and changes protocol and thinking with arrows", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mount(validProvider, onSubmit);

    send("", { tab: true });
    send("", { rightArrow: true });
    send("", { tab: true });
    send("", { tab: true });
    send("", { tab: true });
    send("", { tab: true });
    send("", { rightArrow: true });
    send("", { return: true });
    await act(async () => {
      await Promise.resolve();
    });

    // The protocol switch leaves thinking at its default (high); the right
    // arrow then advances high -> xhigh.
    expect(onSubmit).toHaveBeenCalledWith({
      ...validProvider,
      protocol: "openai",
      thinking: "xhigh",
    });
  });

  it("keeps an explicit thinking level when the protocol changes", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    mount({ ...validProvider, thinking: "medium" }, onSubmit);

    send("", { tab: true });
    send("", { rightArrow: true });
    send("", { return: true });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onSubmit).toHaveBeenCalledWith({
      ...validProvider,
      thinking: "medium",
      protocol: "openai",
    });
  });

  it("maps schema issues to fields and rejects invalid ranges", () => {
    const { onSubmit } = mount({
      ...validProvider,
      name: "",
      context_window: 999,
    });

    send("", { return: true });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(terminalOutput()).toContain("Name is required");
    expect(terminalOutput()).toContain("1000");
  });

  it("shows a rejected onSubmit error and cancels with Escape", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(new Error("invalid credentials"));
    const onCancel = vi.fn();
    mount(validProvider, onSubmit, onCancel);

    send("", { return: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(terminalOutput()).toContain("invalid credentials");

    send("\x1b", { escape: true });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("ProviderLogin model discovery", () => {
  it("debounces connection edits and fetches only valid HTTP(S) URLs", async () => {
    mount({ ...validProvider, base_url: "invalid" });
    await advance(1_000);
    expect(fetchMock).not.toHaveBeenCalled();
    nextFields(2);
    send("u", { ctrl: true });
    paste("https://proxy.example");
    await advance(399);
    expect(fetchMock).not.toHaveBeenCalled();
    paste("/v1/messages");
    await advance(1_000);
    expect(fetchMock).not.toHaveBeenCalled();
    nextFields(2);
    await advance(399);
    expect(fetchMock).not.toHaveBeenCalled();
    await advance(1);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://proxy.example/v1/models",
      expect.any(Object),
    );
  });

  it("preserves all active configuration values after discovery", async () => {
    mockModels("different-model");
    const { onSubmit } = mount();
    await advance();
    await submit();
    expect(onSubmit).toHaveBeenCalledWith(validProvider);
    expect(terminalOutput()).not.toContain(validProvider.api_key);
  });

  it("preserves explicit capabilities and only cycles supported thinking levels", async () => {
    const provider: ProviderConfig = {
      ...validProvider,
      thinking: "off",
      reasoning: false,
      thinking_mode: "adaptive",
    };
    const { onSubmit } = mount(provider);
    nextFields(5);
    send("", { rightArrow: true });
    await submit();
    expect(onSubmit).toHaveBeenCalledWith(provider);
  });

  it("does not refill a model cleared during the debounce window", async () => {
    mockModels("discovered-model");
    const { onSubmit } = mount();
    nextFields(4);
    send("u", { ctrl: true });
    await advance();
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(terminalOutput()).toContain("Model is required");
  });

  it("fills only an untouched empty model and positions its cursor for typing", async () => {
    mockModels("model-a", "model-b");
    const { onSubmit } = mount({ ...validProvider, model: "" });
    nextFields(4);
    await advance();
    send("-custom");
    await submit();
    expect(onSubmit).toHaveBeenCalledWith({
      ...validProvider,
      model: "model-a-custom",
    });
  });

  it.each(["left", "right"])(
    "cycles discovered model IDs with %s wraparound",
    async (direction) => {
      mockModels("model-a", "model-b");
      const { onSubmit } = mount({ ...validProvider, model: "manual-id" });
      nextFields(4);
      await advance();
      const arrow = {
        leftArrow: direction === "left",
        rightArrow: direction === "right",
      };
      send("", arrow);
      await submit();
      expect(onSubmit).toHaveBeenLastCalledWith({
        ...validProvider,
        model: direction === "left" ? "model-b" : "model-a",
      });
      send("", arrow);
      send("", arrow);
      await submit();
      expect(onSubmit).toHaveBeenLastCalledWith({
        ...validProvider,
        model: direction === "left" ? "model-b" : "model-a",
      });
    },
  );

  it("allows manual paste, typing, clearing and alternate cursor keys after success", async () => {
    mockModels("model-a");
    const { onSubmit } = mount();
    nextFields(4);
    await advance();
    send("u", { ctrl: true });
    paste("custom");
    send("b", { ctrl: true });
    send("X");
    send("f", { ctrl: true });
    send("Y");
    send("", { home: true });
    paste("my-");
    send("", { end: true });
    send("-id");
    await submit();
    expect(onSubmit).toHaveBeenCalledWith({
      ...validProvider,
      model: "my-custoXmY-id",
    });
    expect(terminalOutput()).toContain("type/paste any ID");
    await advance(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["empty", "failure"])(
    "keeps normal cursor editing and manual submission after %s discovery",
    async (outcome) => {
      if (outcome === "failure") {
        fetchMock.mockRejectedValue(new Error("secret-key private error body"));
      }
      const { onSubmit } = mount({ ...validProvider, model: "" });
      nextFields(4);
      await advance();
      paste("manual");
      send("", { leftArrow: true });
      send("X");
      send("", { rightArrow: true });
      send("-id");
      await submit();
      expect(onSubmit).toHaveBeenCalledWith({
        ...validProvider,
        model: "manuaXl-id",
      });
      expect(terminalOutput()).toContain(
        outcome === "failure"
          ? "Model discovery unavailable"
          : "No models returned",
      );
      expect(terminalOutput()).not.toContain("private error body");
      expect(terminalOutput()).not.toContain(validProvider.api_key);
    },
  );

  it.each([false, true])(
    "never replaces a model edited during a request (cleared: %s)",
    async (clear) => {
      const pending = deferredResponse();
      fetchMock.mockReturnValue(pending.promise);
      const { onSubmit } = mount({ ...validProvider, model: "" });
      nextFields(4);
      await advance();
      paste("in-progress");
      if (clear) {
        send("u", { ctrl: true });
      }
      await act(async () => {
        pending.resolve(Response.json({ data: [{ id: "discovered" }] }));
        await pending.promise;
      });
      await submit();
      if (clear) {
        expect(onSubmit).not.toHaveBeenCalled();
        expect(terminalOutput()).toContain("Model is required");
      } else {
        expect(onSubmit).toHaveBeenCalledWith({
          ...validProvider,
          model: "in-progress",
        });
      }
    },
  );

  it("retriggers on base URL, API key and protocol changes while clearing old results", async () => {
    mockModels("old-model");
    const { onSubmit } = mount({ ...validProvider, thinking: "medium" });
    await advance();
    nextFields(2);
    outputChunks = [];
    send("u", { ctrl: true });
    expect(terminalOutput()).not.toContain("models available");
    paste("https://new.example/proxy/v1");
    nextFields(2);
    await advance();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      "https://new.example/proxy/v1/models",
    );
    send("", { upArrow: true });
    send("u", { ctrl: true });
    paste("new-secret");
    nextFields(1);
    await advance();
    expect(fetchMock.mock.calls.at(-1)?.[1]?.headers).toHaveProperty(
      "x-api-key",
      "new-secret",
    );
    send("", { upArrow: true });
    send("", { upArrow: true });
    send("", { upArrow: true });
    send("", { rightArrow: true });
    await advance();
    expect(fetchMock.mock.calls.at(-1)?.[1]?.headers).toHaveProperty(
      "Authorization",
      "Bearer new-secret",
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await submit();
    expect(onSubmit).toHaveBeenCalledWith({
      ...validProvider,
      protocol: "openai",
      base_url: "https://new.example/proxy/v1",
      api_key: "new-secret",
      thinking: "medium",
    });
    expect(terminalOutput()).not.toContain("new-secret");
  });

  it("rejects stale responses even when the transport ignores cancellation", async () => {
    const old = deferredResponse();
    fetchMock.mockReturnValueOnce(old.promise);
    mockModels("new-a", "new-b");
    const { onSubmit } = mount({ ...validProvider, model: "" });
    await advance();
    const oldSignal = fetchMock.mock.calls[0]?.[1]?.signal;
    nextFields(2);
    send("u", { ctrl: true });
    paste("https://new.example/v1");
    expect(oldSignal?.aborted).toBe(true);
    nextFields(2);
    await advance();
    outputChunks = [];
    await act(async () => {
      old.resolve(Response.json({ data: [{ id: "stale-model" }] }));
      await old.promise;
    });
    expect(terminalOutput()).not.toContain("stale-model");
    await submit();
    expect(onSubmit).toHaveBeenLastCalledWith({
      ...validProvider,
      base_url: "https://new.example/v1",
      model: "new-a",
    });
    send("", { rightArrow: true });
    await submit();
    expect(onSubmit).toHaveBeenLastCalledWith({
      ...validProvider,
      base_url: "https://new.example/v1",
      model: "new-b",
    });
  });

  it("clears a failed status immediately when connection details change", async () => {
    fetchMock.mockRejectedValue(new Error("unavailable"));
    mount();
    await advance();
    expect(terminalOutput()).toContain("Model discovery unavailable");
    nextFields(3);
    outputChunks = [];
    paste("-updated");
    expect(terminalOutput()).not.toContain("Model discovery unavailable");
    mockModels("retried-model");
    nextFields(1);
    await advance();
    expect(terminalOutput()).toContain("1 models available");
  });

  it("allows saving a manually entered model while discovery is loading", async () => {
    const pending = deferredResponse();
    fetchMock.mockReturnValue(pending.promise);
    const { onSubmit } = mount({ ...validProvider, model: "" });
    await advance();
    expect(terminalOutput()).toContain("Fetching models");
    nextFields(4);
    paste("manual-id");
    await submit();
    expect(onSubmit).toHaveBeenCalledWith({
      ...validProvider,
      model: "manual-id",
    });
    await act(async () => {
      pending.resolve(Response.json({ data: [] }));
      await pending.promise;
    });
  });

  it.each([false, true])(
    "cancels discovery on unmount (request started: %s)",
    async (started) => {
      const pending = deferredResponse();
      fetchMock.mockReturnValue(pending.promise);
      mount();
      if (started) {
        await advance();
      }
      const signal = fetchMock.mock.calls[0]?.[1]?.signal;
      act(() => {
        instance?.unmount();
        instance?.cleanup();
      });
      instance = undefined;
      if (started) {
        expect(signal?.aborted).toBe(true);
      }
      outputChunks = [];
      await act(async () => {
        pending.resolve(Response.json({ data: [{ id: "late-model" }] }));
        await pending.promise;
      });
      await advance(1_000);
      expect(fetchMock).toHaveBeenCalledTimes(started ? 1 : 0);
      expect(terminalOutput()).not.toContain("late-model");
    },
  );

  it.each([32, 48])(
    "keeps discovery and manual-input hints readable at %s columns",
    async (columns) => {
      vi.mocked(useWindowSize).mockReturnValue({ columns, rows: 24 });
      Object.defineProperty(process.stdout, "columns", {
        configurable: true,
        value: columns,
      });
      mockModels("model-a", "model-b");
      mount();
      await advance();
      const output = terminalOutput();
      expect(output).toContain("2 models available");
      expect(output).toContain("type/paste any ID");
      expect(output).toContain("Ctrl+B/F");
      const lines = outputChunks.flatMap((chunk) =>
        stripVTControlCharacters(chunk).split("\n"),
      );
      expect(lines.filter((line) => stringWidth(line) > columns)).toEqual([]);
      expect(output).not.toContain(validProvider.api_key);
    },
  );
});
