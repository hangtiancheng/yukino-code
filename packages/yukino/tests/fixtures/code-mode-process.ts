import { appendFileSync, readFileSync } from "node:fs";

import { CodeModeExecution } from "@/code-mode/execution.js";
import type { CodeModeHost } from "@/code-mode/types.js";

const [transcriptPath, counterPath, phase] = process.argv.slice(2);
if (!transcriptPath || !counterPath) {
  throw new Error("Missing fixture arguments");
}
const pause = (stage: string) => {
  process.send?.({ stage });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const host: CodeModeHost = {
  stateKey: {},
  sessionId: "code-mode-fixture",
  transcriptPath,
  tools: () => [
    {
      name: "Record",
      description: "Record once",
      schema: {
        name: "Record",
        description: "Record once",
        input_schema: { type: "object", properties: {} },
      },
    },
  ],
  async *execute(calls, _signal, before) {
    await Promise.resolve();
    for (const call of calls) {
      before(call.toolUseId);
      appendFileSync(counterPath, JSON.stringify(call.arguments) + "\n");
      if (phase === "unknown") {
        pause("unknown");
      }
      yield {
        toolId: call.toolUseId,
        output: String(call.arguments.key),
        isError: false,
      };
    }
  },
  progress(message) {
    if (phase === "recorded" && message === "Record completed") {
      pause("recorded");
    }
  },
};
const code = `const sample = [Date.now(), Math.random()];
const a = await tools.Record({key: "a", sample});
const b = await tools.Record({key: "b", sample});
store("sample", sample);
return [a.output, b.output];`;
const result = await new CodeModeExecution().execute(host, "durable-call", {
  code,
  timeout_ms: 60_000,
  max_output_tokens: 1000,
});
process.send?.({ result, records: readFileSync(counterPath, "utf8") });
process.disconnect?.();
