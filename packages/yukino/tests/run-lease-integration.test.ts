import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderConfigSchema } from "@/config/provider-config.js";
import { getExecutionContext, withExecutionContext } from "@/cost/context.js";
import type { LLMClient } from "@/llm/client.js";
import { createAgentRuntime } from "@/runtime/factory.js";
import type { AgentRuntime, CreateRuntimeOptions } from "@/runtime/types.js";
import { SESSION_LEASE_ACTIVE } from "@/session/constants.js";
import {
  listSessionRunLeases,
  type SessionStorageTarget,
} from "@/session/lease.js";
import { planSessionMaintenance } from "@/session/maintenance.js";
import { SessionManager } from "@/session/manager.js";
import { getSessionFilePath, readSessionDocument } from "@/session/records.js";
import { getYukinoDir, sessionPath } from "@/storage/index.js";
import { BUILTIN_AGENTS, TRANSCRIPT_FILENAME } from "@/subagent/constants.js";
import { spawnSubagent } from "@/subagent/spawn.js";
import { TaskManager } from "@/subagent/task-manager.js";
import { CodeModeTool } from "@/tools/code-mode.js";
import { ToolRegistry } from "@/tools/registry.js";
import { WorkflowTool } from "@/workflow/workflow-tool.js";

const runtimes: AgentRuntime[] = [];
const closers: (() => Promise<unknown>)[] = [];
const usage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadInputTokens: 1000,
  cacheCreationInputTokens: 0,
};
const provider = ProviderConfigSchema.parse({
  name: "fixture",
  model: "fixture",
  protocol: "anthropic",
  base_url: "https://example.invalid",
  context_window: 200000,
  max_output_tokens: 1000,
  price: {
    currency: "USD",
    input: 10,
    output: 2,
    cache_read: 0.1,
    cache_write: 12,
    source: "fixture",
    effective_at: "2025-01-01T00:00:00Z",
  },
  cache: {
    mode: "short",
    capabilities: {
      verified: true,
      mapping: "anthropic_ephemeral",
      short: { ttl_seconds: 300, min_tokens: 10 },
      replayable: true,
    },
  },
});

function gate() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) {
    throw new Error("Missing cancellation signal");
  }
  signal.throwIfAborted();
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(new Error("Cancelled"));
      },
      { once: true },
    );
  });
}
function reply(): LLMClient {
  return {
    protocol: "anthropic",
    setSystemPrompt() {},
    async *stream() {
      await Promise.resolve();
      yield { type: "text_delta", text: "done" };
      yield {
        type: "stream_end",
        stopReason: "end_turn",
        usage,
        usageComplete: true,
      };
    },
  };
}
function project(name = "project"): string {
  const cwd = join(dirname(getYukinoDir()), name);
  mkdirSync(cwd, { recursive: true });
  return cwd;
}
async function runtime(
  client = reply(),
  options: Partial<CreateRuntimeOptions> = {},
): Promise<AgentRuntime> {
  const handle = await createAgentRuntime({
    cwd: project(),
    sessionId: "custom-session",
    provider,
    client,
    systemPrompt: "fixture",
    enableCoordinatorMode: false,
    memoryEnabled: false,
    loadProjectResources: false,
    trackFileChanges: false,
    ...options,
  });
  handle.permissionMode = "bypassPermissions";
  runtimes.push(handle);
  return handle;
}
async function turn(handle: AgentRuntime) {
  const events = [];
  for await (const event of handle.run("run", {
    onPermissionRequest: () => Promise.resolve("allow"),
  })) {
    events.push(event);
  }
  return events;
}
function target(handle: AgentRuntime): SessionStorageTarget {
  return { cwd: handle.cwd, sessionId: handle.sessionId };
}
function refusesMaintenance(storage: SessionStorageTarget) {
  for (const operation of ["delete", "cleanup"] as const) {
    expect(() => planSessionMaintenance(storage, operation)).toThrow(
      SESSION_LEASE_ACTIVE,
    );
  }
}

