import { Script } from "node:vm";

import { z } from "zod";

import { asErrorString } from "@/utils/index.js";
import type { WorkflowMeta } from "@/workflow/types.js";

export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptError";
  }
}

export interface WorkflowHooks {
  agent: (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>;
  parallel: <T>(thunks: (() => Promise<T>)[]) => Promise<(T | null)[]>;
  pipeline: <T>(
    items: readonly T[],
    ...stages: ((prev: unknown, item: T, index: number) => Promise<unknown>)[]
  ) => Promise<unknown[]>;
  phase: (title: string) => void;
  log: (message: string) => void;
  workflow: (
    nameOrRef: string | { scriptPath: string },
    args?: unknown,
  ) => Promise<unknown>;
}

const META_RE = /export\s+const\s+meta\s*=\s*/;

export function extractMeta(source: string): {
  meta: WorkflowMeta | null;
  body: string;
} {
  const match = META_RE.exec(source);
  if (!match) {
    return { meta: null, body: source };
  }

  let i = match.index + match[0].length;
  while (i < source.length && /\s/.test(source[i])) {
    i++;
  }
  if (source[i] !== "{") {
    throw new ScriptError("meta must be an object literal `{ ... }`");
  }

  let depth = 0;
  const start = i;
  let inStr: string | null = null;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (inStr) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inStr) {
        inStr = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  if (depth !== 0) {
    throw new ScriptError("meta literal braces are not closed");
  }

  const literal = source.slice(start, i);
  let metaObj: unknown;
  try {
    metaObj = new Script(`(${literal})`).runInThisContext();
  } catch (e) {
    throw new ScriptError(
      `meta must be a plain literal (no variable/function calls/interpolation): ${asErrorString(e)}`,
    );
  }
  const meta = validateMeta(metaObj);

  const body =
    source.slice(0, match.index) +
    source.slice(i).replace(/^[ \t]*;[ \t]*\n/, "\n");
  return { meta, body };
}

const workflowMetaSchema = z.object({
  name: z.string(),
  description: z.string(),
  whenToUse: z.string().optional(),
  phases: z
    .array(z.object({ title: z.string(), detail: z.string().optional() }))
    .optional(),
});
function validateMeta(value: unknown): WorkflowMeta {
  const parsed = workflowMetaSchema.safeParse(value);
  if (!parsed.success) {
    throw new ScriptError(
      "meta must include string name and description and valid phases",
    );
  }
  return parsed.data;
}

class NonDeterministicError extends Error {
  constructor(fn: string) {
    super(
      `${fn} is not available in workflow scripts (would break resume determinism). Pass timestamps/random seeds via args.`,
    );
    this.name = "NonDeterministicError";
  }
}

function sandboxDate(): DateConstructor {
  return new Proxy(Date, {
    apply() {
      throw new NonDeterministicError("Date()");
    },
    construct(target, args, newTarget) {
      if (args.length === 0) {
        throw new NonDeterministicError("new Date()");
      }
      const result: unknown = Reflect.construct(target, args, newTarget);
      if (result instanceof Date) {
        return result;
      }
      throw new ScriptError("Invalid Date result");
    },
    get(target, property, receiver): unknown {
      if (property === "now") {
        return () => {
          throw new NonDeterministicError("Date.now()");
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  });
}
function sandboxMath(): Math {
  return new Proxy(Math, {
    get(target, property, receiver): unknown {
      if (property === "random") {
        return () => {
          throw new NonDeterministicError("Math.random()");
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  });
}
const scriptFunctionSchema = z.custom<(...args: unknown[]) => Promise<unknown>>(
  (value) => typeof value === "function",
);

export interface ParsedScript {
  meta: WorkflowMeta | null;
  execute: (
    hooks: WorkflowHooks,
    args: unknown,
    budget: unknown,
  ) => Promise<unknown>;
}

function assertScriptBody(body: string): void {
  if (/^\s*import\b/m.test(body)) {
    throw new ScriptError(
      "workflow scripts are the body of new AsyncFunction (not ESM modules); import is not supported. " +
        "agent / parallel / pipeline / phase / log / workflow / args / budget are injected as parameters — use them directly.",
    );
  }

  if (/\bimport\s*\(/m.test(body)) {
    throw new ScriptError(
      "dynamic import(...) is forbidden in workflow scripts: it bypasses the Date/Math sandbox and breaks resume determinism. " +
        "The sandbox does not guarantee security (same trust level as the LLM), but explicit escapes are prohibited. Inject external dependencies via args.",
    );
  }
  if (/^\s*export\b/m.test(body)) {
    throw new ScriptError(
      "workflow scripts allow only one export const meta = {...} (already extracted by the engine). " +
        "Remove other export / export default statements; use top-level return for the result.",
    );
  }
}

export function parseScript(source: string): ParsedScript {
  const { meta, body } = extractMeta(source);
  assertScriptBody(body);
  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    const value: unknown = new Script(
      `(async function(agent, parallel, pipeline, phase, log, workflow, args, budget, Date, Math) {\n${body}\n})`,
      { filename: "workflow.js" },
    ).runInThisContext();
    fn = scriptFunctionSchema.parse(value);
  } catch (e) {
    throw new ScriptError(`Script syntax error: ${asErrorString(e)}`);
  }
  const sandboxedDate = sandboxDate();
  const sandboxedMath = sandboxMath();
  return {
    meta,
    async execute(hooks, args, budget) {
      return fn(
        hooks.agent,
        hooks.parallel,
        hooks.pipeline,
        hooks.phase,
        hooks.log,
        hooks.workflow,
        args,
        budget,
        sandboxedDate,
        sandboxedMath,
      );
    },
  };
}
