import type { AgentAdapterRegistry } from "./agent-adapter.js";
import type { JournalEntry, ProgressEvent } from "./types.js";

const HOST_HANDLE = Symbol("workflow.hostHandle");
export interface HostHandle {
  readonly [HOST_HANDLE]: unknown;
}

export function createHostHandle(bundle: unknown): HostHandle {
  return { [HOST_HANDLE]: bundle };
}
export function unwrapHostHandle(handle: HostHandle): unknown {
  return handle[HOST_HANDLE];
}

export interface JournalStore {
  read(runId: string): Promise<JournalEntry[]>;
  append(runId: string, entry: JournalEntry): Promise<void>;
  replace(runId: string, entries: JournalEntry[]): Promise<void>;
}

export interface WorkflowPorts {
  agentAdapterRegistry: AgentAdapterRegistry;
  progressEmitter: { emit(event: ProgressEvent): void };
  journalStore: JournalStore;
  logger: { warn(message: string): void };
  agentControllers: Map<number, AbortController>;
}