beforeEach(() => {
  vi.stubEnv("HOME", dirname(getYukinoDir()));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected provider request");
    }),
  );
});
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(runtimes.splice(0).map((handle) => handle.dispose()));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("owned session execution leases", () => {
  it("creates only a valid empty header before the first lease and never overwrites existing storage", async () => {
    const handle = await runtime();
    const path = getSessionFilePath(handle.cwd, handle.sessionId);
    expect(readSessionDocument(path)).toMatchObject({
      header: { sessionId: "custom-session" },
      records: [],
      revision: 0,
    });
    expect(listSessionRunLeases(target(handle))).toEqual([]);
    const before = readFileSync(path);
    const other = await runtime();
    expect(readFileSync(path)).toEqual(before);
    await other.dispose();
    await turn(handle);
    expect(
      readSessionDocument(path)?.entries.filter(
        (entry) => entry.message.role === "user",
      ),
    ).toHaveLength(1);
    expect(listSessionRunLeases(target(handle))).toEqual([]);
  });

  it.each(["complete", "abort", "dispose", "error"] as const)(
    "protects foreground before the first request and releases on %s",
    async (ending) => {
      const started = gate(),
        finish = gate();
      let calls = 0;
      const handle = await runtime({
        ...reply(),
        async *stream(_conv, _tools, signal) {
          calls++;
          started.resolve();
          await Promise.race([finish.promise, waitForAbort(signal)]);
          if (ending === "error") {
            throw new Error("Provider failed");
          }
          yield {
            type: "stream_end",
            stopReason: "end_turn",
            usage,
            usageComplete: true,
          };
        },
      });
      const pending = turn(handle);
      expect(
        listSessionRunLeases(target(handle)).map((lease) => lease.kind),
      ).toEqual(["foreground"]);
      await started.promise;
      refusesMaintenance(target(handle));
      if (ending === "abort") {
        handle.abortForeground();
      } else if (ending === "dispose") {
        await handle.dispose();
      } else {
        finish.resolve();
      }
      await pending;
      expect(calls).toBe(1);
      expect(listSessionRunLeases(target(handle))).toEqual([]);
    },
  );

  it.each(["missing", "invalid", "symlink", "hardlink"] as const)(
    "denies %s transcripts without issuing requests or recreating storage",
    async (kind) => {
      let calls = 0;
      const handle = await runtime({
        ...reply(),
        async *stream() {
          calls++;
          await Promise.resolve();
          yield { type: "stream_end", stopReason: "end_turn", usage };
        },
      });
      const path = getSessionFilePath(handle.cwd, handle.sessionId);
      const bytes = readFileSync(path);
      unlinkSync(path);
      const source = join(handle.cwd, "source.jsonl");
      writeFileSync(source, bytes);
      if (kind === "invalid") {
        writeFileSync(path, "not a transcript\n");
      }
      if (kind === "symlink") {
        symlinkSync(source, path);
      }
      if (kind === "hardlink") {
        linkSync(source, path);
      }
      await expect(turn(handle)).rejects.toThrow();
      expect(calls).toBe(0);
      if (kind === "missing") {
        expect(existsSync(path)).toBe(false);
      }
      expect(readFileSync(source)).toEqual(bytes);
    },
  );

  it("keeps actual background shells protected after foreground settles and releases only after cancellation", async () => {
    let calls = 0;
    const handle = await runtime({
      ...reply(),
      async *stream() {
        await Promise.resolve();
        if (calls++ === 0) {
          yield {
            type: "tool_call_complete",
            toolId: "shell",
            toolName: "Bash",
            arguments: {
              command: "node -e 'setInterval(() => {}, 1000)'",
              run_in_background: true,
            },
          };
          yield { type: "stream_end", stopReason: "tool_use", usage };
        } else {
          yield { type: "stream_end", stopReason: "end_turn", usage };
        }
      },
    });
    await turn(handle);
    const task = handle.backgroundTaskManager.list()[0];
    expect(task?.kind).toBe("shell");
    expect(
      listSessionRunLeases(target(handle)).map((lease) => lease.kind),
    ).toEqual(["background"]);
    refusesMaintenance(target(handle));
    if (!task) {
      throw new Error("No background shell");
    }
    await handle.backgroundTaskManager.stopAndWait(task.id);
    expect(listSessionRunLeases(target(handle))).toEqual([]);
    expect(calls).toBe(2);
  });

  it("leases TaskManager synchronously and retains protection through cancelled runner cleanup", async () => {
    const handle = await runtime();
    const finish = gate();
    const manager = new TaskManager(handle.sessionId, handle.cwd);
    closers.push(() => manager.stopAll());
    const task = manager.create(
      "cleanup",
      async () => {
        await finish.promise;
        return "done";
      },
      () => undefined,
    );
    refusesMaintenance(target(handle));
    await Promise.resolve();
    manager.stop(task.id);
    refusesMaintenance(target(handle));
    finish.resolve();
    await task.done;
    expect(listSessionRunLeases(target(handle))).toEqual([]);
  });

  it("protects root and actual artifact subagent storage, including independently addressable children", async () => {
    const handle = await runtime();
    const childCwd = project("child-project");
    const child = SessionManager.create(childCwd);
    const started = gate();
    const controller = new AbortController();
    const llm: LLMClient = {
      ...reply(),
      async *stream(_conv, _tools, signal) {
        started.resolve();
        await waitForAbort(signal);
        yield { type: "stream_end", stopReason: "end_turn", usage };
      },
    };
    const pending = spawnSubagent(
      BUILTIN_AGENTS[0],
      "hold",
      llm,
      new ToolRegistry(),
      provider,
      childCwd,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        sessionId: child.id,
        executionContext: handle.executionContext,
        abortSignal: controller.signal,
      },
    );
    const settled = pending.catch(() => undefined);
    await started.promise;
    refusesMaintenance(target(handle));
    refusesMaintenance({ cwd: childCwd, sessionId: child.id });
    expect(
      readSessionDocument(sessionPath(child.id, TRANSCRIPT_FILENAME))?.header
        .sessionId,
    ).toBe("transcript");
    controller.abort();
    await settled;
    expect(listSessionRunLeases(target(handle))).toEqual([]);
    expect(
      listSessionRunLeases({ cwd: childCwd, sessionId: child.id }),
    ).toEqual([]);
  });

  it("keeps descendants of an explicitly ephemeral child in memory under a persistent root", async () => {
    const handle = await runtime();
    const registry = new ToolRegistry();
    const llm: LLMClient = {
      ...reply(),
      async *stream() {
        if (getExecutionContext()?.agentId === "ephemeral-parent") {
          await spawnSubagent(
            BUILTIN_AGENTS[0],
            "nested",
            llm,
            registry,
            provider,
            handle.cwd,
            undefined,
            undefined,
            undefined,
            undefined,
            { sessionId: "ephemeral-child" },
          );
        }
        yield { type: "stream_end", stopReason: "end_turn", usage };
      },
    };
    await spawnSubagent(
      BUILTIN_AGENTS[0],
      "parent",
      llm,
      registry,
      provider,
      handle.cwd,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        sessionId: "ephemeral-parent",
        persist: false,
        executionContext: handle.executionContext,
      },
    );
    expect(existsSync(sessionPath("ephemeral-parent"))).toBe(false);
    expect(existsSync(sessionPath("ephemeral-child"))).toBe(false);
    expect(existsSync(getSessionFilePath(handle.cwd, "ephemeral-child"))).toBe(
      false,
    );
    expect(listSessionRunLeases(target(handle))).toEqual([]);
  });

  it("holds the real root while Workflow's local VM and child request outlive a foreground turn", async () => {
    const started = gate();
    let mainCalls = 0,
      workerCalls = 0;
    const handle = await runtime({
      ...reply(),
      async *stream(conv, _tools, signal) {
        if (conv.getMessages().at(-1)?.content === "hold") {
          workerCalls++;
          started.resolve();
          await waitForAbort(signal);
        } else if (mainCalls++ === 0) {
          yield {
            type: "tool_call_complete",
            toolId: "workflow",
            toolName: "Workflow",
            arguments: {
              script: "return await agent('hold', {allowedTools: []})",
            },
          };
          yield { type: "stream_end", stopReason: "tool_use", usage };
        } else {
          yield { type: "stream_end", stopReason: "end_turn", usage };
        }
      },
    });
    await turn(handle);
    await started.promise;
    const kinds = listSessionRunLeases(target(handle)).map(
      (lease) => lease.kind,
    );
    expect(kinds).toContain("vm");
    expect(kinds).toContain("background");
    expect(kinds).not.toContain("foreground");
    refusesMaintenance(target(handle));
    await handle.dispose();
    expect(listSessionRunLeases(target(handle))).toEqual([]);
    expect(mainCalls).toBe(2);
    expect(workerCalls).toBe(1);
  });

  it("leases CodeMode's real VM between turns and preserves a borrowed tool's unrelated lease", async () => {
    const handle = await runtime();
    await turn(handle);
    const cwd = project("borrowed-project");
    const manager = SessionManager.create(cwd);
    const tool = new CodeModeTool();
    const borrowed = new ToolRegistry();
    borrowed.register(tool);
    const observer = await runtime(reply(), {
      cwd,
      sessionId: manager.id,
      registry: borrowed,
    });
    const started = gate();
    const pending = tool.execute(
      {
        cwd,
        sessionId: manager.id,
        toolCallId: "vm",
        codeMode: {
          stateKey: {},
          sessionId: manager.id,
          transcriptPath: getSessionFilePath(cwd, manager.id),
          tools: () => [
            {
              name: "Gate",
              description: "gate",
              schema: {
                name: "Gate",
                description: "gate",
                input_schema: { type: "object", properties: {} },
              },
            },
          ],
          async *execute(_calls, signal) {
            started.resolve();
            await waitForAbort(signal);
            yield { toolId: "", output: "", isError: false };
          },
        },
      },
      { code: "await tools.Gate({})" },
    );
    closers.push(() => tool.dispose());
    await started.promise;
    expect(
      listSessionRunLeases({ cwd, sessionId: manager.id }).map(
        (lease) => lease.kind,
      ),
    ).toEqual(["vm"]);
    refusesMaintenance({ cwd, sessionId: manager.id });
    await observer.dispose();
    refusesMaintenance({ cwd, sessionId: manager.id });
    await tool.dispose();
    await pending;
    expect(listSessionRunLeases({ cwd, sessionId: manager.id })).toEqual([]);
  });

  it("warms against the controller's real root target, not the hashed cache project, and drains cancellation", async () => {
    const started = gate();
    let mainCalls = 0,
      warmingCalls = 0;
    const handle = await runtime(
      {
        ...reply(),
        supportsCacheWarming: true,
        async *stream(_conv, _tools, signal, options) {
          if (options?.warming) {
            warmingCalls++;
            started.resolve();
            await waitForAbort(signal);
          } else {
            mainCalls++;
            yield {
              type: "stream_end",
              stopReason: "end_turn",
              usage,
              usageComplete: true,
            };
          }
        },
      },
      {
        provider: {
          ...provider,
          warming: {
            mode: "idle",
            frequency_ms: 10,
            max_idle_ms: 10000,
            reuse_probability: 1,
            net_benefit_threshold: 0,
          },
        },
      },
    );
    await turn(handle);
    await started.promise;
    expect(
      listSessionRunLeases(target(handle)).map((lease) => lease.kind),
    ).toEqual(["warming"]);
    refusesMaintenance(target(handle));
    await handle.dispose();
    expect(listSessionRunLeases(target(handle))).toEqual([]);
    expect(mainCalls).toBe(1);
    expect(warmingCalls).toBe(1);
  });

  it("persist:false creates no storage or leases while running foreground, a shell, CodeMode and Workflow", async () => {
    const handle = await runtime(reply(), {
      persist: false,
      codeMode: { mode: "on", inline_budget: 12000 },
    });
    await turn(handle);
    const context = handle.executionContext;
    if (!context) {
      throw new Error("Missing execution context");
    }
    await withExecutionContext(context, async () => {
      const shell = handle.registry.get("Bash");
      if (!shell) {
        throw new Error("Missing shell");
      }
      const result = await shell.execute(
        {
          cwd: handle.cwd,
          sessionId: handle.sessionId,
          taskManager: handle.backgroundTaskManager,
        },
        { command: "printf transient", run_in_background: true },
      );
      expect(result.isError).toBe(false);
      await handle.backgroundTaskManager.waitAll();
      const vm = handle.registry.get("CodeMode");
      if (!vm) {
        throw new Error("Missing CodeMode");
      }
      const outcome = await vm.execute(
        {
          cwd: handle.cwd,
          sessionId: handle.sessionId,
          toolCallId: "transient",
          codeMode: {
            stateKey: {},
            sessionId: handle.sessionId,
            transcriptPath: "",
            tools: () => [],
            async *execute() {},
          },
        },
        { code: "return 1" },
      );
      expect(outcome.isError).toBe(false);
      const workflow = handle.registry.getInstanceOf("Workflow", WorkflowTool);
      if (!workflow) {
        throw new Error("Missing Workflow");
      }
      const launched = await workflow.execute(
        { cwd: handle.cwd, sessionId: handle.sessionId },
        { script: "return 2" },
      );
      expect(launched.isError).toBe(false);
      await handle.backgroundTaskManager.waitAll();
    });
    await handle.dispose();
    expect(existsSync(getYukinoDir())).toBe(false);
  });
});
