import type * as childProcess from "node:child_process";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  detectBackend,
  detectBackendFromEnv,
  restoreTeammateCancel,
  spawnTeammate,
} from "@/teams/backend.js";

const execSyncMock = vi.hoisted(() =>
  vi.fn((_command: string, _options?: unknown) => ""),
);

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  execSync: execSyncMock,
}));

const origTmux = process.env.TMUX;
const origIterm = process.env.ITERM_SESSION_ID;

beforeEach(() => {
  execSyncMock.mockClear();
});

afterEach(() => {
  if (origTmux === undefined) {
    delete process.env.TMUX;
  } else {
    process.env.TMUX = origTmux;
  }
  if (origIterm === undefined) {
    delete process.env.ITERM_SESSION_ID;
  } else {
    process.env.ITERM_SESSION_ID = origIterm;
  }
});

describe("detectBackendFromEnv (platform-agnostic)", () => {
  test("inside tmux picks tmux", () => {
    process.env.TMUX = "/tmp/sock,1,0";
    delete process.env.ITERM_SESSION_ID;
    expect(detectBackendFromEnv()).toBe("tmux");
  });
  test("inside iterm2 picks iterm", () => {
    delete process.env.TMUX;
    process.env.ITERM_SESSION_ID = "w0t0p0:ABC";
    expect(detectBackendFromEnv()).toBe("iterm");
  });
  test("tmux wins over iterm", () => {
    process.env.TMUX = "/tmp/sock,1,0";
    process.env.ITERM_SESSION_ID = "w0t0p0:ABC";
    expect(detectBackendFromEnv()).toBe("tmux");
  });
  test("plain terminal falls back to in-process", () => {
    delete process.env.TMUX;
    delete process.env.ITERM_SESSION_ID;
    expect(detectBackendFromEnv()).toBe("in-process");
  });
});

describe("detectBackend Windows guardrail", () => {
  test("inside a tmux session: Windows uses in-process, other platforms use tmux", () => {
    process.env.TMUX = "/tmp/sock,1,0";
    const got = detectBackend();
    if (process.platform === "win32") {
      expect(got).toBe("in-process");
    } else {
      expect(got).toBe("tmux");
    }
  });
});

describe("tmux teammate backend", () => {
  test("creates a fresh detached session directly", () => {
    const spawned = spawnTeammate({
      mode: "tmux",
      command: "node",
      args: ["worker.js"],
      cwd: "/tmp",
    });

    expect(execSyncMock).toHaveBeenCalledOnce();
    expect(execSyncMock.mock.calls[0]?.[0]).toContain("tmux new-session -d");
    expect(execSyncMock.mock.calls[0]?.[0]).not.toContain("new-window");
    expect(spawned.paneId).toMatch(/^yukino-/);
  });

  test("reconstructs cancellation from the persisted session name", () => {
    const cancel = restoreTeammateCancel("tmux", "yukino-restored");
    cancel?.();

    expect(execSyncMock).toHaveBeenCalledWith(
      'tmux kill-session -t "yukino-restored"',
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
    expect(restoreTeammateCancel("iterm")).toBeUndefined();
  });
});
