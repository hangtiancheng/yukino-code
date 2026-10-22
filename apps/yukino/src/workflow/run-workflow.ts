import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { asErrorString } from "@/utils/index.js";
import { WORKFLOW_DIR_NAME } from "@/workflow/constants.js";
import { createEngineContext } from "@/workflow/context.js";
import { WorkflowAbortedError, WorkflowError } from "@/workflow/errors.js";
import { makeHooks, type SubWorkflowRunner } from "@/workflow/hooks.js";
import { resolveNamedWorkflow } from "@/workflow/named-workflows.js";
import { containsPath } from "@/workflow/paths.js";
import type { HostHandle, WorkflowPorts } from "@/workflow/ports.js";
import { parseScript } from "@/workflow/script.js";
import type { WorkflowRunResult } from "@/workflow/types.js";

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
}

export async function runWorkflow(
  opts: RunWorkflowOptions,
): Promise<WorkflowRunResult> {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  opts.signal.addEventListener("abort", abort, { once: true });
  if (opts.signal.aborted) {
    controller.abort();
  }
  let context: ReturnType<typeof createEngineContext> | undefined;
  let result: WorkflowRunResult;
  try {
    const parsed = parseScript(opts.script);
    context = createEngineContext({
      ...opts,
      signal: controller.signal,
      workflowName: opts.workflowName ?? parsed.meta?.name ?? "workflow",
      journal: opts.resume
        ? await opts.ports.journalStore.read(opts.runId)
        : [],
    });
    const ctx = context;
    opts.ports.progressEmitter.emit({
      type: "run_started",
      runId: opts.runId,
      workflowName: ctx.workflowName,
      meta: parsed.meta,
    });
    if (ctx.signal.aborted) {
      throw new WorkflowAbortedError();
    }
    const runSubWorkflow: SubWorkflowRunner = async (sub) => {
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
        const path = await realpath(resolve(opts.cwd, sub.scriptPath ?? ""));
        if (!containsPath(await realpath(opts.cwd), path)) {
          throw new WorkflowError(
            "Sub-workflow scriptPath is outside the project",
          );
        }
        source = await readFile(path, "utf8");
      }
      return parseScript(source).execute(
        makeHooks(ctx, runSubWorkflow, sub.depth),
        sub.args,
        ctx.resources.budget,
      );
    };
    const returnValue = await parsed.execute(
      makeHooks(ctx, runSubWorkflow),
      opts.args,
      ctx.resources.budget,
    );
    await Promise.all(ctx.inFlight);
    if (ctx.signal.aborted) {
      throw new WorkflowAbortedError();
    }
    result = { status: "completed", returnValue };
  } catch (error) {
    result =
      error instanceof WorkflowAbortedError || opts.signal.aborted
        ? { status: "killed" }
        : { status: "failed", error: asErrorString(error) };
    controller.abort();
    if (context) {
      await Promise.allSettled(context.inFlight);
    }
  } finally {
    opts.signal.removeEventListener("abort", abort);
  }
  if (context?.currentPhase) {
    opts.ports.progressEmitter.emit({
      type: "phase_done",
      runId: opts.runId,
      phase: context.currentPhase,
    });
  }
  opts.ports.progressEmitter.emit({
    type: "run_done",
    runId: opts.runId,
    ...result,
  });
  return result;
}
