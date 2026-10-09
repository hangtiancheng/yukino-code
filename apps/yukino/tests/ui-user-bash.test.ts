import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { render, type Instance } from "ink";
import { act, createElement, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationManager } from "@/conversation/index.js";
import { PermissionChecker } from "@/permissions/index.js";
import type { Sandbox } from "@/sandbox/index.js";
import {
  loadSession,
  rebuildFromSession,
  messageToKeptRecord,
  saveCompactBoundary,
} from "@/session/index.js";
import { yukinoPath, getSessionsDir, sessionPath } from "@/storage/paths.js";
import { TaskManager } from "@/subagent/task-manager.js";
import { BashTool } from "@/tools/bash.js";
import type { ToolResult } from "@/tools/types.js";
import type { ChatMessage } from "@/ui/chat.js";
import { useFollowUpQueue } from "@/ui/use-follow-up-queue.js";
import {
  executeUserBash,
  parseUserBashCommand,
  useUserBash,
  useUserBashHistory,
} from "@/ui/use-user-bash.js";

type Options = Omit<Parameters<typeof useUserBash>[0], "setMessages">;
let instance: Instance | undefined;
let current:
  | {
      shell: ReturnType<typeof useUserBash>;
      messages: ChatMessage[];
      queue: ReturnType<typeof useFollowUpQueue>;
    }
  | undefined;
const directories: string[] = [];

function Harness(props: Options & { send?: (text: string) => Promise<void> }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const shell = useUserBash({ ...props, setMessages });
  const queue = useFollowUpQueue({
    blocked: shell.running,
    send: props.send ?? (() => Promise.resolve()),
    onError: vi.fn(),
  });
  current = { shell, messages, queue };
  return null;
}

function state() {
  if (!current) {
    throw new Error("User Bash harness is not mounted");
  }
  return current;
}

function mount(
  overrides: Partial<Options> & { send?: HarnessProps["send"] } = {},
) {
  const options = {
    execute: vi.fn<Options["execute"]>().mockResolvedValue({
      output: "$ printf hello\nhello",
      isError: false,
    }),
    onStart: vi.fn(),
    onSettled: vi.fn(),
    onResult: vi.fn(),
    ...overrides,
  };
  act(() => {
    instance = render(createElement(Harness, options), {
      patchConsole: false,
      interactive: false,
    });
  });
  return options;
}

type HarnessProps = Parameters<typeof Harness>[0];

