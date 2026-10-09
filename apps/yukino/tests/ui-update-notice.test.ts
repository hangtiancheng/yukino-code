import { stripVTControlCharacters } from "node:util";

import { Box, Text, render, type Instance } from "ink";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateNotice } from "@/ui/update-notice.js";
import { useUpdateNotice } from "@/ui/use-update-notice.js";
import { version } from "@/version.js";

const originalColumns = Object.getOwnPropertyDescriptor(
  process.stdout,
  "columns",
);
let instance: Instance | undefined;
let frame = "";
let updateNotice: ReturnType<typeof useUpdateNotice> | undefined;

function Harness() {
  updateNotice = useUpdateNotice();
  return createElement(
    Box,
    { flexDirection: "column" },
    createElement(Text, null, "TUI ready"),
    createElement(UpdateNotice, { latestVersion: updateNotice.noticeVersion }),
  );
}

function mount(columns = 80) {
  process.stdout.columns = columns;
  act(() => {
    instance = render(createElement(Harness), {
      patchConsole: false,
      interactive: false,
      debug: true,
    });
  });
}

beforeEach(() => {
  vi.stubEnv("YUKINO_SKIP_VERSION_CHECK", "");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: string | Uint8Array) => {
      frame = stripVTControlCharacters(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    },
  );
  frame = "";
});
afterEach(() => {
  act(() => {
    instance?.unmount();
    instance?.cleanup();
  });
  instance = undefined;
  updateNotice = undefined;
  if (originalColumns) {
    Object.defineProperty(process.stdout, "columns", originalColumns);
  } else {
    Reflect.deleteProperty(process.stdout, "columns");
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("TUI update notice", () => {
  it.each([20, 40, 100])(
    "mounts immediately and later shows the update at %i columns",
    async (columns) => {
      let finish: ((response: Response) => void) | undefined;
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      vi.stubGlobal("fetch", fetch);
      mount(columns);
      expect(frame).toContain("TUI ready");
      expect(frame).not.toContain("yukino update");
      await act(async () => {
        finish?.(Response.json({ version: "999.0.0" }));
        await Promise.resolve();
      });
      expect(frame.replace(/\s+/gu, " ")).toContain(
        "New Yukino version v999.0.0 is available. Run yukino update",
      );
      expect(frame.toLowerCase()).not.toContain("changelog");
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each(["before", "after"])(
    "keeps the notice dismissed when the version check completes %s the first submission",
    async (timing) => {
      let finish: ((response: Response) => void) | undefined;
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      vi.stubGlobal("fetch", fetch);
      mount(100);
      const latestVersionRef = updateNotice?.latestVersionRef;
      const completeCheck = async () => {
        await act(async () => {
          finish?.(Response.json({ version: "999.0.0" }));
          await Promise.resolve();
        });
      };
      if (timing === "before") {
        await completeCheck();
        expect(frame).toContain("yukino update");
      }
      act(() => {
        updateNotice?.dismissNotice();
      });
      expect(frame).not.toContain("yukino update");
      if (timing === "after") {
        await completeCheck();
      }
      expect(frame.trim()).toBe("TUI ready");
      expect(latestVersionRef?.current).toBe("999.0.0");
      act(() => {
        instance?.rerender(createElement(Harness));
      });
      expect(frame.trim()).toBe("TUI ready");
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("cancels pending requests when leaving the TUI", async () => {
    let signal: AbortSignal | undefined;
    let finish: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation((_input, options) => {
        signal = options?.signal ?? undefined;
        return new Promise((resolve) => {
          finish = resolve;
        });
      }),
    );
    mount();
    const latestVersionRef = updateNotice?.latestVersionRef;
    expect(signal?.aborted).toBe(false);
    act(() => {
      instance?.unmount();
    });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish?.(Response.json({ version: "999.0.0" }));
      await Promise.resolve();
    });
    expect(latestVersionRef?.current).toBeUndefined();
  });

  it("skips automatic checks when disabled", async () => {
    vi.stubEnv("YUKINO_SKIP_VERSION_CHECK", "1");
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    await act(async () => {
      mount();
      await Promise.resolve();
    });
    expect(frame.trim()).toBe("TUI ready");
    expect(updateNotice?.latestVersionRef.current).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the UI quiet when the installed version is current", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ version })),
    );
    await act(async () => {
      mount();
      await Promise.resolve();
    });
    expect(frame.trim()).toBe("TUI ready");
    expect(updateNotice?.latestVersionRef.current).toBeUndefined();
  });

  it("keeps the UI quiet when the check fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await act(async () => {
      mount();
      await Promise.resolve();
    });
    expect(frame.trim()).toBe("TUI ready");
    expect(updateNotice?.latestVersionRef.current).toBeUndefined();
  });
});
