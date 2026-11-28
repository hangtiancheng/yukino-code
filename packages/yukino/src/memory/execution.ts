import { randomUUID } from "node:crypto";

import type { ExecutionContext } from "@/cost/context.js";
import { createCostLedger } from "@/cost/ledger.js";
import { newSessionId } from "@/session/index.js";

export function memoryExecutionContext(
  parent?: ExecutionContext,
): ExecutionContext {
  const ledger =
    parent?.ledger ??
    createCostLedger({ sessionId: newSessionId(), persist: false });
  return {
    sessionId: ledger.sessionId,
    runId: randomUUID(),
    parentRunId: parent?.runId,
    agentId: parent?.agentId ?? "memory",
    purpose: "memory",
    ledger,
  };
}
