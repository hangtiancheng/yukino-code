import { render, useInput } from "ink";
import type { Instance, Key } from "ink";
import type * as Ink from "ink";
import { act, createElement } from "react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SubagentProgress } from "@/ui/agent-tool-progress.js";
import {
  createInterruptHandlers,
  isForegroundBusy,
  type InterruptDeps,
} from "@/ui/interrupt-scope.js";
import { useTerminalControls } from "@/ui/use-terminal-controls.js";

const stdoutStub = vi.hoisted(() => ({
  columns: 80,
  rows: 24,
  on: vi.fn(),
  off: vi.fn(),
  write: vi.fn(),
}));

vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof Ink>()),
  useInput: vi.fn(),
  useStdout: vi.fn(() => ({ stdout: stdoutStub, write: stdoutStub.write })),
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

let instance: Instance | undefined;
let lastCtrlCHint = false;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(useInput).mockClear();
  stdoutStub.on.mockClear();
  stdoutStub.off.mockClear();
  stdoutStub.write.mockClear();
  lastCtrlCHint = false;
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

describe("isForegroundBusy (single Ctrl+C / Esc scope gate)", () => {
  const subagent = (
    over: Partial<SubagentProgress> = {},
  ): SubagentProgress => ({
    toolCallId: "call-1",
    role: "general-purpose",
    turnCount: 0,
    activeTools: [],
    status: "running",
    ...over,
  });

  it("treats the streaming loop and compaction as foreground work", () => {
    expect(isForegroundBusy(true, false, [])).toBe(true);
    expect(isForegroundBusy(false, true, [])).toBe(true);
  });

  it("treats a synchronous subagent (no taskId) as foreground work", () => {
    expect(isForegroundBusy(false, false, [subagent()])).toBe(true);
  });

  it("ignores background subagents: they carry their background task id", () => {
    expect(
      isForegroundBusy(false, false, [subagent({ taskId: "agent-1" })]),
    ).toBe(false);
  });

  it("ignores finished subagents and the idle state", () => {
    expect(
      isForegroundBusy(false, false, [
        subagent({ toolCallId: "c2", status: "completed" }),
        subagent({ toolCallId: "c3", status: "stopped" }),
        subagent({ toolCallId: "c4", status: "failed" }),
      ]),
    ).toBe(false);
    expect(isForegroundBusy(false, false, [])).toBe(false);
  });
});

describe("createInterruptHandlers (interrupt scope)", () => {
  function mountHandlers() {
    const controller = new AbortController();
    const permissionResolve = vi.fn();
    const askResolve = vi.fn();
    const setPermissionRequest = vi.fn();
    const setAskRequest = vi.fn();
    const stopBackgroundTasks = vi.fn().mockResolvedValue(undefined);
    const stopTeams = vi.fn().mockResolvedValue(undefined);
    const deps: InterruptDeps = {
      abortControllerRef: { current: controller },
      permissionResolveRef: { current: permissionResolve },
      setPermissionRequest,
      askResolveRef: { current: askResolve },
      setAskRequest,
      backgroundTasks: { stopAll: stopBackgroundTasks },
      teams: { stopAll: stopTeams },
    };
    return {
      controller,
      permissionResolve,
      askResolve,
      setPermissionRequest,
      setAskRequest,
      stopBackgroundTasks,
      stopTeams,
      deps,
      handlers: createInterruptHandlers(deps),
    };
  }

  it("interruptForeground aborts the loop and dismisses prompts but keeps background work running", () => {
    const h = mountHandlers();
    h.handlers.interruptForeground();
    expect(h.controller.signal.aborted).toBe(true);
    expect(h.permissionResolve).toHaveBeenCalledWith("deny");
    expect(h.deps.permissionResolveRef.current).toBeNull();
    expect(h.setPermissionRequest).toHaveBeenCalledWith(null);
    expect(h.askResolve).toHaveBeenCalledWith({});
    expect(h.deps.askResolveRef.current).toBeNull();
    expect(h.setAskRequest).toHaveBeenCalledWith(null);
    // The core regression: a single Ctrl+C must never stop background tasks,
    // background subagents or teammates.
    expect(h.stopBackgroundTasks).not.toHaveBeenCalled();
    expect(h.stopTeams).not.toHaveBeenCalled();
  });

  it("interruptAll (TUI exit) additionally stops background tasks and teammates", () => {
    const h = mountHandlers();
    h.handlers.interruptAll();
    expect(h.controller.signal.aborted).toBe(true);
    expect(h.stopBackgroundTasks).toHaveBeenCalledTimes(1);
    expect(h.stopTeams).toHaveBeenCalledTimes(1);
  });

  it("interruptForeground tolerates an idle app with nothing pending", () => {
    const h = mountHandlers();
    h.deps.abortControllerRef.current = null;
    h.deps.permissionResolveRef.current = null;
    h.deps.askResolveRef.current = null;
    expect(() => {
      h.handlers.interruptForeground();
    }).not.toThrow();
    expect(h.stopBackgroundTasks).not.toHaveBeenCalled();
    expect(h.stopTeams).not.toHaveBeenCalled();
  });
});

