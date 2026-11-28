import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { AgentAdapterRegistry } from "@/workflow/agent-adapter.js";
import { createFileJournalStore } from "@/workflow/journal.js";
import { createHostHandle } from "@/workflow/ports.js";
import { runWorkflow } from "@/workflow/run-workflow.js";
import type { ProgressEvent } from "@/workflow/types.js";

const [cwd, phase] = process.argv.slice(2);
if (!cwd) {
  throw new Error("Missing fixture directory");
}
const pause = (stage: string) => {
  process.send?.({ stage });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const events: ProgressEvent[] = [];
const store = createFileJournalStore(join(cwd, "runs"));
const result = await runWorkflow({
  script:
    "phase('Review'); log('once'); const initial = budget.spent(); const a = await agent(JSON.stringify({key:'a', initial})); const now = Date.now(); const b = await agent(JSON.stringify({key:'b', now, spent:budget.spent()})); return {a,b,initial,now,spent:budget.spent()};",
  runId: "run",
  cwd,
  budgetTotal: 10,
  signal: new AbortController().signal,
  host: createHostHandle(null),
  resume: phase !== "recorded" && phase !== "unknown" && phase !== "lease",
  deadline: Date.now() + 60_000,
  ports: {
    journalStore: {
      ...store,
      acquire(runId) {
        if (!store.acquire) {
          throw new Error("Missing fixture lease acquisition");
        }
        const release = store.acquire(runId);
        if (phase === "lease") {
          pause("lease");
        }
        return release;
      },
      async append(runId, entry) {
        await store.append(runId, entry);
        if (
          phase === "recorded" &&
          entry.kind === "outcome" &&
          entry.id === 3
        ) {
          pause("recorded");
        }
      },
    },
    agentAdapterRegistry: new AgentAdapterRegistry()
      .register({
        id: "test",
        capabilities: { structuredOutput: true },
        run(params) {
          appendFileSync(join(cwd, "effects.jsonl"), params.prompt + "\n");
          if (phase === "unknown") {
            pause("unknown");
          }
          const raw: unknown = JSON.parse(params.prompt);
          const input = z.object({ key: z.string() }).parse(raw);
          return Promise.resolve({
            kind: "ok",
            output: input.key,
            usage: { outputTokens: 2 },
          });
        },
      })
      .default("test"),
    progressEmitter: {
      emit: (event) => {
        events.push(event);
      },
    },
    logger: { warn() {} },
    agentControllers: new Map(),
  },
});
process.send?.({
  result,
  events,
  effects: readFileSync(join(cwd, "effects.jsonl"), "utf8"),
});
process.disconnect?.();
