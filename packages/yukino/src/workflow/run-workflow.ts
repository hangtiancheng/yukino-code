import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { acquireSessionRunLease } from "@/session/lease.js";
import { asErrorString } from "@/utils/index.js";
import { YukinoWorkflowHost } from "@/workflow/backend.js";
import { clampMaxConcurrency } from "@/workflow/concurrency.js";
import {
  WORKFLOW_DIR_NAME,
  WORKFLOW_TIMEOUT_MS,
} from "@/workflow/constants.js";
import { createEngineContext, type EngineContext } from "@/workflow/context.js";
import { WorkflowAbortedError, WorkflowError } from "@/workflow/errors.js";
import {
  rebuildWorkflowJournal,
  workflowFingerprint,
} from "@/workflow/journal.js";
import { resolveNamedWorkflow } from "@/workflow/named-workflows.js";
import { containsPath } from "@/workflow/paths.js";
import {
  unwrapHostHandle,
  type HostHandle,
  type WorkflowPorts,
} from "@/workflow/ports.js";
import { parseScript } from "@/workflow/script.js";
import type { WorkflowRunResult } from "@/workflow/types.js";
import { executeWorkflowVm } from "@/workflow/vm.js";

export interface RunWorkflowOptions {
  script: string;
  args?: unknown;
  runId: string;
  workflowName?: string;
  ports: WorkflowPorts;
  host: HostHandle;
  signal: AbortSignal;
  cwd: string;
  budgetTotal: number | null;
  maxConcurrency?: number;
  resume?: boolean;
  deadline?: number;
  startedAt?: number;
  declarationFingerprint?: string;
}
export async function runWorkflow(
  opts: RunWorkflowOptions,
): Promise<WorkflowRunResult> {
  if (opts.signal.aborted) {
    return { status: "killed" };
  }
  const host = unwrapHostHandle(opts.host);
  const target =
    host instanceof YukinoWorkflowHost ? host.storageTarget : undefined;
  const lease = target ? acquireSessionRunLease(target, "vm") : undefined;
  const startedAt = opts.startedAt ?? Date.now();
  const deadline = opts.deadline ?? startedAt + WORKFLOW_TIMEOUT_MS;
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  opts.signal.addEventListener("abort", abort, { once: true });
  if (opts.signal.aborted) {
    controller.abort();
  }
  const timer = setTimeout(
    () => {
      controller.abort(new Error("Workflow whole deadline exceeded"));
    },
    Math.max(0, deadline - Date.now()),
  );
  let context: ReturnType<typeof createEngineContext> | undefined;
  let release: (() => void) | undefined;
  let result: WorkflowRunResult;
  let replayed = false;
  try {
    release = opts.ports.journalStore.acquire?.(opts.runId);
    const parsed = parseScript(opts.script);
    const entries = await opts.ports.journalStore.read(opts.runId);
    if (!opts.resume && entries.length) {
      throw new Error(
        "Workflow run already exists; resume is required and unknown effects will not be retried",
      );
    }
    context = createEngineContext({
      ...opts,
      signal: controller.signal,
      workflowName: opts.workflowName ?? parsed.meta?.name ?? "workflow",
    });
    const ctx = context;
    const states = rebuildWorkflowJournal(entries);
    ctx.resources.agentIdSeq.value = [...states.values()].reduce(
      (count, state) => count + state.agentStarts,
      0,
    );
    for (const entry of entries) {
      if (entry.kind === "outcome") {
        ctx.resources.budget.restoreSpent(
          entry.outcome.ok
            ? entry.outcome.value.budgetSpent
            : entry.outcome.budgetSpent,
        );
      }
    }
    const environment = {
      cwd: await realpath(opts.cwd),
      maxConcurrency: clampMaxConcurrency(opts.maxConcurrency),
      budgetTotal: opts.budgetTotal,
      declarations:
        opts.declarationFingerprint ??
        workflowFingerprint(opts.ports.agentAdapterRegistry.declarations()),
    };
    const execute = async (
      source: string,
      args: unknown,
      scope: string,
      depth: number,
      executionCtx: EngineContext,
    ): Promise<{ result: WorkflowRunResult; replayed: boolean }> =>
      executeWorkflowVm({
        source,
        args: args ?? null,
        ctx: executionCtx,
        entries,
        scope,
        depth,
        startedAt,
        deadline,
        environment,
        async runChild(sub, childScope, childCtx) {
          childCtx.signal.throwIfAborted();
          let source: string;
          if (sub.name) {
            const found = await resolveNamedWorkflow(
              join(opts.cwd, WORKFLOW_DIR_NAME),
              sub.name,
            );
            if (!found) {
              throw new WorkflowError(`Sub-workflow "${sub.name}" not found`);
            }
            source = found.content;
          } else {
            const path = await realpath(
              resolve(opts.cwd, sub.scriptPath ?? ""),
            );
            if (!containsPath(environment.cwd, path)) {
              throw new WorkflowError(
                "Sub-workflow scriptPath is outside the project",
              );
            }
            source = await readFile(path, "utf8");
          }
          const child = await execute(
            source,
            sub.args,
            childScope,
            sub.depth,
            childCtx,
          );
          if (child.result.status !== "completed") {
            throw new WorkflowError(
              child.result.error ?? "Child Workflow cancelled",
            );
          }
          return child.result.returnValue ?? null;
        },
      });
    const output = await execute(opts.script, opts.args, "root", 0, ctx);
    result = output.result;
    replayed = output.replayed;
    if (!replayed && ctx.currentPhase) {
      opts.ports.progressEmitter.emit({
        type: "phase_done",
        runId: opts.runId,
        phase: ctx.currentPhase,
      });
    }
  } catch (error) {
    result =
      error instanceof WorkflowAbortedError ||
      opts.signal.aborted ||
      controller.signal.aborted
        ? { status: "killed" }
        : { status: "failed", error: asErrorString(error) };
    controller.abort();
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (context) {
      await Promise.allSettled(context.inFlight);
    }
    opts.signal.removeEventListener("abort", abort);
    try {
      release?.();
    } finally {
      lease?.release();
    }
  }
  if (!replayed) {
    opts.ports.progressEmitter.emit({
      type: "run_done",
      runId: opts.runId,
      ...result,
    });
  }
  return result;
}
