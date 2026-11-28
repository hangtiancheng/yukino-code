import { createHash } from "node:crypto";
import type * as WorkerThreads from "node:worker_threads";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CODE_MODE_MAX_CALLS,
  CODE_MODE_MAX_OUTPUT_CHARS,
  CODE_MODE_MAX_OUTPUT_ITEMS,
  CODE_MODE_MAX_OUTPUT_TOKENS,
  CODE_MODE_MAX_STORE_CHARS,
  CODE_MODE_MAX_STORE_VALUE_CHARS,
  CODE_MODE_MAX_WORKERS,
  CODE_MODE_MEMORY_BYTES,
  CODE_MODE_TIMEOUT_MS,
  CODE_MODE_VERSION,
  VM_MAX_PENDING_CALLS,
} from "@/code-mode/constants.js";
import {
  CODE_MODE_FINGERPRINT,
  startCodeModeRun,
  startWorkflowRun,
} from "@/code-mode/runtime.js";
import {
  CODE_MODE_PRELUDE_SOURCE,
  CODE_MODE_SCRIPT_PREFIX,
  CODE_MODE_SCRIPT_SUFFIX,
} from "@/code-mode/snippets.js";
import type {
  CodeModeCall,
  CodeModeOutcome,
  CodeModeRun,
  CodeModeRunOptions,
  CodeModeStart,
} from "@/code-mode/types.js";
import type { ToolResultContentBlock } from "@/tools/types.js";

const workers = vi.hoisted((): WorkerThreads.Worker[] => []);
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerThreads>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        workers.push(this);
      }
    },
  };
});

const runs: Pick<CodeModeRun, "close">[] = [];
const declaration = (name: string) => ({
  name,
  description: `Testing ${name}`,
  schema: {
    name,
    description: name,
    input_schema: { type: "object" as const, properties: {} },
  },
});
const success = (output: string): CodeModeOutcome => ({
  ok: true,
  value: { output },
});
function start(
  code: string,
  changes: Partial<CodeModeStart> = {},
  options: Partial<CodeModeRunOptions> = {},
) {
  const calls: CodeModeCall[] = [];
  const idles: { seq: number; issued: number }[] = [];
  let firstIdle: () => void;
  const idle = new Promise<void>((resolve) => {
    firstIdle = resolve;
  });
  const run = startCodeModeRun(
    {
      code,
      tools: [declaration("Echo")],
      store: {},
      seed: 42,
      startedAt: 1700000000000,
      deadline: Date.now() + 10_000,
      maxOutputTokens: 10_000,
      ...changes,
    },
    {
      signal: options.signal,
      onCall(call) {
        calls.push(call);
        options.onCall?.(call);
      },
      onIdle(seq, issued) {
        idles.push({ seq, issued });
        firstIdle();
        options.onIdle?.(seq, issued);
      },
    },
  );
  runs.push(run);
  return { run, calls, idles, idle };
}
afterEach(async () => {
  await Promise.all(runs.splice(0).map((run) => run.close()));
  workers.splice(0);
});

const image: ToolResultContentBlock = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
};

