import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

import PQueue from "p-queue";
import { z } from "zod";

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
  VM_LANE_CAPACITY,
  VM_MAX_PENDING_CALLS,
  VM_MAX_DECLARATION_CHARS,
  VM_MAX_DECLARATIONS,
  VM_MAX_SOURCE_CHARS,
  VM_MAX_JSON_NODES,
  VM_STACK_BYTES,
  VM_JOBS_PER_BATCH,
  CODE_MODE_EXCLUDED_TOOLS,
} from "@/code-mode/constants.js";
import {
  assertBoundedVmJson,
  VmJsonSchema,
  VmJsonObjectSchema,
} from "@/code-mode/schema.js";
import {
  buildCodeModePrelude,
  CODE_MODE_PRELUDE_SOURCE,
  CODE_MODE_SCRIPT_PREFIX,
  CODE_MODE_SCRIPT_SUFFIX,
  type CodeModeVmLimits,
} from "@/code-mode/snippets.js";
import type {
  CodeModeRun,
  CodeModeRunOptions,
  CodeModeStart,
  CodeModeVmResult,
  CodeModeOutcome,
  WorkflowVmStart,
  WorkflowVmOutcome,
  WorkflowVmRun,
  VmRun,
  VmLane,
} from "@/code-mode/types.js";
import {
  normalizeToolResultContentBlock,
  type ToolResultContentBlock,
} from "@/tools/types.js";
import { acquireQueueSlot } from "@/utils/concurrency.js";
import { asErrorString } from "@/utils/format.js";
import { WORKFLOW_BRIDGE_NAMES } from "@/workflow/constants.js";
import {
  buildWorkflowPrelude,
  WORKFLOW_SCRIPT_PREFIX,
  WORKFLOW_SCRIPT_SUFFIX,
} from "@/workflow/snippets.js";

const VM_LIMITS: CodeModeVmLimits = Object.freeze({
  memoryBytes: CODE_MODE_MEMORY_BYTES,
  stackBytes: VM_STACK_BYTES,
  jobsPerBatch: VM_JOBS_PER_BATCH,
  maxPendingCalls: VM_MAX_PENDING_CALLS,
  maxOutputChars: CODE_MODE_MAX_OUTPUT_CHARS,
  maxBridgeChars: CODE_MODE_MAX_OUTPUT_CHARS,
  maxOutputItems: CODE_MODE_MAX_OUTPUT_ITEMS,
  maxStoreChars: CODE_MODE_MAX_STORE_CHARS,
  maxStoreValueChars: CODE_MODE_MAX_STORE_VALUE_CHARS,
  maxCalls: CODE_MODE_MAX_CALLS,
});

export const CODE_MODE_FINGERPRINT = createHash("sha256")
  .update(
    JSON.stringify({
      prelude: CODE_MODE_PRELUDE_SOURCE,
      prefix: CODE_MODE_SCRIPT_PREFIX,
      suffix: CODE_MODE_SCRIPT_SUFFIX,
      quickjsWasi: "3.6.2",
      version: CODE_MODE_VERSION,
      limits: VM_LIMITS,
      timeoutMs: CODE_MODE_TIMEOUT_MS,
      maxWorkers: CODE_MODE_MAX_WORKERS,
      maxOutputTokens: CODE_MODE_MAX_OUTPUT_TOKENS,
      timezoneOffset: 0,
      intrinsics: "ALL & ~WEAK_REF & ~PERFORMANCE",
    }),
  )
  .digest("hex");

const JsonValue = VmJsonSchema;
const JsonObject = VmJsonObjectSchema;
const ContentBlock = z.unknown().transform((value, ctx) => {
  const block = normalizeToolResultContentBlock(value);
  if (!block) {
    ctx.addIssue({
      code: "custom",
      message: "Invalid tool result content block",
    });
    return z.NEVER;
  }
  return block;
});
const Outcome = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    value: z.object({
      output: z.string(),
      contentBlocks: z.array(ContentBlock).optional(),
      structuredContent: JsonValue.optional(),
      rawContent: z.array(JsonValue).optional(),
      artifact: z
        .object({
          id: z.string(),
          path: z.string().optional(),
          mimeType: z.string().optional(),
          size: z.number().nonnegative().optional(),
          hash: z.string().optional(),
        })
        .optional(),
      isError: z.boolean().optional(),
    }),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
