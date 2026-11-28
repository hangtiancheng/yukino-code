import { z } from "zod";

import { CODE_MODE_MAX_OUTPUT_TOKENS } from "@/code-mode/constants.js";
import {
  CODE_MODE_FINGERPRINT,
  startWorkflowRun,
} from "@/code-mode/runtime.js";
import { assertBoundedVmJson } from "@/code-mode/schema.js";
import type { CodeModeCall, WorkflowVmOutcome } from "@/code-mode/types.js";
import { asErrorString } from "@/utils/index.js";
import {
  MAX_ITEMS_PER_CALL,
  WORKFLOW_DANGEROUS_KEYS,
  WORKFLOW_JOURNAL_FORMAT,
  WORKFLOW_MAX_ARGS_CHARS,
} from "@/workflow/constants.js";
import type { EngineContext } from "@/workflow/context.js";
import { makeHooks, type SubWorkflowRunner } from "@/workflow/hooks.js";
import {
  rebuildWorkflowJournal,
  workflowFingerprint,
} from "@/workflow/journal.js";
import type { JournalEntry } from "@/workflow/schema.js";
import { parseScript } from "@/workflow/script.js";
import {
  WORKFLOW_PRELUDE_SOURCE,
  WORKFLOW_SCRIPT_PREFIX,
  WORKFLOW_SCRIPT_SUFFIX,
} from "@/workflow/snippets.js";
import type { WorkflowRunResult } from "@/workflow/types.js";

export const WORKFLOW_VM_FINGERPRINT = workflowFingerprint({
  runtime: CODE_MODE_FINGERPRINT,
  prelude: WORKFLOW_PRELUDE_SOURCE,
  prefix: WORKFLOW_SCRIPT_PREFIX,
  suffix: WORKFLOW_SCRIPT_SUFFIX,
});

export function assertBoundedWorkflowJson(value: unknown): void {
  assertBoundedVmJson(value, WORKFLOW_MAX_ARGS_CHARS, WORKFLOW_DANGEROUS_KEYS);
}

