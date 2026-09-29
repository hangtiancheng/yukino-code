import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installSyncOutput } from "@/ui/sync-output.js";

const originalStdoutWrite = process.stdout.write.bind(process.stdout);

describe("installSyncOutput", () => {
  beforeEach(() => {
    vi.stubEnv("TERM_PROGRAM", "vscode");
    vi.stubEnv("TMUX", "");
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("corks a frame while preserving raw chunks, callbacks, and backpressure", async () => {
    const encoded = Buffer.from("€", "utf8");
    const firstHalf = encoded.subarray(0, 1);
    const secondHalf = encoded.subarray(1);
    const writes: (string | Uint8Array)[] = [];
    const pendingCallbacks: ((error?: Error | null) => void)[] = [];
    const callback = vi.fn();
    const cork = vi
      .spyOn(process.stdout, "cork")
      .mockImplementation(() => undefined);
    const uncork = vi.spyOn(process.stdout, "uncork").mockImplementation(() => {
      for (const pending of pendingCallbacks.splice(0)) {
        pending();
      }
    });
    vi.spyOn(process.stdout, "write").mockImplementation(
      (chunk, encodingOrCallback, writeCallback) => {
        writes.push(chunk);
        const pending =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : writeCallback;
        if (pending) {
          pendingCallbacks.push(pending);
        }
        return chunk !== secondHalf;
      },
    );

    installSyncOutput();

    expect(process.stdout.write(firstHalf, callback)).toBe(true);
    expect(process.stdout.write(secondHalf)).toBe(false);
    expect(cork).toHaveBeenCalledTimes(1);
    expect(uncork).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(writes.slice(0, 3)).toEqual(["\x1b[?2026h", firstHalf, secondHalf]);

    await Promise.resolve();

    expect(writes[3]).toBe("\x1b[?2026l");
    expect(uncork).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    const rawChunks = writes.filter(
      (chunk): chunk is Uint8Array => chunk instanceof Uint8Array,
    );
    expect(Buffer.concat(rawChunks).toString("utf8")).toBe("€");
  });
});