const WorkflowOutcome = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    value: z.object({ data: JsonValue, budgetSpent: z.number().nonnegative() }),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    budgetSpent: z.number().nonnegative(),
  }),
]);
const Counter = z.number().int().min(0).max(CODE_MODE_MAX_CALLS);
const During = z.object({ seq: Counter, issued: Counter });
const Message = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("call"),
    id: Counter,
    name: z.string(),
    args: JsonObject,
  }),
  z.object({
    type: z.literal("workflow_call"),
    id: Counter,
    name: z.string(),
    args: JsonObject,
  }),
  z.object({ type: z.literal("output"), block: ContentBlock }),
  z.object({ type: z.literal("idle"), seq: Counter, issued: Counter }),
  z.object({
    type: z.literal("result"),
    ok: z.boolean(),
    value: JsonValue.optional(),
    error: z.string().optional(),
    store: JsonObject.optional(),
    during: During,
  }),
]);

const lanes: Record<VmLane, PQueue> = {
  codemode: new PQueue({ concurrency: VM_LANE_CAPACITY.codemode }),
  workflowRoot: new PQueue({ concurrency: VM_LANE_CAPACITY.workflowRoot }),
  workflowChild: new PQueue({ concurrency: VM_LANE_CAPACITY.workflowChild }),
};