export interface WorkflowVmEnvironment {
  cwd: string;
  maxConcurrency: number;
  budgetTotal: number | null;
  declarations: string;
}
export async function executeWorkflowVm(options: {
  source: string;
  args: unknown;
  ctx: EngineContext;
  entries: JournalEntry[];
  scope: string;
  depth: number;
  startedAt: number;
  deadline: number;
  environment: WorkflowVmEnvironment;
  runChild(
    opts: Parameters<SubWorkflowRunner>[0],
    scope: string,
    ctx: EngineContext,
  ): Promise<unknown>;
}): Promise<{ result: WorkflowRunResult; replayed: boolean }> {
  const { ctx, scope, entries } = options;
  ctx.signal.throwIfAborted();
  assertBoundedWorkflowJson(options.args);
  const parsed = parseScript(options.source);
  const states = rebuildWorkflowJournal(entries);
  for (const [name, state] of states) {
    if (scope !== "root" && name !== scope && !name.startsWith(scope + "/")) {
      continue;
    }
    const unknown = [...state.started].filter(
      (id) => !state.outcomes.some((item) => item.id === id),
    );
    if (unknown.length) {
      throw new Error(
        `Workflow cannot resume: ${unknown.map((id) => `${state.header?.scope}/c${id}`).join(", ")} started without recorded outcomes; unknown side effects will not be retried`,
      );
    }
  }
  const state = states.get(scope);
  const oldHeader = state?.header;
  const fingerprint = workflowFingerprint({
    source: options.source,
    args: options.args,
    environment: options.environment,
    runtime: WORKFLOW_VM_FINGERPRINT,
  });
  const edited =
    !!oldHeader && (oldHeader.fingerprint !== fingerprint || !!state?.edited);
  if (
    oldHeader &&
    (oldHeader.runtime !== WORKFLOW_VM_FINGERPRINT ||
      workflowFingerprint(oldHeader.environment) !==
        workflowFingerprint(options.environment))
  ) {
    throw new Error(
      "Workflow cannot resume: runtime, environment or declarations changed",
    );
  }
  if (!edited && state?.final) {
    return { result: state.final, replayed: true };
  }
  const deadline = oldHeader && !edited ? oldHeader.deadline : options.deadline;
  const startedAt = oldHeader?.startedAt ?? options.startedAt;
  const budgetSpent = oldHeader?.budgetSpent ?? ctx.resources.budget.spent();
  let serial = Promise.resolve();
  let failure: string | undefined;
  const local = new AbortController();
  const signal = AbortSignal.any([ctx.signal, local.signal]);
  const localCtx = { ...ctx, signal };
  const write = async (entry: JournalEntry): Promise<void> => {
    await ctx.ports.journalStore.append(ctx.runId, entry);
    entries.push(entry);
  };
  const oldCalls = [...(state?.calls ?? [])];
  let oldOutcomes = [...(state?.outcomes ?? [])];
  const seen: CodeModeCall[] = [];
  const pending = new Map<number, CodeModeCall>();
  const jobs = new Set<Promise<void>>();
  let sequence = 0;
  let settled = false;
  let replaying = oldCalls.length > 0;
  let diverged = false;
  const partial: unknown[] = [];
  const fail = (error: unknown): void => {
    failure ??= asErrorString(error);
    local.abort();
  };
  const enqueue = (fn: () => Promise<void>): void => {
    serial = serial.then(fn).catch(fail);
  };
  await write({
    kind: "header",
    format: WORKFLOW_JOURNAL_FORMAT,
    scope,
    source: options.source,
    args: options.args,
    environment: options.environment,
    fingerprint,
    runtime: WORKFLOW_VM_FINGERPRINT,
    startedAt,
    deadline,
    budgetSpent,
  });
  if (edited) {
    ctx.ports.logger.warn(
      "Workflow source/args changed: replay the verified prefix; invalidate the suffix at the first changed call (no rollback of existing edits)",
    );
  }
  const dispatch = async (call: CodeModeCall): Promise<unknown> => {
    const hooks = makeHooks(
      localCtx,
      (sub) => options.runChild(sub, `${scope}/c${call.id}`, localCtx),
      options.depth,
    );
    switch (call.name) {
      case "agent": {
        const input = z
          .strictObject({
            prompt: z.string(),
            options: z.record(z.string(), z.unknown()),
          })
          .parse(call.args);
        assertBoundedWorkflowJson(input);
        return hooks.agent(input.prompt, input.options);
      }
      case "workflow": {
        const input = z
          .strictObject({
            ref: z.union([
              z.string().min(1).max(1000),
              z.strictObject({ scriptPath: z.string().min(1).max(4096) }),
            ]),
            args: z.json(),
          })
          .parse(call.args);
        assertBoundedWorkflowJson(input.args);
        return hooks.workflow(input.ref, input.args);
      }
      case "phase":
      case "log": {
        const input = z
          .strictObject({ value: z.string().min(1).max(10_000) })
          .parse(call.args);
        if (call.name === "phase") {
          hooks.phase(input.value);
          ctx.currentPhase = localCtx.currentPhase;
        } else {
          hooks.log(input.value);
        }
        return null;
      }
      default:
        throw new Error("Invalid Workflow bridge operation");
    }
  };
  const launch = (issued: number): void => {
    if (settled || signal.aborted || replaying) {
      return;
    }
    for (const call of pending.values()) {
      if (call.id > issued) {
        continue;
      }
      pending.delete(call.id);
      const job = (async () => {
        await write({ kind: "started", scope, id: call.id });
        let outcome: WorkflowVmOutcome;
        try {
          signal.throwIfAborted();
          const data = await dispatch(call);
          outcome = {
            ok: true,
            value: {
              data: data ?? null,
              budgetSpent: ctx.resources.budget.spent(),
            },
          };
        } catch (error) {
          outcome = {
            ok: false,
            error: asErrorString(error),
            budgetSpent: ctx.resources.budget.spent(),
          };
        }
        await new Promise<void>((resolve) => {
          enqueue(async () => {
            const now = Date.now();
            await write({
              kind: "outcome",
              scope,
              id: call.id,
              seq: ++sequence,
              now,
              outcome,
            });
            if (
              outcome.ok &&
              (call.name === "agent" || call.name === "workflow")
            ) {
              partial.push(outcome.value.data);
            }
            if (!settled) {
              vm?.deliver(sequence, now, call.id, outcome);
            }
            resolve();
          });
          void serial.then(resolve);
        });
      })().catch(fail);
      jobs.add(job);
      void job.finally(() => jobs.delete(job));
    }
  };
  const vm = startWorkflowRun(
    {
      code: parsed.body,
      tools: [],
      store: {},
      seed: 0,
      startedAt,
      deadline,
      maxOutputTokens: CODE_MODE_MAX_OUTPUT_TOKENS,
      workflow: {
        args: options.args,
        budgetTotal: ctx.resources.budget.total,
        budgetSpent,
        maxItems: MAX_ITEMS_PER_CALL,
      },
    },
    {
      signal,
      onCall(call) {
        seen.push(call);
        pending.set(call.id, call);
        enqueue(async () => {
          const old = oldCalls[call.id - 1];
          if (old && workflowFingerprint(old) !== workflowFingerprint(call)) {
            if (!edited) {
              throw new Error("Workflow replay changed a recorded call");
            }
            if (!diverged) {
              await write({
                kind: "invalidate",
                scope,
                from: call.id,
                reason:
                  "Source/args changed; recorded suffix no longer matches",
              });
              diverged = true;
              oldOutcomes = oldOutcomes
                .filter((item) => item.id < call.id)
                .map((item, index) => ({ ...item, seq: index + 1 }));
            }
          }
          if (!old || diverged) {
            await write({
              kind: "call",
              scope,
              call: {
                ...call,
                name: z
                  .enum(["agent", "workflow", "phase", "log"])
                  .parse(call.name),
              },
            });
          }
        });
      },
      onIdle(seq, issued) {
        if (issued !== seen.length) {
          fail("Invalid Workflow issued-call checkpoint");
          return;
        }
        enqueue(async () => {
          if (settled || signal.aborted) {
            return;
          }
          if (seq > sequence) {
            throw new Error("Invalid Workflow delivery checkpoint");
          }
          const expected = state?.checkpoints.get(seq);
          if (!edited && expected !== undefined && expected !== issued) {
            throw new Error("Workflow replay diverged at checkpoint");
          }
          if (replaying) {
            const next = oldOutcomes[seq];
            if (next) {
              const call = pending.get(next.id);
              if (
                !call ||
                workflowFingerprint(call) !==
                  workflowFingerprint(oldCalls[next.id - 1])
              ) {
                throw new Error(
                  "Workflow replay did not issue its recorded call",
                );
              }
              pending.delete(next.id);
              sequence++;
              ctx.resources.budget.restoreSpent(
                next.outcome.ok
                  ? next.outcome.value.budgetSpent
                  : next.outcome.budgetSpent,
              );
              vm?.deliver(sequence, next.now, next.id, next.outcome);
              return;
            }
            if (!edited && seen.length < oldCalls.length) {
              throw new Error("Workflow replay ended before recorded calls");
            }
            replaying = false;
          }
          await write({ kind: "idle", scope, seq, issued });
          launch(issued);
        });
      },
    },
    options.depth,
  );
  const terminal = await vm.result;
  if (!terminal.ok) {
    failure ??= terminal.error;
  }
  settled = true;
  local.abort();
  await serial;
  await Promise.allSettled([...jobs]);
  await serial;
  await vm.close();
  if (
    edited &&
    !failure &&
    terminal.ok &&
    seen.length < oldCalls.length &&
    !diverged
  ) {
    await write({
      kind: "invalidate",
      scope,
      from: seen.length + 1,
      reason: "Edited source removed the recorded suffix",
    });
    oldOutcomes = oldOutcomes.filter((item) => item.id <= seen.length);
  }
  if (replaying && terminal.during.seq < oldOutcomes.length) {
    failure ??= "Workflow replay ended before its historical prefix";
  }
  const result: WorkflowRunResult =
    failure || !terminal.ok
      ? {
          status: ctx.signal.aborted ? "killed" : "failed",
          ...(ctx.signal.aborted ? {} : { error: failure ?? terminal.error }),
          ...(partial.length ? { partial } : {}),
        }
      : {
          status: "completed",
          ...(terminal.value !== undefined
            ? { returnValue: terminal.value }
            : {}),
        };
  try {
    await write({ kind: "final", scope, result });
  } catch (error) {
    return {
      result: {
        status: "failed",
        error: result.error ?? asErrorString(error),
        ...(partial.length ? { partial } : {}),
      },
      replayed: false,
    };
  }
  return { result, replayed: false };
}
