import {
  assertValidJsonSchema,
  validateAgainstSchema,
} from "@/tools/schema.js";
import { acquireQueueSlot } from "@/utils/concurrency.js";
import { asErrorString } from "@/utils/index.js";
import type { AgentAdapterContext } from "@/workflow/agent-adapter.js";
import { MAX_TOTAL_AGENTS } from "@/workflow/constants.js";
import type { EngineContext } from "@/workflow/context.js";
import { WorkflowAbortedError, WorkflowError } from "@/workflow/errors.js";
import {
  agentRunParamsSchema,
  agentRunResultSchema,
} from "@/workflow/schema.js";
import type { WorkflowHooks } from "@/workflow/script.js";
import type { AgentRunResult } from "@/workflow/types.js";

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
  const callAgent: WorkflowHooks["agent"] = async (prompt, opts = {}) => {
    ctx.signal.throwIfAborted();
    const params = agentRunParamsSchema.parse({ ...opts, prompt });
    if (params.schema) {
      assertValidJsonSchema(params.schema);
    }
    const agentId = ctx.resources.agentIdSeq.value++;
    if (agentId >= MAX_TOTAL_AGENTS) {
      throw new WorkflowError(
        `workflow exceeds total agent cap (${MAX_TOTAL_AGENTS})`,
      );
    }
    const controller = new AbortController();
    const abort = (): void => {
      controller.abort();
    };
    ctx.signal.addEventListener("abort", abort, { once: true });
    ctx.ports.agentControllers.set(agentId, controller);
    let release: (() => void) | undefined;
    const label = params.label;
    const phase = params.phase ?? ctx.currentPhase ?? undefined;
    try {
      release = await acquireQueueSlot(ctx.resources.queue, controller.signal);
      controller.signal.throwIfAborted();
      ctx.resources.budget.assertCanSpend();
      const adapter = ctx.ports.agentAdapterRegistry.resolve(params);
      ctx.ports.progressEmitter.emit({
        type: "agent_started",
        runId: ctx.runId,
        agentId,
        label,
        phase,
      });
      const adapterContext: AgentAdapterContext = {
        host: ctx.host,
        signal: controller.signal,
        runId: ctx.runId,
        agentId,
        onProgress: (update) => {
          ctx.ports.progressEmitter.emit({
            type: "agent_progress",
            runId: ctx.runId,
            agentId,
            label,
            phase,
            ...update,
          });
        },
      };
      let result: AgentRunResult;
      try {
        const raw = agentRunResultSchema.parse(
          await adapter.run(params, adapterContext),
        );
        if (raw.usage) {
          ctx.resources.budget.addOutputTokens(raw.usage.outputTokens);
        }
        result = validateStructuredResult(raw, params.schema);
      } catch (error) {
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
      ctx.ports.progressEmitter.emit({
        type: "agent_done",
        runId: ctx.runId,
        agentId,
        label,
        phase,
        result,
      });
      return result.kind === "ok" ? result.output : null;
    } catch (error) {
      if (ctx.signal.aborted) {
        throw new WorkflowAbortedError();
      }
      if (controller.signal.aborted) {
        return null;
      }
      throw error;
    } finally {
      ctx.signal.removeEventListener("abort", abort);
      ctx.ports.agentControllers.delete(agentId);
      release?.();
    }
  };
  return {
    agent(prompt, opts) {
      const promise = callAgent(prompt, opts);
      ctx.inFlight.add(promise);
      void promise.then(
        () => ctx.inFlight.delete(promise),
        () => ctx.inFlight.delete(promise),
      );
      return promise;
    },
    phase(title) {
      if (ctx.currentPhase) {
        ctx.ports.progressEmitter.emit({
          type: "phase_done",
          runId: ctx.runId,
          phase: ctx.currentPhase,
        });
      }
      ctx.currentPhase = title;
      ctx.ports.progressEmitter.emit({
        type: "phase_started",
        runId: ctx.runId,
        phase: title,
      });
    },
    log(message) {
      ctx.ports.progressEmitter.emit({
        type: "log",
        runId: ctx.runId,
        message,
      });
    },
    workflow(ref, args) {
      if (depth >= 1) {
        throw new WorkflowError("workflow() nesting allows only one level");
      }
      return runSubWorkflow({
        ...(typeof ref === "string" ? { name: ref } : ref),
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