describe("CodeMode QuickJS worker", () => {
  it("fingerprints the prelude, pinned engine, version and execution limits", () => {
    expect(CODE_MODE_FINGERPRINT).toBe(
      createHash("sha256")
        .update(
          JSON.stringify({
            prelude: CODE_MODE_PRELUDE_SOURCE,
            prefix: CODE_MODE_SCRIPT_PREFIX,
            suffix: CODE_MODE_SCRIPT_SUFFIX,
            quickjsWasi: "3.6.2",
            version: CODE_MODE_VERSION,
            limits: {
              memoryBytes: CODE_MODE_MEMORY_BYTES,
              stackBytes: 256 * 1024,
              jobsPerBatch: 50,
              maxPendingCalls: VM_MAX_PENDING_CALLS,
              maxOutputChars: CODE_MODE_MAX_OUTPUT_CHARS,
              maxBridgeChars: CODE_MODE_MAX_OUTPUT_CHARS,
              maxOutputItems: CODE_MODE_MAX_OUTPUT_ITEMS,
              maxStoreChars: CODE_MODE_MAX_STORE_CHARS,
              maxStoreValueChars: CODE_MODE_MAX_STORE_VALUE_CHARS,
              maxCalls: CODE_MODE_MAX_CALLS,
            },
            timeoutMs: CODE_MODE_TIMEOUT_MS,
            maxWorkers: CODE_MODE_MAX_WORKERS,
            maxOutputTokens: CODE_MODE_MAX_OUTPUT_TOKENS,
            timezoneOffset: 0,
            intrinsics: "ALL & ~WEAK_REF & ~PERFORMANCE",
          }),
        )
        .digest("hex"),
    );
  });

  it("bounds aggregate tool arguments and rejects oversized host results", async () => {
    const many = start(
      'const chunk = "x".repeat(1024*1024); for(let i=0;i<32;i++) tools.Echo({chunk}); await new Promise(()=>{});',
    );
    const result = await many.run.result;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("bridge limit");
    const huge = start("return await tools.Echo({});");
    await huge.idle;
    huge.run.deliver(
      1,
      Date.now(),
      1,
      success("x".repeat(CODE_MODE_MAX_OUTPUT_CHARS)),
    );
    expect((await huge.run.result).error).toContain("limit exceeded");
  });

  it("returns synchronously and records pure top-level values without duplicate text or idle", async () => {
    const { run, idles } = start('text("explicit"); return { answer: 42 };');
    expect(run.result).toBeInstanceOf(Promise);
    expect(typeof run.deliver).toBe("function");
    expect(await run.result).toEqual({
      ok: true,
      output: [{ type: "text", text: "explicit" }],
      value: { answer: 42 },
      store: {},
      during: { seq: 0, issued: 0 },
    });
    expect(idles).toEqual([]);
    expect(await start("return undefined;").run.result).toMatchObject({
      ok: true,
      output: [],
    });
  });

  it("drains initial microtasks before idle and delivers parallel awaited calls in strict phases", async () => {
    const { run, calls, idles, idle } = start(`
      await Promise.resolve();
      const [a, b] = await Promise.all([tools.Echo({ n: 1 }), tools.Echo({ n: 2 })]);
      text(a.output + b.output);
      return [a.output, b.output];
    `);
    await idle;
    expect(calls).toEqual([
      { id: 1, name: "Echo", args: { n: 1 } },
      { id: 2, name: "Echo", args: { n: 2 } },
    ]);
    expect(idles).toEqual([{ seq: 0, issued: 2 }]);
    run.deliver(1, 1700000000100, 2, success("B"));
    run.deliver(2, 1700000000200, 1, success("A"));
    expect(await run.result).toEqual({
      ok: true,
      output: [{ type: "text", text: "AB" }],
      value: ["A", "B"],
      store: {},
      during: { seq: 2, issued: 2 },
    });
    expect(idles).toEqual([
      { seq: 0, issued: 2 },
      { seq: 1, issued: 2 },
    ]);
  });

  it("tracks newly issued calls and final during without a terminal idle", async () => {
    const test = start(
      'await tools.Echo({}); await tools.Echo({ next: true }); return "done";',
      {},
      {
        onIdle(seq) {
          test.run.deliver(
            seq + 1,
            1700000000000 + seq,
            seq + 1,
            success("ok"),
          );
        },
      },
    );
    const run = test.run;
    expect(await run.result).toMatchObject({
      ok: true,
      value: "done",
      during: { seq: 2, issued: 2 },
    });
    expect(test.idles).toEqual([
      { seq: 0, issued: 1 },
      { seq: 1, issued: 2 },
    ]);
  });

  it("rejects tool failures as guest Error objects that can be caught", async () => {
    const { run, calls, idle } = start(
      'text("before"); try { await tools.Echo({}); } catch (e) { text(e.message); return e instanceof Error; }',
    );
    await idle;
    run.deliver(1, 1700000000001, calls[0].id, { ok: false, error: "denied" });
    expect(await run.result).toMatchObject({
      ok: true,
      value: true,
      output: [
        { type: "text", text: "before" },
        { type: "text", text: "denied" },
      ],
      during: { seq: 1, issued: 1 },
    });
  });

  it("preserves partial output on failure and never commits staged store", async () => {
    const initial = { retained: { n: 1 } };
    const { run, idle } = start(
      'text("before"); store("changed", 2); await tools.Echo({});',
      { store: initial },
    );
    await idle;
    run.deliver(1, 1700000000001, 1, { ok: false, error: "failed" });
    const result = await run.result;
    expect(result).toMatchObject({
      ok: false,
      error: "Error: failed",
      output: [{ type: "text", text: "before" }],
      during: { seq: 1, issued: 1 },
    });
    expect(result).not.toHaveProperty("store");
    expect(initial).toEqual({ retained: { n: 1 } });
  });

  it("isolates load values, commits JSON store, and deletes undefined including prototype-like keys", async () => {
    const { run } = start(
      `
      const value = load("old"); value.n = 99;
      text(load("old")); store("old", undefined);
      store("new", [1, null]); store("__proto__", { safe: true });
      return [load("old") === undefined, load("missing") === undefined, load("__proto__")];
    `,
      { store: { old: { n: 1 } } },
    );
    const result = await run.result;
    expect(result).toMatchObject({
      ok: true,
      value: [true, true, { safe: true }],
      output: [{ type: "text", text: '{"n":1}' }],
    });
    expect(Object.keys(result.store ?? {})).toEqual(["new", "__proto__"]);
    expect(result.store?.new).toEqual([1, null]);
  });

  it("passes existing base64 images and validates other existing tool content blocks at the host boundary", async () => {
    const { run, idle } = start(
      "const r = await tools.Echo({}); image(r.contentBlocks[0]); return r.contentBlocks[1];",
    );
    await idle;
    run.deliver(1, 1700000000010, 1, {
      ok: true,
      value: {
        output: "",
        contentBlocks: [
          image,
          {
            type: "search_result",
            source: "local",
            title: "result",
            content: [{ type: "text", text: "found" }],
          },
        ],
      },
    });
    expect(await run.result).toMatchObject({
      ok: true,
      output: [image],
      value: {
        type: "search_result",
        source: "local",
        title: "result",
        content: [{ type: "text", text: "found" }],
      },
    });
  });

  it("rejects image URLs without external access", async () => {
    const result = await start(
      'text("kept"); image({ type: "image", source: { type: "url", url: "https://example.com/a.png" } });',
    ).run.result;
    expect(result).toMatchObject({
      ok: false,
      output: [{ type: "text", text: "kept" }],
    });
    expect(result.error).toContain("Invalid image content block");
  });

  it("exposes only sandbox APIs, rejects dynamic import, and prevents constructor escapes", async () => {
    const result = await start(`
      const names = ["process", "require", "Buffer", "fetch", "setTimeout", "queueMicrotask", "WeakRef", "FinalizationRegistry", "performance", "WebAssembly", "std", "os", "crypto"];
      const types = names.map(name => typeof globalThis[name]);
      let rejected = 0;
      for (const path of ["node:fs", "https://example.com/script.js", "./runtime.ts"]) {
        try { await import(path); } catch { rejected++; }
      }
      return { types, rejected, escaped: text.constructor("return typeof process")(), dateConstructor: Date.prototype.constructor === Date };
    `).run.result;
    expect(result).toMatchObject({
      ok: true,
      value: {
        types: Array.from({ length: 13 }, () => "undefined"),
        rejected: 3,
        escaped: "undefined",
        dateConstructor: true,
      },
    });
  });

  it("supports original tool names, declarations and stable search order with plain JSON arguments", async () => {
    const { run, calls, idle } = start(
      `
      text(ALL_TOOLS.map(t => t.name));
      text(searchTools("Echo", { limit: 2 }));
      text(describeTool("mcp__test.Echo").schema.input_schema.type);
      return await tools["mcp__test.Echo"](Object.assign(Object.create(null), { safe: 1 }));
    `,
      { tools: [declaration("mcp__test.Echo"), declaration("Echo")] },
    );
    await idle;
    expect(calls).toEqual([
      { id: 1, name: "mcp__test.Echo", args: { safe: 1 } },
    ]);
    run.deliver(1, 1700000000000, 1, success("ok"));
    expect(await run.result).toMatchObject({
      ok: true,
      value: { output: "ok" },
    });
    const invalid = start(
      "try { tools.Echo([]); } catch(e) { text(e.message); } try { tools.Echo({ toJSON() { return []; } }); } catch(e) { text(e.message); } return 1;",
    );
    expect(await invalid.run.result).toMatchObject({ ok: true, value: 1 });
    expect(invalid.calls).toEqual([]);
  });

  it("replays all Date forms and random values exactly, advancing virtual time without moving backward", async () => {
    const code = `
      const snapshot = () => [Date(), new Date().getTime(), Date.now(), new Date().getTimezoneOffset(), new Date.prototype.constructor().getTime(), Reflect.construct(Date, []).getTime(), Math.random(), Math.random()];
      const values = [snapshot()]; await tools.Echo({}); values.push(snapshot());
      await tools.Echo({}); values.push(snapshot()); return values;
    `;
    const replay = async (seed = 42) => {
      const run: CodeModeRun = start(
        code,
        { seed },
        {
          onIdle(seq) {
            run.deliver(
              seq + 1,
              seq === 0 ? 1700000001000 : 1699999999999,
              seq + 1,
              success("ok"),
            );
          },
        },
      ).run;
      return run.result;
    };
    const first = await replay();
    expect(await replay()).toEqual(first);
    expect(await replay(43)).not.toEqual(first);
    expect(first).toMatchObject({ ok: true });
    expect(first.value).toEqual([
      [
        expect.any(String),
        1700000000000,
        1700000000000,
        0,
        1700000000000,
        1700000000000,
        expect.any(Number),
        expect.any(Number),
      ],
      [
        expect.any(String),
        1700000001000,
        1700000001000,
        0,
        1700000001000,
        1700000001000,
        expect.any(Number),
        expect.any(Number),
      ],
      [
        expect.any(String),
        1700000001000,
        1700000001000,
        0,
        1700000001000,
        1700000001000,
        expect.any(Number),
        expect.any(Number),
      ],
    ]);
    const dates = await start(
      'return [Date.now(), new Date(0).getTime(), Date.parse("1970-01-01T00:00:00Z"), Date.UTC(1970,0,1), new Date().getTimezoneOffset()];',
    ).run.result;
    expect(dates.value).toEqual([1700000000000, 0, 0, 0, 0]);
  });

  it.each([
    'text("partial"); while (true) {}',
    'text("partial"); const loop = () => Promise.resolve().then(loop); await loop();',
  ])(
    "bounds CPU and endless microtasks by absolute deadline: %s",
    async (code) => {
      const began = Date.now();
      const { run } = start(code, { deadline: Date.now() + 700 });
      const result = await run.result;
      expect(result).toMatchObject({
        ok: false,
        output: [{ type: "text", text: "partial" }],
      });
      expect(result.error).toContain("deadline");
      expect(result.shutdown).toBeUndefined();
      expect(Date.now() - began).toBeLessThan(3000);
      expect(await start("return 7;").run.result).toMatchObject({
        ok: true,
        value: 7,
      });
    },
  );

  it("fails immediately on a stalled promise once no tool is pending", async () => {
    const first = await start('text("stalled"); await new Promise(() => {});')
      .run.result;
    expect(first).toMatchObject({
      ok: false,
      output: [{ type: "text", text: "stalled" }],
    });
    expect(first.error).toContain("stalled");
    const { run, idle } = start(
      "await tools.Echo({}); await new Promise(() => {});",
    );
    await idle;
    run.deliver(1, 1700000000001, 1, success("ok"));
    expect(await run.result).toMatchObject({
      ok: false,
      during: { seq: 1, issued: 1 },
    });
  });

  it.each([
    'text("kept"); text("x".repeat(16 * 1024 * 1024));',
    'text("kept"); return "x".repeat(16 * 1024 * 1024);',
    'text("kept"); for(let i=0;i<100000;i++) text("");',
    'text("kept"); store("huge", "x".repeat(256 * 1024));',
    'text("kept"); for(let i=0;i<5;i++) store("v"+i, "x".repeat(250 * 1024));',
    'text("kept"); for(let i=0;i<1001;i++) tools.Echo({});',
  ])(
    "enforces output, store and call caps even if guest catches failures: %s",
    async (code) => {
      const result = await start(`try { ${code} } catch {} return 1;`).run
        .result;
      expect(result.ok).toBe(false);
      expect(result.output[0]).toEqual({ type: "text", text: "kept" });
      expect(result.error).toContain("limit exceeded");
      expect(result.store).toBeUndefined();
    },
  );

  it("bounds memory and recursive stacks without killing the host", async () => {
    const memory = await start(
      'text("kept"); return new ArrayBuffer(300 * 1024 * 1024);',
    ).run.result;
    expect(memory).toMatchObject({
      ok: false,
      output: [{ type: "text", text: "kept" }],
    });
    const stack = await start(
      "function recurse() { return 1 + recurse(); } return recurse();",
    ).run.result;
    expect(stack.ok).toBe(false);
    expect(await start("return 3;").run.result).toMatchObject({
      ok: true,
      value: 3,
    });
  });

  it.each([0, 2])(
    "rejects non-incrementing delivery sequence %s",
    async (seq) => {
      const { run, idle } = start('text("kept"); await tools.Echo({});');
      await idle;
      run.deliver(seq, 1700000000000, 1, success("bad"));
      expect(await run.result).toMatchObject({
        ok: false,
        error: "Invalid CodeMode delivery sequence or call id",
        output: [{ type: "text", text: "kept" }],
      });
    },
  );

  it("rejects duplicate deliveries and malformed host content blocks", async () => {
    const duplicate = start(
      "await Promise.all([tools.Echo({}), tools.Echo({})]);",
    );
    await duplicate.idle;
    duplicate.run.deliver(1, 1700000000000, 1, success("ok"));
    duplicate.run.deliver(2, 1700000000000, 1, success("again"));
    expect((await duplicate.run.result).ok).toBe(false);
    const malformed = start("await tools.Echo({});");
    await malformed.idle;
    const broken: ToolResultContentBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "ok" },
    };
    Object.defineProperty(broken, "source", {
      value: { type: "base64", data: 1 },
    });
    malformed.run.deliver(1, 1700000000000, 1, {
      ok: true,
      value: { output: "", contentBlocks: [broken] },
    });
    expect((await malformed.run.result).ok).toBe(false);
  });

  it("turns callback errors into ordinary terminal errors and reaps the worker", async () => {
    const result = await start(
      "await tools.Echo({});",
      {},
      {
        onCall() {
          throw new Error("host failed");
        },
      },
    ).run.result;
    expect(result).toMatchObject({
      ok: false,
      error: "host failed",
      during: { seq: 0, issued: 1 },
    });
    expect(await start("return 9;").run.result).toMatchObject({
      ok: true,
      value: 9,
    });
  });

  it("aborts active runs with partial output and close uses shutdown without committing store", async () => {
    const controller = new AbortController();
    const active = start(
      'text("kept"); store("staged", 1); await tools.Echo({});',
      {},
      { signal: controller.signal },
    );
    await active.idle;
    controller.abort();
    const aborted = await active.run.result;
    expect(aborted).toMatchObject({
      ok: false,
      error: "CodeMode cancelled",
      output: [{ type: "text", text: "kept" }],
      during: { seq: 0, issued: 1 },
    });
    expect(aborted).not.toHaveProperty("shutdown");
    expect(aborted).not.toHaveProperty("store");
    const closing = start('text("kept"); await tools.Echo({});');
    await closing.idle;
    const closed = closing.run.close();
    await closed;
    expect(await closing.run.result).toMatchObject({
      ok: false,
      shutdown: true,
      output: [{ type: "text", text: "kept" }],
    });
    expect(closing.run.close()).toBe(closed);
    closing.run.deliver(1, 1700000000000, 1, success("late"));
  });

  it.each(["abort", "close"])(
    "interrupts running guest CPU via %s and preserves the actual delivery phase",
    async (mode) => {
      const controller = new AbortController();
      const test = start(
        'await tools.Echo({}); text("delivered"); tools.Echo({}); while(true) {}',
        {},
        {
          signal: controller.signal,
          onIdle(seq) {
            test.run.deliver(seq + 1, 1700000000001, 1, success("ok"));
          },
          onCall(call) {
            if (call.id === 2) {
              if (mode === "abort") {
                controller.abort();
              } else {
                void test.run.close();
              }
            }
          },
        },
      );
      const result = await test.run.result;
      expect(result).toMatchObject({
        ok: false,
        output: [{ type: "text", text: "delivered" }],
        during: { seq: 1, issued: 2 },
      });
      expect(result.shutdown).toBe(mode === "close" ? true : undefined);
      expect(test.idles).toEqual([{ seq: 0, issued: 1 }]);
    },
  );

  it("shares exactly two slots, counts queued deadline, removes queued abort/close, and releases on actual exit", async () => {
    const a = start("await tools.Echo({});");
    const b = start("await tools.Echo({});");
    await Promise.all([a.idle, b.idle]);
    const controller = new AbortController();
    const queuedAbort = start(
      "tools.Echo({});",
      {},
      { signal: controller.signal },
    );
    const queuedClose = start("tools.Echo({});");
    const queuedDeadline = start("tools.Echo({});", {
      deadline: Date.now() + 80,
    });
    const next = start('return "next";');
    controller.abort();
    await queuedClose.run.close();
    expect(await queuedAbort.run.result).toMatchObject({
      ok: false,
      error: "CodeMode cancelled",
      during: { seq: 0, issued: 0 },
    });
    expect(await queuedClose.run.result).toMatchObject({
      shutdown: true,
      during: { seq: 0, issued: 0 },
    });
    expect(await queuedDeadline.run.result).toMatchObject({
      ok: false,
      error: "CodeMode deadline exceeded",
      during: { seq: 0, issued: 0 },
    });
    expect([
      ...queuedAbort.calls,
      ...queuedClose.calls,
      ...queuedDeadline.calls,
    ]).toEqual([]);
    await a.run.close();
    expect(await next.run.result).toMatchObject({ ok: true, value: "next" });
    b.run.deliver(1, 1700000000000, 1, success("done"));
    expect((await b.run.result).ok).toBe(true);
    const exiting = await start(
      'text("last"); store("saved", 1); tools.Echo({}); try { exit(); } catch {} while(true) {}',
    ).run.result;
    expect(exiting).toMatchObject({
      ok: true,
      output: [{ type: "text", text: "last" }],
      store: { saved: 1 },
      during: { seq: 0, issued: 1 },
    });
    expect(await start("return 10;").run.result).toMatchObject({
      ok: true,
      value: 10,
    });
  });

  it("preserves structured, raw, artifact and namespaced declarations through the real VM", async () => {
    const shared = { answer: 42 };
    const test = start(
      "const r = await namespaces.local.Echo({}); return {r, declarations: searchTools('', {namespace:'local',source:'native'})};",
      {
        tools: [
          {
            ...declaration("Echo"),
            namespace: "local",
            source: { kind: "native", id: "echo" },
          },
        ],
      },
    );
    await test.idle;
    test.run.deliver(1, 1700000000001, 1, {
      ok: true,
      value: {
        output: "ok",
        isError: false,
        structuredContent: { a: shared, b: shared },
        rawContent: [{ type: "text", text: "raw" }],
        artifact: {
          id: "asset",
          path: "/tmp/asset",
          mimeType: "application/json",
          size: 10,
          hash: "hash",
        },
      },
    });
    expect(await test.run.result).toMatchObject({
      ok: true,
      value: {
        r: {
          structuredContent: { a: { answer: 42 }, b: { answer: 42 } },
          rawContent: [{ type: "text", text: "raw" }],
          artifact: { id: "asset", hash: "hash" },
        },
        declarations: [
          { name: "Echo", namespace: "local", source: { kind: "native" } },
        ],
      },
    });
  });

  it("rejects cyclic and excessively deep host results before delivery", async () => {
    for (const kind of ["cycle", "depth"]) {
      const test = start("return await tools.Echo({});");
      await test.idle;
      let value: unknown = null;
      if (kind === "cycle") {
        const cycle: unknown[] = [];
        cycle.push(cycle);
        value = cycle;
      } else {
        for (let i = 0; i < 40; i++) {
          value = [value];
        }
      }
      test.run.deliver(1, 1700000000001, 1, {
        ok: true,
        value: { output: "", structuredContent: value },
      });
      expect(await test.run.result).toMatchObject({
        ok: false,
        during: { seq: 0, issued: 1 },
      });
    }
    expect((await start("return 1").run.result).ok).toBe(true);
  });

  it("releases the occupied slot after an unexpected real worker exit", async () => {
    const first = start("await tools.Echo({});");
    const second = start("await tools.Echo({});");
    await Promise.all([first.idle, second.idle]);
    const queued = start("return 'released'");
    await workers[0].terminate();
    const failed = await first.run.result;
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("exited without a result");
    expect(await queued.run.result).toMatchObject({
      ok: true,
      value: "released",
    });
  });

  it.each([0, 1])(
    "cancels waiting Workflow lane %s, counts its deadline and keeps other lanes independent",
    async (depth) => {
      const workflow = (
        code: string,
        signal?: AbortSignal,
        deadline = Date.now() + 5000,
      ) => {
        let ready!: () => void;
        const idle = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const calls: CodeModeCall[] = [];
        const run = startWorkflowRun(
          {
            code,
            tools: [],
            store: {},
            seed: 0,
            startedAt: Date.now(),
            deadline,
            maxOutputTokens: 1000,
            workflow: {
              args: null,
              budgetTotal: null,
              budgetSpent: 0,
              maxItems: 10,
            },
          },
          {
            signal,
            onCall: (call) => {
              calls.push(call);
            },
            onIdle: () => {
              ready();
            },
          },
          depth,
        );
        runs.push(run);
        return { run, idle, calls };
      };
      const held = workflow("await agent('hold')");
      await held.idle;
      const controller = new AbortController();
      const abort = workflow("await agent('queued')", controller.signal);
      const expired = workflow(
        "await agent('expired')",
        undefined,
        Date.now() + 60,
      );
      const next = workflow("return 'next'");
      controller.abort();
      expect(await abort.run.result).toMatchObject({
        ok: false,
        during: { seq: 0, issued: 0 },
      });
      const timedOut = await expired.run.result;
      expect(timedOut).toMatchObject({
        ok: false,
        during: { seq: 0, issued: 0 },
      });
      expect(timedOut.error).toContain("deadline");
      expect([...abort.calls, ...expired.calls]).toEqual([]);
      expect(await start("return 'codemode'").run.result).toMatchObject({
        ok: true,
        value: "codemode",
      });
      const other = startWorkflowRun(
        {
          code: "return 'other'",
          tools: [],
          store: {},
          seed: 0,
          startedAt: Date.now(),
          deadline: Date.now() + 5000,
          maxOutputTokens: 1000,
          workflow: {
            args: null,
            budgetTotal: null,
            budgetSpent: 0,
            maxItems: 10,
          },
        },
        { onCall() {}, onIdle() {} },
        depth === 0 ? 1 : 0,
      );
      runs.push(other);
      expect(await other.result).toMatchObject({ ok: true, value: "other" });
      await held.run.close();
      expect(await next.run.result).toMatchObject({ ok: true, value: "next" });
    },
  );

  it("rejects an already aborted or expired run without starting a worker", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = start(
      "tools.Echo({});",
      {},
      { signal: controller.signal },
    );
    expect(await cancelled.run.result).toMatchObject({
      ok: false,
      error: "CodeMode cancelled",
      during: { seq: 0, issued: 0 },
    });
    const expired = start("tools.Echo({});", { deadline: Date.now() - 1 });
    expect(await expired.run.result).toMatchObject({
      ok: false,
      error: "CodeMode deadline exceeded",
    });
    expect([...cancelled.calls, ...expired.calls]).toEqual([]);
  });
});
