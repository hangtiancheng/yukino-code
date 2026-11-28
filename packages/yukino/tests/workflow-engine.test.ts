import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { VM_MAX_JSON_DEPTH, VM_MAX_JSON_NODES } from "@/code-mode/constants.js";
import { CodeModeExecution } from "@/code-mode/execution.js";
import {
  AgentAdapterRegistry,
  type AgentAdapter,
} from "@/workflow/agent-adapter.js";
import { createFileJournalStore } from "@/workflow/journal.js";
import { createHostHandle, type WorkflowPorts } from "@/workflow/ports.js";
import {
  runWorkflow,
  type RunWorkflowOptions,
} from "@/workflow/run-workflow.js";
import type { JournalEntry } from "@/workflow/schema.js";
import { parseScript } from "@/workflow/script.js";
import type { ProgressEvent } from "@/workflow/types.js";
import { assertBoundedWorkflowJson } from "@/workflow/vm.js";

const directories: string[] = [];
const controllers: AbortController[] = [];
const processes: ChildProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    processes.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }),
  );
  for (const controller of controllers.splice(0)) {
    controller.abort();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(run?: AgentAdapter["run"]) {
  const cwd = mkdtempSync(join(tmpdir(), "yukino-workflow-engine-"));
  directories.push(cwd);
  const events: ProgressEvent[] = [];
  const invoke = vi.fn<AgentAdapter["run"]>(
    run ??
      ((params) =>
        Promise.resolve({
          kind: "ok",
          output: params.prompt,
          usage: { outputTokens: 1 },
        })),
  );
  const journalStore = createFileJournalStore(join(cwd, "runs"));
  const ports: WorkflowPorts = {
    agentAdapterRegistry: new AgentAdapterRegistry()
      .register({
        id: "test",
        capabilities: { structuredOutput: true },
        run: invoke,
      })
      .default("test"),
    progressEmitter: {
      emit: (event) => {
        events.push(event);
      },
    },
    journalStore,
    logger: { warn: vi.fn() },
    agentControllers: new Map(),
  };
  const controller = new AbortController();
  controllers.push(controller);
  const execute = (script: string, options: Partial<RunWorkflowOptions> = {}) =>
    runWorkflow({
      script,
      ports,
      runId: "run",
      host: createHostHandle(null),
      signal: controller.signal,
      cwd,
      budgetTotal: null,
      deadline: Date.now() + 6000,
      ...options,
    });
  return { cwd, ports, events, invoke, controller, execute, journalStore };
}

function workflowProcess(cwd: string, phase: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./fixtures/workflow-process.ts", import.meta.url)),
      cwd,
      phase,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  processes.push(child);
  return new Promise<{
    child: ChildProcess;
    message: {
      stage?: string;
      result?: { status: string; error?: string; returnValue?: unknown };
      events?: ProgressEvent[];
      effects?: string;
    };
  }>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += String(data);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal) {
        reject(
          new Error(`Workflow fixture exited ${code}/${signal}: ${stderr}`),
        );
      }
    });
    child.once("message", (raw) => {
      const message = z
        .object({
          stage: z.string().optional(),
          result: z
            .object({
              status: z.string(),
              error: z.string().optional(),
              returnValue: z.unknown().optional(),
            })
            .optional(),
          events: z.array(z.custom<ProgressEvent>()).optional(),
          effects: z.string().optional(),
        })
        .parse(raw);
      resolve({ child, message });
    });
  });
}

