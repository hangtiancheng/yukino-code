import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentAdapterRegistry,
  type AgentAdapter,
} from "@yukino.js/workflow/agent-adapter.js";
import { createFileJournalStore } from "@yukino.js/workflow/journal.js";
import {
  createHostHandle,
  type WorkflowPorts,
} from "@yukino.js/workflow/ports.js";
import {
  runWorkflow,
  type RunWorkflowOptions,
} from "@yukino.js/workflow/run-workflow.js";
import { parseScript } from "@yukino.js/workflow/script.js";
import type { ProgressEvent } from "@yukino.js/workflow/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const directories: string[] = [];
afterEach(() => {
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
  const execute = (script: string, options: Partial<RunWorkflowOptions> = {}) =>
    runWorkflow({
      script,
      ports,
      runId: "run",
      host: createHostHandle(null),
      signal: controller.signal,
      cwd,
      budgetTotal: null,
      ...options,
    });
  return { cwd, ports, events, invoke, controller, execute, journalStore };
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
      (await f.journalStore.read("run")).map((entry) => entry.seq),
    ).toEqual([0, 1]);
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
    expect(await f.journalStore.read("run")).toHaveLength(2);
  });

  it("retries failed agents and schema mismatches once, then returns null", async () => {
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
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect((await f.journalStore.read("run"))[0].result).toMatchObject({
      kind: "dead",
      reason: "invalid-structured-output",
    });
  });

  it("reruns failed journal entries rather than caching failure forever", async () => {
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
      returnValue: "fixed",
    });
    expect(f.invoke).toHaveBeenCalledTimes(3);
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
      expect(f.ports.agentControllers.size).toBe(1);
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

  it.each(["Date.now()", "new Date()", "Date()", "Math.random()"])(
    "rejects nondeterminism: %s",
    async (expression) => {
      const f = fixture();
      expect((await f.execute(`return ${expression}`)).status).toBe("failed");
    },
  );

  it.each([
    "import x from 'x'",
    "await import('node:fs')",
    "export default 1",
    "const x: number = 1",
  ])("rejects unsupported script syntax: %s", (source) => {
    expect(() => parseScript(source)).toThrow();
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
