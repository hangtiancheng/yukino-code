import { asErrorString } from "@yukino.js/utils";
import type { AgentAdapterContext } from "./agent-adapter.js";
import { MAX_ITEMS_PER_CALL, MAX_TOTAL_AGENTS } from "./constants.js";
import type { EngineContext } from "./context.js";
import { WorkflowAbortedError, WorkflowError } from "./errors.js";
import { agentCallKey } from "./journal.js";
import { agentRunParamsSchema } from "./schema.js";
import type { WorkflowHooks } from "./script.js";
import {
  assertValidJsonSchema,
  validateAgainstSchema,
} from "./structured-output.js";
import type { AgentRunParams, AgentRunResult, ProgressEvent } from "./types.js";

export type SubWorkflowRunner = (opts: {
  name?: string;
  scriptPath?: string;
  args?: unknown;
  depth: number;
}) => Promise<unknown>;

export function makeHooks(
  ctx: EngineContext,
  runSubWorkflow: SubWorkflowRunner,
  depth = 0,
): WorkflowHooks {
  const emit = (event: ProgressEvent): void => {
    ctx.ports.progressEmitter.emit(event);
  };
  const callAgent = async (
    prompt: string,
    opts: Record<string, unknown> = {},
  ): Promise<unknown> => {
    if (ctx.signal.aborted) {
      throw new WorkflowAbortedError();
    }
    const agentId = ctx.resources.agentIdSeq.value++;
    if (agentId >= MAX_TOTAL_AGENTS) {
      throw new WorkflowError(
        `workflow exceeds total agent cap (${MAX_TOTAL_AGENTS})`,
      );
    }
    const params: AgentRunParams = agentRunParamsSchema.parse({
      ...opts,
      prompt,
    });
    if (params.schema) {
      assertValidJsonSchema(params.schema);
    }
    const key = agentCallKey(prompt, params);
    const label = typeof opts.label === "string" ? opts.label : undefined;
    const phase =
      typeof opts.phase === "string"
        ? opts.phase
        : (ctx.currentPhase ?? undefined);
    const done = (result: AgentRunResult): void => {
      emit({
        type: "agent_done",
        runId: ctx.runId,
        agentId,
        label,
        phase,
        result,
      });
    };
    if (!ctx.journalInvalidated && ctx.journal.length) {
      const entry = ctx.journal.find((item) => item.seq === agentId);
      if (
        entry?.key === key &&
        entry.result.kind === "ok" &&
        validateStructuredResult(entry.result, params.schema).kind === "ok"
      ) {
        done(entry.result);
        return entry.result.output;
      }
      // Keep the replayed prefix and the saved source when execution diverges.
      ctx.journalInvalidated = true;
      ctx.journalReset = ctx.ports.journalStore.replace(
        ctx.runId,
        ctx.journal.filter((item) => item.seq < agentId),
      );
    }
    await ctx.journalReset;
    let release: () => void;
    try {
      release = await ctx.resources.semaphore.acquire(ctx.signal);
    } catch {
      throw new WorkflowAbortedError();
    }
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    ctx.signal.addEventListener("abort", abort, { once: true });
    ctx.ports.agentControllers.set(agentId, controller);
    try {
      if (ctx.signal.aborted) {
        throw new WorkflowAbortedError();
      }
      ctx.resources.budget.assertCanSpend();
      emit({ type: "agent_started", runId: ctx.runId, agentId, label, phase });
      const adapter = ctx.ports.agentAdapterRegistry.resolve(params);
      const adapterContext: AgentAdapterContext = {
        host: ctx.host,
        signal: controller.signal,
        runId: ctx.runId,
        agentId,
        onProgress: (update) => {
          emit({
            type: "agent_progress",
            runId: ctx.runId,
            agentId,
            label,
            phase,
            ...update,
          });
        },
      };
      let result: AgentRunResult = { kind: "dead", reason: "unknown" };
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          result = validateStructuredResult(
            await adapter.run(params, adapterContext),
            params.schema,
          );
        } catch (error) {
          if (ctx.signal.aborted) {
            throw new WorkflowAbortedError();
          }
          result = controller.signal.aborted
            ? { kind: "skipped" }
            : {
                kind: "dead",
                reason: "run-agent-threw",
                detail: asErrorString(error),
              };
        }
        if (ctx.signal.aborted) {
          throw new WorkflowAbortedError();
        }
        if (controller.signal.aborted) {
          result = { kind: "skipped" };
        }
        if (result.kind !== "dead") {
          break;
        }
        ctx.ports.logger.warn(
          `workflow agent ${agentId}: ${result.detail ?? result.reason}`,
        );
      }
      if (result.kind === "ok") {
        ctx.resources.budget.addOutputTokens(result.usage.outputTokens);
      }
      done(result);
      await ctx.ports.journalStore.append(ctx.runId, {
        key,
        seq: agentId,
        result,
      });
      return result.kind === "ok" ? result.output : null;
    } finally {
      ctx.signal.removeEventListener("abort", abort);
      ctx.ports.agentControllers.delete(agentId);
      release();
    }
  };
  const agent: WorkflowHooks["agent"] = (prompt, opts) => {
    const promise = callAgent(prompt, opts);
    ctx.inFlight.add(promise);
    void promise.then(
      () => ctx.inFlight.delete(promise),
      () => ctx.inFlight.delete(promise),
    );
    return promise;
  };
  const parallel: WorkflowHooks["parallel"] = async (thunks) => {
    if (thunks.length > MAX_ITEMS_PER_CALL) {
      throw new WorkflowError(
        `parallel exceeds the per-call items cap (${MAX_ITEMS_PER_CALL})`,
      );
    }
    return Promise.all(
      thunks.map(async (thunk) => {
        try {
          return await thunk();
        } catch (error) {
          if (error instanceof WorkflowAbortedError) {
            throw error;
          }
          ctx.ports.logger.warn(asErrorString(error));
          return null;
        }
      }),
    );
  };
  const pipeline: WorkflowHooks["pipeline"] = async <T>(
    items: readonly T[],
    ...stages: ((
      previous: unknown,
      item: T,
      index: number,
    ) => Promise<unknown>)[]
  ): Promise<unknown[]> => {
    if (items.length > MAX_ITEMS_PER_CALL) {
      throw new WorkflowError(
        `pipeline exceeds the per-call items cap (${MAX_ITEMS_PER_CALL})`,
      );
    }
    return parallel(
      items.map((item, index) => async () => {
        let previous: unknown = item;
        for (const stage of stages) {
          previous = await stage(previous, item, index);
        }
        return previous;
      }),
    );
  };
  return {
    agent,
    parallel,
    pipeline,
    phase(title) {
      if (ctx.currentPhase) {
        emit({ type: "phase_done", runId: ctx.runId, phase: ctx.currentPhase });
      }
      ctx.currentPhase = title;
      emit({ type: "phase_started", runId: ctx.runId, phase: title });
    },
    log(message) {
      emit({ type: "log", runId: ctx.runId, message });
    },
    workflow(nameOrRef, args) {
      if (depth >= 1) {
        throw new WorkflowError("workflow() nesting allows only one level");
      }
      return runSubWorkflow({
        ...(typeof nameOrRef === "string" ? { name: nameOrRef } : nameOrRef),
        args,
        depth: depth + 1,
      });
    },
  };
}

function validateStructuredResult(
  result: AgentRunResult,
  schema?: object,
): AgentRunResult {
  if (!schema || result.kind !== "ok") {
    return result;
  }
  const validation = validateAgainstSchema(result.output, schema);
  return validation.valid
    ? result
    : {
        kind: "dead",
        reason: "invalid-structured-output",
        detail: validation.errors.join("; "),
      };
}