describe("workflow execution from the Claude Code script contract", () => {
  it("overlaps pipeline items while preserving stage order and results", async () => {
    const calls: string[] = [];
    const f = fixture(async (params) => {
      calls.push(params.prompt);
      await new Promise((resolve) =>
        setTimeout(resolve, params.prompt === "a" ? 20 : 0),
      );
      return {
        kind: "ok",
        output: params.prompt + "!",
        usage: { outputTokens: 1 },
      };
    });
    const result =
      await f.execute(`export const meta = { name: 'pipeline', description: 'test', phases: [{ title: 'Review' }] }
      phase('Review');
      return await pipeline(['a', 'b'], item => agent(item), previous => agent(previous));`);
    expect(result).toEqual({
      status: "completed",
      returnValue: ["a!!", "b!!"],
    });
    expect(calls.indexOf("b!")).toBeLessThan(calls.indexOf("a!"));
    expect(f.events.at(-2)).toMatchObject({
      type: "phase_done",
      phase: "Review",
    });
    expect(f.events.at(-1)).toMatchObject({
      type: "run_done",
      status: "completed",
    });
  });

  it("limits actual agent execution, including a queue of work", async () => {
    let active = 0;
    let peak = 0;
    const f = fixture(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return { kind: "ok", output: "ok", usage: { outputTokens: 1 } };
    });
    await f.execute(
      "return await parallel(Array.from({length: 12}, (_, i) => () => agent(String(i))))",
      { maxConcurrency: 2 },
    );
    expect(peak).toBe(2);
    expect(f.invoke).toHaveBeenCalledTimes(12);
  });

  it("replays in invocation order when parallel completion order differs", async () => {
    const f = fixture(async (params) => {
      await new Promise((resolve) =>
        setTimeout(resolve, params.prompt === "slow" ? 15 : 0),
      );
      return { kind: "ok", output: params.prompt, usage: { outputTokens: 1 } };
    });
    const script =
      "return await parallel(['slow','fast'].map(item => () => agent(item)))";
    const first = await f.execute(script);
    expect(await f.execute(script, { resume: true })).toEqual(first);
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(
      (await f.journalStore.read("run"))
        .filter((entry) => entry.kind === "outcome")
        .map((entry) => entry.id),
    ).toEqual([2, 1]);
  });

  it("keeps the replayed prefix and source after divergence across repeated resumes", async () => {
    const f = fixture();
    await f.execute("await agent('a'); return await agent('b')");
    const path = join(f.cwd, "runs", "run", "script.js");
    writeFileSync(path, "saved source");
    const edited = "await agent('a'); return await agent('c')";
    expect(await f.execute(edited, { resume: true })).toMatchObject({
      status: "completed",
      returnValue: "c",
    });
    expect(await f.execute(edited, { resume: true })).toMatchObject({
      status: "completed",
      returnValue: "c",
    });
    expect(f.invoke).toHaveBeenCalledTimes(3);
    expect(await readFile(path, "utf8")).toBe("saved source");
    expect(
      (await f.journalStore.read("run")).filter(
        (entry) => entry.kind === "invalidate",
      ),
    ).toHaveLength(1);
  });

  it("returns null on schema mismatch without retrying side-effecting agents", async () => {
    const f = fixture(() =>
      Promise.resolve({
        kind: "ok",
        output: { value: "wrong" },
        usage: { outputTokens: 1 },
      }),
    );
    const result = await f.execute(
      "return await agent('task', { schema: {type: 'object', properties: {value: {type: 'number'}}, required: ['value']} })",
    );
    expect(result).toEqual({ status: "completed", returnValue: null });
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(
      (await f.journalStore.read("run")).find(
        (entry) => entry.kind === "outcome",
      ),
    ).toMatchObject({
      outcome: { ok: true, value: { data: null, budgetSpent: 1 } },
    });
  });

  it("replays recorded failures without automatically repeating side effects", async () => {
    let failing = true;
    const f = fixture(() =>
      Promise.resolve(
        failing
          ? { kind: "dead" }
          : { kind: "ok", output: "fixed", usage: { outputTokens: 1 } },
      ),
    );
    const script = "return await agent('task')";
    expect(await f.execute(script)).toMatchObject({ returnValue: null });
    failing = false;
    expect(await f.execute(script, { resume: true })).toMatchObject({
      returnValue: null,
    });
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps a single-agent cancellation local and releases its permit", async () => {
    const f = fixture(async (params, context) => {
      if (params.prompt === "hold") {
        await new Promise((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => {
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        });
      }
      return { kind: "ok", output: params.prompt, usage: { outputTokens: 1 } };
    });
    const running = f.execute(
      "return await parallel(['hold', 'next'].map(item => () => agent(item)))",
      { maxConcurrency: 1 },
    );
    await vi.waitFor(() => {
      expect(f.ports.agentControllers.has(0)).toBe(true);
    });
    f.ports.agentControllers.get(0)?.abort();
    expect(await running).toEqual({
      status: "completed",
      returnValue: [null, "next"],
    });
    expect(f.controller.signal.aborted).toBe(false);
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(f.ports.agentControllers.size).toBe(0);
  });

  it("drains running work and cancels queued work before returning killed", async () => {
    const f = fixture(async (_params, context) => {
      await new Promise((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => {
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      });
      return { kind: "dead" };
    });
    const running = f.execute(
      "return await parallel([1,2,3,4].map(item => () => agent(String(item))))",
      { maxConcurrency: 1 },
    );
    await vi.waitFor(() => {
      expect(f.invoke).toHaveBeenCalledTimes(1);
    });
    f.controller.abort();
    expect(await running).toEqual({ status: "killed" });
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.ports.agentControllers.size).toBe(0);
  });

  it("enforces the output-token budget after queued calls wake", async () => {
    const f = fixture();
    const result = await f.execute(
      "await agent('a'); return await agent('b')",
      { budgetTotal: 1 },
    );
    expect(result.status).toBe("failed");
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it("composes sibling child workflows without treating siblings as nesting", async () => {
    const f = fixture();
    mkdirSync(join(f.cwd, ".yukino", "workflows"), { recursive: true });
    writeFileSync(
      join(f.cwd, ".yukino", "workflows", "child.js"),
      "return await agent(args)",
    );
    const result = await f.execute(
      "return await parallel([() => workflow('child', 'a'), () => workflow('child', 'b')])",
    );
    expect(result).toEqual({ status: "completed", returnValue: ["a", "b"] });
  });

  it.each(["parent failure", "cleanup persistence failure", "cancellation"])(
    "aborts and drains child work without subsequent effects on %s",
    async (mode) => {
      let childStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        childStarted = resolve;
      });
      let releaseChild!: () => void;
      const drain = new Promise<void>((resolve) => {
        releaseChild = resolve;
      });
      let childSignal: AbortSignal | undefined;
      let childDrained = false;
      const f = fixture(async (params, context) => {
        if (params.prompt === "hold") {
          childSignal = context.signal;
          childStarted();
          await new Promise<void>((resolve) => {
            context.signal.addEventListener(
              "abort",
              () => {
                resolve();
              },
              { once: true },
            );
            if (context.signal.aborted) {
              resolve();
            }
          });
          await drain;
          childDrained = true;
          throw new Error("child cleanup error");
        }
        if (params.prompt === "parent-ready") {
          await started;
        }
        return {
          kind: "ok",
          output: params.prompt,
          usage: { outputTokens: 1 },
        };
      });
      const entries: JournalEntry[] = [];
      f.ports.journalStore = {
        read: () => Promise.resolve([...entries]),
        append(_runId, entry) {
          if (
            mode === "cleanup persistence failure" &&
            ((entry.kind === "outcome" &&
              (entry.scope !== "root" || entry.id === 1)) ||
              (entry.kind === "final" && entry.scope === "root"))
          ) {
            return Promise.reject(new Error("child outcome disk failed"));
          }
          entries.push(structuredClone(entry));
          return Promise.resolve();
        },
      };
      mkdirSync(join(f.cwd, ".yukino", "workflows"), { recursive: true });
      writeFileSync(
        join(f.cwd, ".yukino", "workflows", "child.js"),
        "try { await agent('hold'); } catch {} log('side-effect'); phase('side-effect'); return await agent('side-effect')",
      );
      const source =
        "const child = workflow('child'); await agent('parent-ready'); " +
        (mode === "cancellation"
          ? "return await child"
          : "throw new Error('parent exploded')");
      let settled = false;
      const running = f
        .execute(source, { maxConcurrency: 2 })
        .then((result) => {
          settled = true;
          return result;
        });
      try {
        await started;
        if (mode === "cancellation") {
          f.controller.abort();
        }
        await vi.waitFor(
          () => {
            expect(childSignal?.aborted).toBe(true);
          },
          { timeout: 2000 },
        );
        expect(settled).toBe(false);
        expect(childDrained).toBe(false);
        releaseChild();
        const result = await running;
        expect(result).toMatchObject(
          mode === "cancellation"
            ? { status: "killed" }
            : { status: "failed", error: "Error: parent exploded" },
        );
        expect(childDrained).toBe(true);
        expect(f.ports.agentControllers.size).toBe(0);
        expect(
          f.invoke.mock.calls.map(([params]) => params.prompt).sort(),
        ).toEqual(["hold", "parent-ready"]);
        expect(
          f.events.some(
            (event) =>
              (event.type === "log" && event.message === "side-effect") ||
              (event.type === "phase_started" && event.phase === "side-effect"),
          ),
        ).toBe(false);
        const resumed = await f.execute(source, {
          resume: true,
          maxConcurrency: 2,
        });
        if (mode === "cleanup persistence failure") {
          expect(resumed).toMatchObject({ status: "failed" });
          expect(resumed.error).toContain("started without recorded outcomes");
        } else {
          expect(resumed).toEqual(result);
        }
        expect(f.invoke).toHaveBeenCalledTimes(2);
      } finally {
        f.controller.abort();
        releaseChild();
        await running;
      }
    },
  );

  it("uses VM virtual time and seeded random without host Date/Math proxies", async () => {
    const f = fixture();
    const script = "return [Date.now(), new Date().getTime(), Math.random()]";
    const first = await f.execute(script);
    expect(first.status).toBe("completed");
    expect(await f.execute(script, { resume: true })).toEqual(first);
  });

  it.each([
    "import x from 'x'",
    "await import('node:fs')",
    "export default 1",
    "const x: number = 1",
  ])(
    "rejects unsupported script syntax inside the real worker: %s",
    async (source) => {
      const f = fixture();
      expect((await f.execute(source)).status).toBe("failed");
      expect(f.invoke).not.toHaveBeenCalled();
    },
  );

  it.each([
    "{get name() {while(true) {}}}",
    "{...{name:'bad', description:'bad'}}",
    "{name: `bad`, description: 'bad'}",
    "{name: (() => {while(true) {}})(), description:'bad'}",
    "{name:'bad', description:'bad', constructor: {}}",
  ])("never evaluates dynamic static metadata: %s", async (meta) => {
    expect(() =>
      parseScript(`export const meta = ${meta}; return 1`),
    ).toThrow();
    const f = fixture();
    expect(
      (await f.execute(`export const meta = ${meta}; return 1`)).status,
    ).toBe("failed");
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("accepts JSON aliases but bounds expanded aliases, cycles, depth and accessors", () => {
    const shared = { value: [1, null] };
    expect(() => {
      assertBoundedWorkflowJson({ a: shared, b: shared });
    }).not.toThrow();
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => {
      assertBoundedWorkflowJson(cycle);
    }).toThrow("acyclic");
    let deep: unknown = null;
    for (let i = 0; i <= VM_MAX_JSON_DEPTH; i++) {
      deep = [deep];
    }
    expect(() => {
      assertBoundedWorkflowJson(deep);
    }).toThrow("depth");
    expect(() => {
      assertBoundedWorkflowJson(
        Array.from({ length: VM_MAX_JSON_NODES }, () => shared),
      );
    }).toThrow("node");
    const getter = vi.fn(() => 1);
    expect(() => {
      assertBoundedWorkflowJson(
        Object.defineProperty({}, "value", { enumerable: true, get: getter }),
      );
    }).toThrow("accessors");
    expect(getter).not.toHaveBeenCalled();
    const serializer = vi.fn(() => ({}));
    expect(() => {
      assertBoundedWorkflowJson(
        Object.defineProperty({}, "toJSON", { value: serializer }),
      );
    }).toThrow("serializers");
    expect(serializer).not.toHaveBeenCalled();
  });

  it("persists started before dispatch and the exact outcome clock before guest delivery", async () => {
    const f = fixture();
    let allowStart!: () => void;
    let allowOutcome!: () => void;
    const startGate = new Promise<void>((resolve) => {
      allowStart = resolve;
    });
    const outcomeGate = new Promise<void>((resolve) => {
      allowOutcome = resolve;
    });
    const append = f.journalStore.append.bind(f.journalStore);
    let startSaved = false;
    let recordedNow: number | undefined;
    f.ports.journalStore = {
      ...f.journalStore,
      async append(runId, entry) {
        await append(runId, entry);
        if (entry.kind === "started" && entry.id === 1) {
          startSaved = true;
          await startGate;
        }
        if (entry.kind === "outcome" && entry.id === 1) {
          recordedNow = entry.now;
          await outcomeGate;
        }
      },
    };
    const source =
      "await agent('first'); const now = Date.now(); return {now, next: await agent(String(now))}";
    const running = f.execute(source);
    await vi.waitFor(() => {
      expect(startSaved).toBe(true);
    });
    expect(f.invoke).not.toHaveBeenCalled();
    allowStart();
    await vi.waitFor(() => {
      expect(recordedNow).toBeTypeOf("number");
    });
    expect(f.invoke).toHaveBeenCalledTimes(1);
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 500);
    allowOutcome();
    const first = await running;
    expect(first).toEqual({
      status: "completed",
      returnValue: { now: recordedNow, next: String(recordedNow) },
    });
    const entries = (await f.journalStore.read("run")).filter(
      (entry) => entry.kind !== "final",
    );
    f.ports.journalStore = {
      ...f.journalStore,
      read: () => Promise.resolve(entries),
    };
    expect(await f.execute(source, { resume: true })).toEqual(first);
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });

  it("replays completed notifications without emitting agent, phase, log or run events twice", async () => {
    const f = fixture();
    const source = "phase('Review'); log('once'); return await agent('once')";
    const first = await f.execute(source);
    const events = [...f.events];
    expect(await f.execute(source, { resume: true })).toEqual(first);
    expect(f.events).toEqual(events);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it("retains spend and agent identities from invalidated suffixes across repeated edits", async () => {
    const f = fixture();
    expect(
      (
        await f.execute("await agent('a'); return await agent('b')", {
          budgetTotal: 3,
        })
      ).status,
    ).toBe("completed");
    expect(
      (
        await f.execute("await agent('a'); return await agent('c')", {
          resume: true,
          budgetTotal: 3,
        })
      ).status,
    ).toBe("completed");
    const result = await f.execute(
      "await agent('a'); return await agent('d')",
      { resume: true, budgetTotal: 3 },
    );
    expect(result.status).toBe("failed");
    expect(f.invoke).toHaveBeenCalledTimes(3);
    expect(
      f.events
        .filter((event) => event.type === "agent_started")
        .map((event) => event.agentId),
    ).toEqual([0, 1, 2]);
  });

  it("invalidates removed suffixes and resumes edits interrupted immediately after their header", async () => {
    const f = fixture();
    const old = "await agent('a'); return await agent('b')";
    await f.execute(old);
    const append = f.journalStore.append.bind(f.journalStore);
    f.ports.journalStore = {
      ...f.journalStore,
      async append(runId, entry) {
        await append(runId, entry);
        if (entry.kind === "header") {
          throw new Error("interrupted after header");
        }
      },
    };
    const edited = "await agent('a'); return await agent('c')";
    expect((await f.execute(edited, { resume: true })).status).toBe("failed");
    f.ports.journalStore = f.journalStore;
    expect(await f.execute(edited, { resume: true })).toMatchObject({
      status: "completed",
      returnValue: "c",
    });
    expect(await f.execute("return 'short'", { resume: true })).toEqual({
      status: "completed",
      returnValue: "short",
    });
    expect(await f.execute("return 'short'", { resume: true })).toEqual({
      status: "completed",
      returnValue: "short",
    });
    expect(f.invoke).toHaveBeenCalledTimes(3);
  });

  it("keeps paid dead-agent usage in the workflow budget", async () => {
    const f = fixture(() =>
      Promise.resolve({
        kind: "dead",
        reason: "no-structured-output",
        usage: { outputTokens: 2 },
      }),
    );
    expect(
      (
        await f.execute("await agent('paid'); return await agent('blocked')", {
          budgetTotal: 2,
        })
      ).status,
    ).toBe("failed");
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it("returns a persisted partial prefix and blocks unknown effects after outcome persistence fails", async () => {
    const f = fixture();
    const append = f.journalStore.append.bind(f.journalStore);
    f.ports.journalStore = {
      ...f.journalStore,
      async append(runId, entry) {
        if (entry.kind === "outcome" && entry.id === 2) {
          throw new Error("disk failed");
        }
        await append(runId, entry);
      },
    };
    const source = "await agent('first'); return await agent('second')";
    expect(await f.execute(source)).toMatchObject({
      status: "failed",
      error: "disk failed",
      partial: ["first"],
    });
    f.ports.journalStore = f.journalStore;
    const resumed = await f.execute(source, { resume: true });
    expect(resumed.status).toBe("failed");
    expect(resumed.error).toContain("started without recorded outcomes");
    expect(f.invoke).toHaveBeenCalledTimes(2);
  });

  it("reports final persistence failure with the completed partial prefix", async () => {
    const f = fixture();
    const append = f.journalStore.append.bind(f.journalStore);
    f.ports.journalStore = {
      ...f.journalStore,
      async append(runId, entry) {
        if (entry.kind === "final") {
          throw new Error("final disk failed");
        }
        await append(runId, entry);
      },
    };
    expect(await f.execute("return await agent('done')")).toEqual({
      status: "failed",
      error: "final disk failed",
      partial: ["done"],
    });
    f.ports.journalStore = f.journalStore;
    expect(
      await f.execute("return await agent('done')", { resume: true }),
    ).toEqual({ status: "completed", returnValue: "done" });
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it("drains serial, parallel, pipeline and child Workflow agents running real CodeMode workers", async () => {
    const f = fixture(async (params) => {
      const execution = new CodeModeExecution();
      const result = await execution.execute(
        {
          stateKey: {},
          sessionId: "workflow-test",
          transcriptPath: "",
          tools: () => [],
          async *execute() {
            await Promise.resolve();
            yield* [];
            throw new Error("No nested tools expected");
          },
        },
        params.prompt,
        {
          code: `return ${JSON.stringify(params.prompt)}`,
          timeout_ms: 5000,
          max_output_tokens: 1000,
        },
      );
      if (result.isError) {
        throw new Error(result.output);
      }
      return {
        kind: "ok",
        output: result.structuredContent?.value,
        usage: { outputTokens: 1 },
      };
    });
    mkdirSync(join(f.cwd, ".yukino", "workflows"), { recursive: true });
    writeFileSync(
      join(f.cwd, ".yukino", "workflows", "child.js"),
      "return await pipeline(args, value => agent(value), value => agent(value + '!'))",
    );
    const source =
      "const serial = await agent('serial'); const values = await parallel([() => workflow('child', ['a','b']), () => agent('parallel')]); return {serial,values}";
    expect(await f.execute(source, { deadline: Date.now() + 15_000 })).toEqual({
      status: "completed",
      returnValue: { serial: "serial", values: [["a!", "b!"], "parallel"] },
    });
    expect(f.invoke).toHaveBeenCalledTimes(6);
  });

  it.each(["recorded", "unknown", "lease"])(
    "survives real process interruption at %s without replaying costs or unknown effects",
    async (phase) => {
      const f = fixture();
      writeFileSync(join(f.cwd, "effects.jsonl"), "");
      const first = await workflowProcess(f.cwd, phase);
      expect(first.message.stage).toBe(phase);
      if (phase === "lease") {
        const competitor = await workflowProcess(f.cwd, "resume");
        expect(competitor.message.result?.status).toBe("failed");
        expect(competitor.message.result?.error).toContain("another process");
      }
      const exited = once(first.child, "exit");
      first.child.kill("SIGKILL");
      await exited;
      const resumed = await workflowProcess(f.cwd, "resume");
      if (phase === "unknown") {
        expect(resumed.message.result?.status).toBe("failed");
        expect(resumed.message.result?.error).toContain(
          "started without recorded outcomes",
        );
        expect(resumed.message.effects?.trim().split("\n")).toHaveLength(1);
      } else {
        expect(resumed.message.result).toMatchObject({
          status: "completed",
          returnValue: { a: "a", b: "b", initial: 0, spent: 4 },
        });
        const effects = z
          .string()
          .parse(resumed.message.effects)
          .trim()
          .split("\n")
          .map((line) => {
            const raw: unknown = JSON.parse(line);
            return z
              .object({ key: z.string(), now: z.number().optional() })
              .parse(raw);
          });
        expect(effects.map((item) => item.key)).toEqual(["a", "b"]);
        if (phase === "recorded") {
          const returned = z
            .object({ now: z.number() })
            .parse(resumed.message.result?.returnValue);
          expect(effects[1].now).toBe(returned.now);
          expect(
            resumed.message.events?.some((event) =>
              ["log", "phase_started"].includes(event.type),
            ),
          ).toBe(false);
        }
      }
    },
  );

  it("refuses fresh execution of an existing run ID without retrying its effects", async () => {
    const f = fixture();
    await f.execute("return await agent('once')");
    const result = await f.execute("return await agent('again')");
    expect(result.status).toBe("failed");
    expect(result.error).toContain("resume is required");
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown new journal records before effects", async () => {
    const f = fixture();
    await f.execute("return await agent('once')");
    const path = join(f.cwd, "runs", "run", "journal.jsonl");
    writeFileSync(
      path,
      (await readFile(path, "utf8")) +
        JSON.stringify({ kind: "future", scope: "root" }) +
        "\n",
    );
    expect(
      (await f.execute("return await agent('once')", { resume: true })).status,
    ).toBe("failed");
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects corrupt journals rather than silently repeating side effects", async () => {
    const f = fixture();
    await f.execute("return await agent('task')");
    writeFileSync(join(f.cwd, "runs", "run", "journal.jsonl"), "invalid JSON");
    expect(
      (await f.execute("return await agent('task')", { resume: true })).status,
    ).toBe("failed");
    expect(f.invoke).toHaveBeenCalledTimes(1);
    await expect(access(join(f.cwd, "runs", "run"))).resolves.toBeUndefined();
  });
});
