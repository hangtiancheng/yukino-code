import { Budget } from "./budget.js";
import { Semaphore, clampMaxConcurrency } from "./concurrency.js";
import type { HostHandle, WorkflowPorts } from "./ports.js";
import type { JournalEntry } from "./types.js";

export interface SharedResources {
  semaphore: Semaphore;
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
  journal: JournalEntry[];
  journalReset: Promise<void> | null;
  inFlight: Set<Promise<unknown>>;
  journalInvalidated: boolean;
  currentPhase: string | null;
}

export function createSharedResources(
  budgetTotal: number | null,
  maxConcurrency?: number,
): SharedResources {
  return {
    semaphore: new Semaphore(clampMaxConcurrency(maxConcurrency)),
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
  journal?: JournalEntry[];
}): EngineContext {
  const resources = createSharedResources(
    opts.budgetTotal,
    opts.maxConcurrency,
  );
  return {
    ports: opts.ports,
    host: opts.host,
    signal: opts.signal,
    runId: opts.runId,
    workflowName: opts.workflowName,
    cwd: opts.cwd,
    resources,
    journal: opts.journal ? [...opts.journal] : [],
    journalReset: null,
    inFlight: new Set(),
    journalInvalidated: false,
    currentPhase: null,
  };
}