export function startCodeModeRun(
  start: CodeModeStart,
  options: CodeModeRunOptions,
): CodeModeRun {
  return startVmRun<CodeModeOutcome>(start, options, "codemode");
}
export function startWorkflowRun(
  start: WorkflowVmStart,
  options: CodeModeRunOptions,
  depth: number,
): WorkflowVmRun {
  if (depth !== 0 && depth !== 1) {
    throw new Error("Workflow nesting allows only one level");
  }
  return startVmRun<WorkflowVmOutcome>(
    start,
    options,
    depth === 0 ? "workflowRoot" : "workflowChild",
  );
}
function startVmRun<T extends CodeModeOutcome | WorkflowVmOutcome>(
  start: CodeModeStart | WorkflowVmStart,
  options: CodeModeRunOptions,
  lane: VmLane,
): VmRun<T> {
  const isWorkflow = lane !== "codemode";
  const waiting = new AbortController();
  let releaseSlot: (() => void) | undefined;
  const deadline = start.deadline;
  const control = new Int32Array(
    new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT),
  );
  const output: ToolResultContentBlock[] = [];
  const pending = new Set<number>();
  let outputChars = 0;
  let bridgeChars = 0;
  let issued = 0;
  let sentSeq = 0;
  let idleSeq = -1;
  let worker: Worker | undefined;
  let terminal: CodeModeVmResult | undefined;
  let failure: string | undefined;
  let shutdown = false;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let launch: () => void;
  let resolveResult: (result: CodeModeVmResult) => void;
  let resolveClosed: () => void;
  const result = new Promise<CodeModeVmResult>((resolve) => {
    resolveResult = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  function finish(): void {
    if (done) {
      return;
    }
    done = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    pending.clear();
    releaseSlot?.();
    const during = {
      seq: Atomics.load(control, 1),
      issued: Atomics.load(control, 2),
    };
    resolveResult(
      failure !== undefined || shutdown || !terminal
        ? {
            ok: false,
            output,
            error: failure ?? "CodeMode closed",
            during,
            ...(shutdown ? { shutdown: true } : {}),
          }
        : { ...terminal, output },
    );
    resolveClosed();
  }

  function stop(error: string, closing = false): void {
    if (done || failure !== undefined || shutdown) {
      return;
    }
    failure = error;
    shutdown = closing;
    Atomics.store(control, 0, closing ? 2 : 1);
    waiting.abort(new Error(error));
    if (worker) {
      void worker.terminate().catch(() => undefined);
    } else {
      finish();
    }
  }
  function abort(): void {
    stop("CodeMode cancelled");
  }

  const run: VmRun<T> = {
    result,
    deliver(seq, now, id, outcome): void {
      if (done || failure !== undefined || shutdown || terminal) {
        return;
      }
      try {
        if (
          !Number.isSafeInteger(seq) ||
          seq !== sentSeq + 1 ||
          !Number.isFinite(now) ||
          !pending.has(id) ||
          !worker
        ) {
          throw new Error("Invalid CodeMode delivery sequence or call id");
        }
        assertBoundedVmJson(outcome);
        const parsed = isWorkflow
          ? WorkflowOutcome.parse(outcome)
          : Outcome.parse(outcome);
        bridgeChars += JSON.stringify(parsed).length;
        if (bridgeChars > VM_LIMITS.maxBridgeChars) {
          throw new Error("CodeMode tool bridge limit exceeded");
        }
        sentSeq = seq;
        pending.delete(id);
        worker.postMessage({ type: "deliver", seq, now, id, outcome: parsed });
      } catch (error) {
        stop(asErrorString(error));
      }
    },
    close(): Promise<void> {
      stop("CodeMode closed", true);
      return closed;
    },
  };

  let snapshot: CodeModeStart | WorkflowVmStart;
  try {
    snapshot = structuredClone(start);
    if (
      typeof snapshot.code !== "string" ||
      snapshot.code.length > VM_MAX_SOURCE_CHARS ||
      !Number.isFinite(snapshot.startedAt) ||
      !Number.isFinite(snapshot.deadline) ||
      !Number.isSafeInteger(snapshot.seed) ||
      !Number.isSafeInteger(snapshot.maxOutputTokens) ||
      snapshot.maxOutputTokens < 1
    ) {
      throw new Error("Invalid CodeMode start");
    }
    JsonObject.parse(snapshot.store);
    if (
      JSON.stringify(snapshot.store).length > VM_LIMITS.maxStoreChars ||
      Object.values(snapshot.store).some(
        (value) => JSON.stringify(value).length > VM_LIMITS.maxStoreValueChars,
      )
    ) {
      throw new Error("CodeMode store limit exceeded");
    }
    if (
      snapshot.tools.length > VM_MAX_DECLARATIONS ||
      JSON.stringify(snapshot.tools).length > VM_MAX_DECLARATION_CHARS
    ) {
      throw new Error("CodeMode declaration budget exceeded");
    }
    const names = new Set<string>();
    for (const tool of snapshot.tools) {
      if (
        typeof tool.name !== "string" ||
        !tool.name ||
        typeof tool.description !== "string" ||
        names.has(tool.name) ||
        CODE_MODE_EXCLUDED_TOOLS.has(tool.name) ||
        (tool.namespace !== undefined &&
          (typeof tool.namespace !== "string" ||
            !tool.namespace ||
            ["__proto__", "prototype", "constructor"].includes(
              tool.namespace,
            ))) ||
        (tool.source !== undefined &&
          !z
            .object({
              kind: z.string(),
              id: z.string().optional(),
              scope: z.string().optional(),
            })
            .safeParse(tool.source).success) ||
        tool.schema.input_schema.type !== "object"
      ) {
        throw new Error("Invalid or duplicate CodeMode tool declaration");
      }
      names.add(tool.name);
    }
    if (isWorkflow !== "workflow" in snapshot) {
      throw new Error("VM bridge isolation violation");
    }
    if (isWorkflow) {
      if (!("workflow" in snapshot) || snapshot.tools.length) {
        throw new Error("Invalid Workflow VM configuration");
      }
      snapshot.workflow = z
        .strictObject({
          args: JsonValue,
          budgetTotal: z.number().nonnegative().nullable(),
          budgetSpent: z.number().nonnegative(),
          maxItems: z.number().int().positive().max(VM_MAX_JSON_NODES),
        })
        .parse(snapshot.workflow);
      names.clear();
      for (const name of WORKFLOW_BRIDGE_NAMES) {
        names.add(name);
      }
    }
    const prelude =
      "workflow" in snapshot
        ? buildWorkflowPrelude(snapshot)
        : buildCodeModePrelude(snapshot);
    snapshot.deadline = deadline;
    launch = () => {
      if (done || failure !== undefined || shutdown) {
        return;
      }
      if (Date.now() >= deadline) {
        stop("CodeMode deadline exceeded");
        return;
      }
      try {
        worker = new Worker(new URL("./code-mode-worker.js", import.meta.url), {
          workerData: {
            start: snapshot,
            prelude,
            script: isWorkflow
              ? WORKFLOW_SCRIPT_PREFIX + snapshot.code + WORKFLOW_SCRIPT_SUFFIX
              : CODE_MODE_SCRIPT_PREFIX +
                snapshot.code +
                CODE_MODE_SCRIPT_SUFFIX,
            limits: VM_LIMITS,
            control: control.buffer,
          },
          execArgv: [],
        });
        worker.on("message", (raw: unknown) => {
          if (done) {
            return;
          }
          try {
            const message = Message.parse(raw);
            if (message.type === "output") {
              const encoded = JSON.stringify(message.block);
              if (
                output.length >= VM_LIMITS.maxOutputItems ||
                outputChars + encoded.length > VM_LIMITS.maxOutputChars ||
                (message.block.type === "image" &&
                  message.block.source.type !== "base64")
              ) {
                throw new Error(
                  "Invalid CodeMode output or output limit exceeded",
                );
              }
              outputChars += encoded.length;
              output.push(message.block);
              return;
            }
            if (failure !== undefined || shutdown) {
              return;
            }
            if (terminal) {
              throw new Error("CodeMode message after terminal result");
            }
            switch (message.type) {
              case "call":
              case "workflow_call":
                if ((message.type === "workflow_call") !== isWorkflow) {
                  throw new Error("VM bridge isolation violation");
                }
                if (pending.size >= VM_MAX_PENDING_CALLS) {
                  throw new Error("VM pending call limit exceeded");
                }
                bridgeChars += JSON.stringify(message.args).length;
                if (bridgeChars > VM_LIMITS.maxBridgeChars) {
                  throw new Error("CodeMode tool bridge limit exceeded");
                }
                if (message.id !== issued + 1 || !names.has(message.name)) {
                  throw new Error("Invalid CodeMode call");
                }
                issued++;
                pending.add(message.id);
                options.onCall({
                  id: message.id,
                  name: message.name,
                  args: message.args,
                });
                break;
              case "idle":
                if (
                  message.seq !== idleSeq + 1 ||
                  message.seq > sentSeq ||
                  message.issued !== issued
                ) {
                  throw new Error(
                    "Invalid CodeMode idle sequence or issued count",
                  );
                }
                idleSeq = message.seq;
                options.onIdle(message.seq, message.issued);
                break;
              case "result":
                if (
                  message.during.issued !== issued ||
                  message.during.seq > sentSeq ||
                  message.during.seq < Math.max(0, idleSeq) ||
                  (message.ok
                    ? message.store === undefined || message.error !== undefined
                    : message.store !== undefined ||
                      message.error === undefined)
                ) {
                  throw new Error("Invalid CodeMode terminal result");
                }
                if (
                  (message.value !== undefined &&
                    outputChars + JSON.stringify(message.value).length >
                      VM_LIMITS.maxOutputChars) ||
                  (message.error !== undefined &&
                    message.error.length > VM_LIMITS.maxOutputChars)
                ) {
                  throw new Error("CodeMode output limit exceeded");
                }
                if (
                  message.store &&
                  (JSON.stringify(message.store).length >
                    VM_LIMITS.maxStoreChars ||
                    Object.values(message.store).some(
                      (value) =>
                        JSON.stringify(value).length >
                        VM_LIMITS.maxStoreValueChars,
                    ))
                ) {
                  throw new Error("CodeMode store limit exceeded");
                }
                terminal = {
                  ok: message.ok,
                  output,
                  during: message.during,
                  ...(message.value !== undefined
                    ? { value: message.value }
                    : {}),
                  ...(message.error !== undefined
                    ? { error: message.error }
                    : {}),
                  ...(message.store !== undefined
                    ? { store: message.store }
                    : {}),
                };
                clearTimeout(timer);
                void worker?.terminate().catch(() => undefined);
                break;
            }
          } catch (error) {
            stop(asErrorString(error));
          }
        });
        worker.on("error", (error) => {
          stop(asErrorString(error));
        });
        worker.once("exit", (code) => {
          if (!terminal && failure === undefined && !shutdown) {
            failure = `CodeMode worker exited without a result (${code})`;
          }
          finish();
        });
      } catch (error) {
        stop(asErrorString(error));
      }
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
    } else if (deadline <= Date.now()) {
      stop("CodeMode deadline exceeded");
    } else {
      timer = setTimeout(() => {
        stop("CodeMode deadline exceeded");
      }, deadline - Date.now());
      void acquireQueueSlot(lanes[lane], waiting.signal)
        .then((release) => {
          if (done) {
            release();
            return;
          }
          releaseSlot = release;
          launch();
        })
        .catch((error: unknown) => {
          stop(asErrorString(error));
        });
    }
  } catch (error) {
    failure = asErrorString(error);
    finish();
  }
  return run;
}
