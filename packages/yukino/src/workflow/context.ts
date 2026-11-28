import PQueue from "p-queue";

import { Budget } from "@/workflow/budget.js";
import { clampMaxConcurrency } from "@/workflow/concurrency.js";
import type { HostHandle, WorkflowPorts } from "@/workflow/ports.js";

export interface SharedResources {
  queue: PQueue;
  budget: Budget;
  agentIdSeq: { value: number };
}
export interface EngineContext {
  ports: WorkflowPorts;
  host: HostHandle;
  signal: AbortSignal;
  runId: string;
  workflowName: string;
  cwd: string;
  resources: SharedResources;
  inFlight: Set<Promise<unknown>>;
  currentPhase: string | null;
}
export function createSharedResources(
  budgetTotal: number | null,
  maxConcurrency?: number,
): SharedResources {
  return {
    queue: new PQueue({ concurrency: clampMaxConcurrency(maxConcurrency) }),
    budget: new Budget(budgetTotal),
    agentIdSeq: { value: 0 },
  };
}
export function createEngineContext(opts: {
  ports: WorkflowPorts;
  host: HostHandle;
  signal: AbortSignal;
  runId: string;
  workflowName: string;
  cwd: string;
  budgetTotal: number | null;
  maxConcurrency?: number;
}): EngineContext {
  return {
    ...opts,
    resources: createSharedResources(opts.budgetTotal, opts.maxConcurrency),
    inFlight: new Set(),
    currentPhase: null,
  };
}
