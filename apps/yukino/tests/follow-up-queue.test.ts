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

import { render, type Instance } from "ink";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFollowUpQueue } from "@/ui/use-follow-up-queue.js";

type Queue = ReturnType<typeof useFollowUpQueue>;
let current: Queue | undefined;
let instance: Instance | undefined;
function Harness(props: Parameters<typeof useFollowUpQueue>[0]) {
  current = useFollowUpQueue(props);
  return null;
}
function queue(): Queue {
  if (!current) {
    throw new Error("Queue is not mounted");
  }
  return current;
}
function pending() {
  let resolve = () => {
    /** noop */
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function mount(props: Parameters<typeof useFollowUpQueue>[0]) {
  act(() => {
    const element = createElement(Harness, props);
    if (instance) {
      instance.rerender(element);
    } else {
      instance = render(element, { interactive: false, patchConsole: false });
    }
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  act(() => {
    instance?.unmount();
    instance?.cleanup();
  });
  instance = undefined;
  current = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("follow-up scheduling", () => {
  it("waits for the full send promise, preserves FIFO, and edits the latest queued message", async () => {
    const first = pending();
    const send = vi.fn(async (message: string) => {
      if (message === "first") {
        await first.promise;
      }
    });
    mount({ blocked: false, send, onError: vi.fn() });
    act(() => {
      queue().enqueue("first");
      queue().enqueue("second");
      queue().enqueue("third");
    });
    expect(send.mock.calls.map(([message]) => message)).toEqual(["first"]);
    expect(queue().messages).toEqual(["second", "third"]);
    act(() => {
      expect(queue().takeLast()).toBe("third");
      queue().enqueue("third edited");
    });
    expect(queue().messages).toEqual(["second", "third edited"]);
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve();
      await first.promise;
    });
    expect(send.mock.calls.map(([message]) => message)).toEqual([
      "first",
      "second",
      "third edited",
    ]);
    expect(queue().messages).toEqual([]);
    expect(queue().processing).toBe(false);
  });

  it("does not lose synchronous submissions or send during a blocking dialog", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    mount({ blocked: true, send, onError });
    act(() => {
      queue().enqueue("one");
      queue().enqueue("two");
      queue().enqueue("   ");
      expect(queue().takeLast()).toBe("two");
      expect(queue().takeLast()).toBe("one");
      expect(queue().takeLast()).toBeUndefined();
      queue().enqueue("edited");
    });
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      mount({ blocked: false, send, onError });
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledExactlyOnceWith("edited");
  });

  it("rechecks blocking after the active request ends", async () => {
    const active = pending();
    const send = vi.fn(async () => {
      await active.promise;
    });
    const onError = vi.fn();
    mount({ blocked: false, send, onError });
    act(() => {
      queue().enqueue("first");
      queue().enqueue("second");
    });
    mount({ blocked: true, send, onError });
    await act(async () => {
      active.resolve();
      await active.promise;
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue().messages).toEqual(["second"]);
    await act(async () => {
      mount({ blocked: false, send, onError });
      await Promise.resolve();
    });
    expect(send.mock.calls).toHaveLength(2);
  });

  it("keeps pending messages paused after a dispatch error", async () => {
    const onError = vi.fn();
    const send = vi
      .fn<(message: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValue(undefined);
    mount({ blocked: false, send, onError });
    await act(async () => {
      queue().enqueue("first");
      queue().enqueue("second");
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue().messages).toEqual(["second"]);
    expect(queue().paused).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
    await act(async () => {
      queue().enqueue("new request");
      await Promise.resolve();
    });
    expect(send.mock.calls.map(([message]) => message)).toEqual([
      "first",
      "second",
      "new request",
    ]);
  });

  it("does not dispatch pending work after unmount", async () => {
    const active = pending();
    const send = vi.fn(async () => {
      await active.promise;
    });
    mount({ blocked: false, send, onError: vi.fn() });
    act(() => {
      queue().enqueue("first");
      queue().enqueue("second");
    });
    act(() => {
      instance?.unmount();
    });
    await act(async () => {
      active.resolve();
      await active.promise;
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