interface HarnessProps {
  isStreaming: boolean;
  hasRunningWork: boolean;
  clearInputRef: RefObject<(() => void) | null>;
  onInterrupt: () => void;
  onExit: () => void;
  teamsDialogOpen: boolean;
  onToggleTeams: () => void;
  onBackgroundShells: () => void;
}

function Harness(props: HarnessProps) {
  const { ctrlCHint } = useTerminalControls(props);
  lastCtrlCHint = ctrlCHint;
  return null;
}

function mountControls(
  opts: {
    isStreaming?: boolean;
    hasRunningWork?: boolean;
  } = {},
) {
  const onInterrupt = vi.fn();
  const onExit = vi.fn();
  const clearInput = vi.fn();
  act(() => {
    instance = render(
      createElement(Harness, {
        isStreaming: opts.isStreaming ?? false,
        hasRunningWork: opts.hasRunningWork ?? false,
        clearInputRef: { current: clearInput },
        onInterrupt,
        onExit,
        teamsDialogOpen: false,
        onToggleTeams: vi.fn(),
        onBackgroundShells: vi.fn(),
      }),
      { patchConsole: false, interactive: false, debug: true },
    );
  });
  return { onInterrupt, onExit, clearInput };
}

/** Dispatch a keypress to the handlers registered by the latest render. */
function send(input = "", key: Partial<Key> = {}): void {
  // useTerminalControls registers four useInput handlers per render; the last
  // four recorded calls are the freshest closures. Only the Ctrl+C handler
  // reacts to the inputs used here, the others check for o/b/t.
  const handlers = vi
    .mocked(useInput)
    .mock.calls.slice(-4)
    .map((call) => call[0])
    .filter(
      (handler): handler is (input: string, key: Key) => void =>
        typeof handler === "function",
    );
  if (handlers.length === 0) {
    throw new Error("useTerminalControls input handlers are not mounted");
  }
  act(() => {
    for (const handler of handlers) {
      handler(input, { ...noKey, ...key });
    }
  });
}

describe("Ctrl+C dispatch (useTerminalControls)", () => {
  it("interrupts on every press while foreground work runs, never exits", () => {
    const { onInterrupt, onExit } = mountControls({ hasRunningWork: true });
    send("c", { ctrl: true });
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
    // A second press keeps interrupting (the count never advances to exit
    // while foreground work is running).
    send("c", { ctrl: true });
    expect(onInterrupt).toHaveBeenCalledTimes(2);
    expect(onExit).not.toHaveBeenCalled();
    expect(lastCtrlCHint).toBe(false);
  });

  it("exits on the second press while idle and never interrupts", () => {
    const { onInterrupt, onExit, clearInput } = mountControls();
    send("c", { ctrl: true });
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
    expect(clearInput).toHaveBeenCalledTimes(1);
    expect(lastCtrlCHint).toBe(true);
    send("c", { ctrl: true });
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("an intervening keypress resets the press-twice-to-exit count", () => {
    const { onExit } = mountControls();
    send("c", { ctrl: true });
    send("x");
    expect(lastCtrlCHint).toBe(false);
    send("c", { ctrl: true });
    expect(onExit).not.toHaveBeenCalled();
  });

  it("the exit count lapses after two seconds", () => {
    const { onExit } = mountControls();
    send("c", { ctrl: true });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(lastCtrlCHint).toBe(false);
    send("c", { ctrl: true });
    expect(onExit).not.toHaveBeenCalled();
  });
});