function deferred() {
  let resolve!: (result: ToolResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ToolResult>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function cwd() {
  const directory = mkdtempSync(join(tmpdir(), "yukino-user-bash-"));
  directories.push(directory);
  return directory;
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
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("user Bash command parsing", () => {
  it.each([
    ["!! git status", "git status"],
    ["  !!\n printf hello\n printf world  ", "printf hello\n printf world"],
    ["!! printf '@README.md /plan !'", "printf '@README.md /plan !'"],
    ["!!", ""],
    ["!! \n ", ""],
    ["! git status", "git status"],
    ["!", ""],
    ["Explain !! git status", null],
    ["/plan", null],
    ["", null],
  ])("parses %j without rewriting its shell syntax", (text, command) => {
    expect(parseUserBashCommand(text)).toEqual(
      command === null
        ? null
        : {
            command,
            excludeFromContext: text.trim().startsWith("!!"),
          },
    );
  });
});

describe("user Bash lifecycle", () => {
  it.each(["!", "!!"])(
    "streams %s output, retains expandable results, and records its context policy",
    async (prefix) => {
      const run = deferred();
      let onOutput!: (output: string) => void;
      const options = mount({
        execute: (_command, _signal, output) => {
          onOutput = output;
          return run.promise;
        },
      });
      act(() => {
        state().shell.submit(`${prefix} printf '@file /plan'`);
        onOutput("\x1b[31mfirst\x1b[0m\n日本語");
      });
      expect(state().shell.tool?.output).toBe("first\n日本語");
      expect(state().shell.running).toBe(true);
      expect(state().shell.backgroundAllowed).toBe(prefix === "!");
      expect(options.onResult).not.toHaveBeenCalled();
      const output = "x".repeat(3000) + "\nlast line";
      await act(async () => {
        run.resolve({ output, isError: false });
        await run.promise;
      });
      expect(state().messages[0]?.toolSummary?.[0]?.output).toBe(output);
      expect(options.onResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          command: "printf '@file /plan'",
          output,
          status: "completed",
          excludeFromContext: prefix === "!!",
        }),
      );
    },
  );

  it("runs immediately and commits a local card without creating an agent turn", async () => {
    const run = deferred();
    const execute = vi.fn<Options["execute"]>(() => run.promise);
    const options = mount({ execute });
    act(() => {
      expect(state().shell.submit("!! printf hello")).toBe(true);
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "printf hello",
      expect.any(AbortSignal),
      expect.any(Function),
      true,
    );
    expect(options.onStart).toHaveBeenCalledExactlyOnceWith("!! printf hello");
    expect(state().shell.tool).toMatchObject({
      toolName: "Bash",
      args: { command: "printf hello" },
      loading: true,
      progress: "User command · excluded in next model context",
    });
    expect(state().messages).toEqual([]);
    expect(state().queue.messages).toEqual([]);
    await act(async () => {
      run.resolve({ output: "$ printf hello\nhello", isError: false });
      await run.promise;
    });
    expect(state().shell.running).toBe(false);
    expect(options.onSettled).toHaveBeenCalledOnce();
    expect(state().messages).toEqual([
      {
        role: "turn_summary",
        content: "",
        toolSummary: [
          expect.objectContaining({
            toolName: "Bash",
            argsSummary: "printf hello",
            output: "$ printf hello\nhello",
            isError: false,
            status: "completed",
          }),
        ],
      },
    ]);
  });

  it("leaves normal text and slash commands to chat routing", () => {
    const options = mount();
    for (const text of ["hello", "/plan", "Explain !!"]) {
      expect(state().shell.submit(text)).toBeUndefined();
    }
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.onStart).not.toHaveBeenCalled();
  });

  it("rejects an empty command without execution or prompt history", () => {
    const options = mount();
    act(() => {
      expect(state().shell.submit("!!  ")).toBe(false);
    });
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.onStart).not.toHaveBeenCalled();
    expect(state().shell.running).toBe(false);
    expect(state().messages[0]?.content).toContain("after !!");
  });

  it("rejects simultaneous submissions synchronously, before a render", async () => {
    const run = deferred();
    const execute = vi.fn<Options["execute"]>(() => run.promise);
    const options = mount({ execute });
    act(() => {
      expect(state().shell.submit("!! first")).toBe(true);
      expect(state().shell.submit("!! second")).toBe(false);
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(options.onStart).toHaveBeenCalledExactlyOnceWith("!! first");
    expect(state().messages[0]?.content).toContain("already running");
    await act(async () => {
      run.resolve({ output: "done", isError: false });
      await run.promise;
    });
  });

  it("cancels only its own signal and permits another command after completion", async () => {
    const agent = new AbortController();
    const background = new AbortController();
    const run = deferred();
    let signal: AbortSignal | undefined;
    mount({
      execute: (_command, currentSignal) => {
        signal = currentSignal;
        return run.promise;
      },
    });
    act(() => {
      state().shell.submit("!! sleep 5");
      expect(state().shell.interrupt()).toBe(true);
    });
    expect(signal?.aborted).toBe(true);
    expect(agent.signal.aborted).toBe(false);
    expect(background.signal.aborted).toBe(false);
    expect(state().shell.running).toBe(true);
    await act(async () => {
      run.resolve({ output: "Error: command interrupted", isError: true });
      await run.promise;
    });
    expect(state().messages.at(-1)?.toolSummary?.[0]?.status).toBe("stopped");
    expect(state().shell.interrupt()).toBe(false);
    await act(async () => {
      expect(state().shell.submit("!! echo next")).toBe(true);
      await Promise.resolve();
    });
  });

  it("blocks new idle chat turns until the command finishes", async () => {
    const run = deferred();
    const send = vi.fn().mockResolvedValue(undefined);
    mount({ execute: () => run.promise, send });
    act(() => {
      state().shell.submit("!! work");
    });
    act(() => {
      state().queue.enqueue("next prompt");
      state().queue.enqueue("/clear");
    });
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      run.resolve({ output: "done", isError: false });
      await run.promise;
    });
    expect(send.mock.calls).toEqual([["next prompt"], ["/clear"]]);
  });

  it("joins interrupted execution during exit", async () => {
    const run = deferred();
    let signal: AbortSignal | undefined;
    mount({
      execute: (_command, currentSignal) => {
        signal = currentSignal;
        return run.promise;
      },
    });
    act(() => {
      state().shell.submit("!! work");
    });
    const stopped = vi.fn();
    const stop = state().shell.stop().then(stopped);
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    await act(async () => {
      run.resolve({ output: "interrupted", isError: true });
      await stop;
    });
    expect(stopped).toHaveBeenCalledOnce();
  });

  it("aborts on unmount and does not append results to an unmounted transcript", async () => {
    const run = deferred();
    let signal: AbortSignal | undefined;
    const options = mount({
      execute: (_command, currentSignal) => {
        signal = currentSignal;
        return run.promise;
      },
    });
    act(() => {
      state().shell.submit("!! work");
      instance?.unmount();
    });
    expect(signal?.aborted).toBe(true);
    run.resolve({ output: "done", isError: false });
    await run.promise;
    expect(options.onSettled).not.toHaveBeenCalled();
    expect(state().messages).toEqual([]);
  });

  it("reports execution failures and releases the command slot", async () => {
    mount({ execute: () => Promise.reject(new Error("spawn failed")) });
    await act(async () => {
      state().shell.submit("!! work");
      await Promise.resolve();
    });
    expect(state().shell.running).toBe(false);
    expect(state().messages[0]?.toolSummary?.[0]).toMatchObject({
      isError: true,
      status: "failed",
      output: "Error: spawn failed",
    });
  });

  it("does not execute if recording command history fails", async () => {
    const execute = vi.fn<Options["execute"]>();
    mount({
      execute,
      onStart: () => {
        throw new Error("history is not writable");
      },
    });
    await act(async () => {
      state().shell.submit("!! work");
      await Promise.resolve();
    });
    expect(execute).not.toHaveBeenCalled();
    expect(state().shell.running).toBe(false);
    expect(state().messages[0]?.toolSummary?.[0]?.output).toContain("history");
  });

  it("strips terminal controls and retains expandable output without rewriting execution", async () => {
    const execute = vi.fn<Options["execute"]>().mockResolvedValue({
      output:
        "\x1b[2J\x1b[31mhello\x1b[0m\x00\x07\n日本\t世界\n" + "x".repeat(3000),
      isError: false,
    });
    mount({ execute });
    await act(async () => {
      state().shell.submit("!! printf hello\n printf world");
      await Promise.resolve();
    });
    expect(execute.mock.calls[0]?.[0]).toBe("printf hello\n printf world");
    const card = state().messages[0]?.toolSummary?.[0];
    expect(card?.argsSummary).toBe("printf hello  printf world");
    expect(card?.output).toContain("hello\n日本\t世界");
    expect(card?.output).not.toMatch(/[\x00\x07\x1b]/u);
    expect(card?.output).toContain("x".repeat(3000));
  });
});

