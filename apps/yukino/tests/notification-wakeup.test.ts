import { render, type Instance } from "ink";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNotificationWakeup } from "@/ui/use-notification-wakeup.js";

type Options = Parameters<typeof useNotificationWakeup>[0];
let instance: Instance | undefined;

function Harness(props: Options) {
  useNotificationWakeup(props);
  return null;
}

function mount(props: Options): void {
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
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  act(() => {
    instance?.unmount();
    instance?.cleanup();
  });
  instance = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("notification wakeup", () => {
  it("waits until the UI is idle before starting a notification turn", async () => {
    let pending = false;
    const run = vi.fn(() => {
      pending = false;
      return Promise.resolve();
    });
    const base = {
      hasPending: () => pending,
      run,
      onError: vi.fn(),
      pollIntervalMs: 10,
    };

    mount({ ...base, blocked: true });
    pending = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(run).not.toHaveBeenCalled();

    mount({ ...base, blocked: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not start overlapping turns while a notification run is active", async () => {
    let pending = true;
    let finish!: () => void;
    const active = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run = vi.fn(async () => {
      await active;
      pending = false;
    });

    mount({
      blocked: false,
      hasPending: () => pending,
      run,
      onError: vi.fn(),
      pollIntervalMs: 10,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(run).toHaveBeenCalledOnce();

    await act(async () => {
      finish();
      await active;
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(run).toHaveBeenCalledOnce();
  });
});
