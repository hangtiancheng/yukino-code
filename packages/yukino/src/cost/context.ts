import { AsyncLocalStorage } from "node:async_hooks";

import type { ExecutionLedger } from "@/cost/ledger.js";
import type { ExecutionPurpose } from "@/cost/types.js";

export interface ExecutionContext {
  sessionId: string;
  runId: string;
  parentRunId?: string;
  agentId: string;
  purpose: ExecutionPurpose;
  ledger: ExecutionLedger;
}

const executionContext = new AsyncLocalStorage<ExecutionContext>();

export function getExecutionContext(): ExecutionContext | undefined {
  return executionContext.getStore();
}

export function registerExecutionContext(context: ExecutionContext): void {
  if (context.ledger.sessionId !== context.sessionId) {
    throw new Error("Execution context and ledger session IDs differ");
  }
  const current = getExecutionContext();
  if (current?.ledger === context.ledger) {
    if (current.sessionId !== current.ledger.sessionId) {
      throw new Error("Execution context and ledger session IDs differ");
    }
    context.ledger.registerRun(current);
  }
  context.ledger.registerRun(context);
}

export function withExecutionContext<T>(
  context: ExecutionContext,
  fn: () => T,
): T {
  registerExecutionContext(context);
  return executionContext.run(Object.freeze({ ...context }), fn);
}

/** Async generator bodies are lazy; bind each iterator operation, not just creation. */
export function bindExecutionContext<T>(
  iterator: AsyncGenerator<T>,
  context = getExecutionContext(),
): AsyncGenerator<T> {
  const owner = context ? Object.freeze({ ...context }) : undefined;
  if (owner) {
    registerExecutionContext(owner);
  }
  const invoke = <R>(fn: () => R): R =>
    owner ? executionContext.run(owner, fn) : fn();
  return {
    next: (...args) => invoke(() => iterator.next(...args)),
    return: (value) => invoke(() => iterator.return(value)),
    throw: (error) => invoke(() => iterator.throw(error)),
    [Symbol.asyncIterator]() {
      return this;
    },
    [Symbol.asyncDispose]: () =>
      invoke(() => iterator.return(undefined).then(() => undefined)),
  };
}