describe("user Bash executor boundaries", () => {
  it("backgrounds only included commands on the shared Bash instance and delivers their output", async () => {
    const bash = new BashTool();
    const tasks = new TaskManager();
    bash.taskManager = tasks;
    const includedController = new AbortController();
    const excludedController = new AbortController();
    const directory = cwd();
    const excluded = executeUserBash(
      bash,
      { cwd: cwd(), abortSignal: excludedController.signal },
      "printf excluded-output; sleep 30",
      true,
    );
    const included = executeUserBash(
      bash,
      { cwd: directory, abortSignal: includedController.signal },
      "printf included-start; sleep 0.2; printf included-end",
      false,
    );
    try {
      await vi.waitFor(() => {
        expect(bash.hasForegroundTasks()).toBe(true);
      });
      expect(bash.backgroundForegroundTasks()).toBe(1);
      expect(bash.hasForegroundTasks()).toBe(false);
      const result = await included;
      expect(result.isError).toBe(false);
      expect(result.output).toContain("manually backgrounded by the user");
      expect(excludedController.signal.aborted).toBe(false);
      includedController.abort();
      await tasks.waitAll();
      const notifications = tasks.drainNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.status).toBe("completed");
      expect(notifications[0]?.output).toContain("included-end");
      expect(notifications[0]?.output).not.toContain("excluded-output");
    } finally {
      includedController.abort();
      excludedController.abort();
      await tasks.stopAll();
      await Promise.all([included, excluded]);
    }
  });

  it("automatically backgrounds an included command at its 120s deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const bash = new BashTool();
    const tasks = new TaskManager();
    bash.taskManager = tasks;
    const controller = new AbortController();
    const pending = executeUserBash(
      bash,
      { cwd: cwd(), abortSignal: controller.signal },
      "sleep 30",
      false,
    );
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      const result = await pending;
      expect(result.isError).toBe(false);
      expect(result.output).toContain("exceeded its 120s timeout");
      expect(result.output).toContain("moved to the background");
      expect(tasks.list()[0]?.status).toBe("running");
    } finally {
      vi.useRealTimers();
      controller.abort();
      await tasks.stopAll();
      await pending;
    }
  });

  it("keeps excluded commands in the foreground beyond 120s until cancelled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const bash = new BashTool();
    const tasks = new TaskManager();
    bash.taskManager = tasks;
    const controller = new AbortController();
    const pending = executeUserBash(
      bash,
      { cwd: cwd(), abortSignal: controller.signal },
      "sleep 30",
      true,
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(settled).toBe(false);
      expect(bash.hasForegroundTasks()).toBe(false);
      expect(bash.backgroundForegroundTasks()).toBe(0);
      expect(tasks.list()).toEqual([]);
      expect(tasks.drainNotifications()).toEqual([]);
    } finally {
      vi.useRealTimers();
      controller.abort();
    }
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.output).toContain("command interrupted");
    expect(result.output).not.toContain("timed out");
  });

  it("bounds line count and preserves output if artifact persistence fails", async () => {
    const directory = cwd();
    const bash = new BashTool();
    const output = Array.from(
      { length: 3000 },
      (_, index) => `line-${String(index)}`,
    ).join("\n");
    vi.spyOn(bash, "execute").mockResolvedValue({ output, isError: false });
    const result = await executeUserBash(
      bash,
      { cwd: directory, sessionId: "lines" },
      "emit",
      false,
    );
    expect(result.output.split("\n")).toHaveLength(2001);
    expect(result.output).toContain("line-2999");
    expect(result.output).not.toContain("line-0\n");
    const deniedDirectory = cwd();
    writeFileSync(sessionPath("denied"), "file blocks the artifact directory");
    const failed = await executeUserBash(
      bash,
      { cwd: deniedDirectory, sessionId: "denied" },
      "emit",
      false,
    );
    expect(failed.isError).toBe(true);
    expect(failed.output).toContain("could not save full output");
    expect(failed.output).toContain("line-2999");
  });

  it("keeps a UTF-8-safe output tail and persists complete large output", async () => {
    const directory = cwd();
    const result = await executeUserBash(
      new BashTool(),
      { cwd: directory, sessionId: "large-output" },
      "printf beginning; for ((i=0; i<20000; i++)); do printf '日本語'; done; printf '\\nending'",
      false,
    );
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Output truncated");
    expect(result.output).toContain("ending");
    expect(result.output).not.toContain("�");
    expect(Buffer.byteLength(result.output)).toBeLessThan(53_000);
    const path = /Full output: (.+)\]/u.exec(result.output)?.[1];
    expect(path).toBeDefined();
    if (!path) {
      throw new Error("Missing full output path");
    }
    const full = readFileSync(path, "utf8");
    expect(full).toContain("beginning");
    expect(full).toContain("日本語".repeat(20000));
    expect(full).toContain("ending");
  });

  it("reports foreground output before completion and isolates observer failures", async () => {
    const directory = cwd();
    const output: string[] = [];
    const controller = new AbortController();
    const started = deferred();
    const pending = executeUserBash(
      new BashTool(),
      {
        cwd: directory,
        abortSignal: controller.signal,
        onOutput: (text) => {
          output.push(text);
          started.resolve({ output: text, isError: false });
          throw new Error("broken output observer");
        },
      },
      "printf '日本語 started'; sleep 5",
      false,
    );
    const timer = setTimeout(() => {
      controller.abort();
    }, 2500);
    try {
      await Promise.race([started.promise, pending]);
      expect(output[0]).toContain("日本語 started");
      controller.abort();
      const result = await pending;
      expect(result.output).toContain("日本語 started");
      expect(result.output).toContain("command interrupted");
    } finally {
      clearTimeout(timer);
      controller.abort();
      await pending;
    }
  });

  it("executes excluded commands without background notifications or conversation records", async () => {
    const directory = cwd();
    const bash = new BashTool();
    const tasks = new TaskManager();
    bash.taskManager = tasks;
    const conversation = new ConversationManager();
    const execute = vi.spyOn(bash, "execute");
    const command =
      "printf '%s' '@README.md /plan'; pwd; printf error >&2; exit 3";
    const result = await executeUserBash(
      bash,
      { cwd: directory, sessionId: "local-test" },
      command,
      true,
    );
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      {
        cwd: directory,
        sessionId: "local-test",
        taskManager: null,
        shellTimeoutDisabled: true,
      },
      { command },
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("@README.md /plan");
    expect(result.output).toContain(directory);
    expect(result.output).toContain("error");
    expect(result.output).toContain("Exit code 3");
    expect(tasks.list()).toEqual([]);
    expect(tasks.drainNotifications()).toEqual([]);
    expect(conversation.getMessages()).toEqual([]);
    expect(existsSync(getSessionsDir(directory))).toBe(false);
    expect(readdirSync(yukinoPath("sessions", "artifacts"))).toEqual([
      "local-test",
    ]);
    expect(bash.backgroundForegroundTasks()).toBe(0);
  });

  it("treats the command as user-authorized even when the agent is in Plan", async () => {
    const directory = cwd();
    const checker = new PermissionChecker(directory, "plan");
    expect(
      checker.check("Bash", "command", { command: "mkdir user-dir" }).effect,
    ).toBe("deny");
    const result = await executeUserBash(
      new BashTool(),
      { cwd: directory },
      "mkdir user-dir",
      false,
    );
    expect(result.isError).toBe(false);
    expect(readdirSync(directory)).toContain("user-dir");
  });

  it("retains configured OS sandbox enforcement and fails closed", async () => {
    const bash = new BashTool();
    const prepare = vi.fn();
    const sandbox: Sandbox = {
      implementation: "seatbelt",
      available: () => Promise.resolve(false),
      prepare,
    };
    bash.sandbox = sandbox;
    bash.sandboxRequired = true;
    const directory = cwd();
    const result = await executeUserBash(
      bash,
      { cwd: directory },
      "mkdir denied",
      false,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("sandbox is unavailable");
    expect(readdirSync(directory)).not.toContain("denied");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("cancels an excluded command without backgrounding it", async () => {
    const directory = cwd();
    const bash = new BashTool();
    const tasks = new TaskManager();
    bash.taskManager = tasks;
    const controller = new AbortController();
    const pending = executeUserBash(
      bash,
      { cwd: directory, abortSignal: controller.signal },
      "printf started; sleep 5",
      true,
    );
    const timer = setTimeout(() => {
      controller.abort();
    }, 100);
    let result: ToolResult;
    try {
      expect(bash.hasForegroundTasks()).toBe(false);
      expect(bash.backgroundForegroundTasks()).toBe(0);
      result = await pending;
    } finally {
      clearTimeout(timer);
    }
    expect(result.isError).toBe(true);
    expect(result.output).toContain("command interrupted");
    expect(tasks.list()).toEqual([]);
    expect(tasks.drainNotifications()).toEqual([]);
  });
});

describe("user Bash session history", () => {
  it("defers results past an active tool pair and restores !! cards without exposing them to model context", async () => {
    const directory = cwd();
    const conversation = new ConversationManager();
    conversation.addAssistantFull(
      "",
      [],
      [
        {
          toolUseId: "read-1",
          toolName: "ReadFile",
          arguments: { path: "file" },
        },
      ],
    );
    const sessionId = { current: "bash-history" };
    let history!: ReturnType<typeof useUserBashHistory>;
    function Journal({ busy }: { busy: boolean }) {
      history = useUserBashHistory({
        cwd: directory,
        sessionId,
        conversation,
        busy,
        onError: vi.fn(),
      });
      return null;
    }
    act(() => {
      instance = render(createElement(Journal, { busy: true }), {
        interactive: false,
        patchConsole: false,
      });
      history.record({
        command: "printf included",
        output: "included",
        isError: false,
        elapsed: 1,
        status: "completed",
        excludeFromContext: false,
      });
      history.record({
        command: "printf excluded",
        output: "excluded",
        isError: false,
        elapsed: 2,
        status: "completed",
        excludeFromContext: true,
      });
    });
    expect(conversation.getMessages()).toHaveLength(1);
    expect(loadSession(directory, sessionId.current)).toEqual([]);
    conversation.addToolResultsMessage([
      { toolUseId: "read-1", content: "file contents", isError: false },
    ]);
    await act(async () => {
      instance?.rerender(createElement(Journal, { busy: false }));
      await Promise.resolve();
    });
    const messages = conversation.getMessages();
    expect(messages).toHaveLength(3);
    expect(messages[1].toolResults?.[0].toolUseId).toBe("read-1");
    expect(messages[2].content).toContain("included");
    expect(JSON.stringify(messages)).not.toContain("excluded");
    const saved = loadSession(directory, sessionId.current);
    expect(saved).toHaveLength(2);
    expect(rebuildFromSession(saved)).toHaveLength(1);
    expect(
      rebuildFromSession(saved, { includeExcludedUserBash: true }),
    ).toHaveLength(2);
    act(() => {
      history.flush();
    });
    expect(loadSession(directory, sessionId.current)).toHaveLength(2);
    saveCompactBoundary(directory, sessionId.current, {
      summary: "summary",
      keep: [messageToKeptRecord(messages[2])],
    });
    const compacted = rebuildFromSession(
      loadSession(directory, sessionId.current),
    );
    expect(compacted.at(-1)?.userBash?.command).toBe("printf included");
  });

  it("persists deferred results on exit without changing an active model conversation", () => {
    const directory = cwd();
    const conversation = new ConversationManager();
    let history!: ReturnType<typeof useUserBashHistory>;
    function Journal() {
      history = useUserBashHistory({
        cwd: directory,
        sessionId: { current: "exit-history" },
        conversation,
        busy: true,
        onError: vi.fn(),
      });
      return null;
    }
    act(() => {
      instance = render(createElement(Journal), {
        interactive: false,
        patchConsole: false,
      });
      history.record({
        command: "printf last",
        output: "last",
        isError: true,
        elapsed: 1,
        status: "stopped",
        excludeFromContext: false,
      });
      history.flush(false);
    });
    expect(conversation.getMessages()).toEqual([]);
    const restored = rebuildFromSession(loadSession(directory, "exit-history"));
    expect(restored[0].userBash?.status).toBe("stopped");
    expect(restored[0].content).toContain("last");
  });
});
