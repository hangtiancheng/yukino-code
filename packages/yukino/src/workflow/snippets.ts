import { CODE_MODE_PRELUDE_SOURCE } from "@/code-mode/snippets.js";
import type { WorkflowVmStart } from "@/code-mode/types.js";

export const WORKFLOW_PRELUDE_SOURCE = String.raw`
((config) => {
  "use strict";
  const bridge = globalThis.__workflowCall;
  delete globalThis.__workflowCall;
  const stringify = JSON.stringify.bind(JSON);
  const parse = JSON.parse.bind(JSON);
  const freeze = Object.freeze;
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, writable: false, configurable: false });
  const deepFreeze = (value) => {
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) deepFreeze(item);
      freeze(value);
    }
    return value;
  };
  let spent = config.budgetSpent;
  const pending = new Set();
  const notifications = [];
  const invoke = (name, args) => {
    const result = bridge(name, stringify(args)).then(encoded => {
      const value = parse(encoded);
      spent = Math.max(spent, value.budgetSpent);
      return value.data;
    }, error => {
      spent = Math.max(spent, error.budgetSpent);
      throw error;
    });
    pending.add(result);
    result.then(() => pending.delete(result), () => pending.delete(result));
    return result;
  };
  define("args", deepFreeze(config.args));
  define("budget", freeze({ total: config.budgetTotal, spent: () => spent,
    remaining: () => config.budgetTotal === null ? Infinity : Math.max(0, config.budgetTotal - spent) }));
  define("agent", (prompt, options = {}) => invoke("agent", { prompt, options }));
  define("workflow", (ref, args = null) => invoke("workflow", { ref, args }));
  for (const name of ["phase", "log"]) define(name, value => {
    const result = invoke(name, { value });
    notifications.push(result);
    return result;
  });
  const parallel = async thunks => {
    if (!Array.isArray(thunks) || thunks.length > config.maxItems || thunks.some(item => typeof item !== "function")) throw new Error("Invalid parallel items or items cap exceeded");
    return Promise.all(thunks.map(async thunk => { try { return await thunk(); } catch { return null; } }));
  };
  define("parallel", parallel);
  define("pipeline", async (items, ...stages) => {
    if (!Array.isArray(items) || items.length > config.maxItems || stages.some(stage => typeof stage !== "function")) throw new Error("Invalid pipeline items or stages");
    return parallel(items.map((item, index) => async () => {
      let previous = item;
      for (const stage of stages) previous = await stage(previous, item, index);
      return previous;
    }));
  });
  return async () => {
    await Promise.all(notifications);
    while (pending.size) await Promise.allSettled([...pending]);
  };
})
`;
export const WORKFLOW_SCRIPT_PREFIX =
  '(async () => { "use strict"; const result = await (async () => {\n';
export const WORKFLOW_SCRIPT_SUFFIX =
  "\n})(); await __workflowFlush(); return result; })()";

export function buildWorkflowPrelude(start: WorkflowVmStart): string {
  return `(() => { const controls = ${CODE_MODE_PRELUDE_SOURCE}(${JSON.stringify({ startedAt: start.startedAt, seed: start.seed, workflow: true })}); const flush = ${WORKFLOW_PRELUDE_SOURCE}(${JSON.stringify(start.workflow)}); Object.defineProperty(globalThis, "__workflowFlush", { value: flush, writable: false, configurable: false }); return controls; })()`;
}
