import { parse as parseJavaScript, type Expression, type Pattern } from "acorn";
import { z } from "zod";

import {
  VM_MAX_JSON_DEPTH,
  VM_MAX_JSON_NODES,
  VM_MAX_SOURCE_CHARS,
} from "@/code-mode/constants.js";
import {
  WORKFLOW_DANGEROUS_KEYS,
  WORKFLOW_MAX_META_CHARS,
} from "@/workflow/constants.js";
import type { WorkflowMeta } from "@/workflow/types.js";

export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptError";
  }
}

export interface WorkflowHooks {
  agent(prompt: string, opts?: Record<string, unknown>): Promise<unknown>;
  phase(title: string): void;
  log(message: string): void;
  workflow(
    nameOrRef: string | { scriptPath: string },
    args?: unknown,
  ): Promise<unknown>;
}

function staticValue(
  node: Expression | Pattern,
  state: { nodes: number },
  depth = 0,
): unknown {
  if (depth > VM_MAX_JSON_DEPTH || ++state.nodes > VM_MAX_JSON_NODES) {
    throw new ScriptError("Workflow metadata depth or node limit exceeded");
  }
  switch (node.type) {
    case "Literal":
      if (
        node.value === null ||
        typeof node.value === "string" ||
        typeof node.value === "boolean" ||
        (typeof node.value === "number" && Number.isFinite(node.value))
      ) {
        return node.value;
      }
      break;
    case "UnaryExpression":
      if (
        (node.operator === "-" || node.operator === "+") &&
        node.argument.type === "Literal" &&
        typeof node.argument.value === "number"
      ) {
        const value =
          node.operator === "-" ? -node.argument.value : node.argument.value;
        if (Number.isFinite(value)) {
          return value;
        }
      }
      break;
    case "ArrayExpression":
      return node.elements.map((entry) => {
        if (!entry || entry.type === "SpreadElement") {
          throw new ScriptError("Workflow metadata must contain data literals");
        }
        return staticValue(entry, state, depth + 1);
      });
    case "ObjectExpression": {
      const result: Record<string, unknown> = {};
      for (const property of node.properties) {
        if (
          property.type !== "Property" ||
          property.kind !== "init" ||
          property.computed ||
          property.method ||
          property.shorthand
        ) {
          throw new ScriptError(
            "Workflow metadata properties must be static data",
          );
        }
        const key =
          property.key.type === "Identifier"
            ? property.key.name
            : property.key.type === "Literal" &&
                typeof property.key.value === "string"
              ? property.key.value
              : null;
        if (
          key === null ||
          WORKFLOW_DANGEROUS_KEYS.has(key) ||
          Object.hasOwn(result, key)
        ) {
          throw new ScriptError("Invalid or duplicate Workflow metadata key");
        }
        result[key] = staticValue(property.value, state, depth + 1);
      }
      return result;
    }
  }
  throw new ScriptError("Workflow metadata must contain only data literals");
}

const workflowMetaSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  whenToUse: z.string().optional(),
  phases: z
    .array(z.strictObject({ title: z.string(), detail: z.string().optional() }))
    .optional(),
});

export function extractMeta(source: string): {
  meta: WorkflowMeta | null;
  body: string;
} {
  if (source.length > VM_MAX_SOURCE_CHARS) {
    throw new ScriptError("Workflow source limit exceeded");
  }
  try {
    const program = parseJavaScript(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
    const first = program.body[0];
    if (first?.type !== "ExportNamedDeclaration") {
      return { meta: null, body: source };
    }
    const declaration = first.declaration;
    if (
      declaration?.type !== "VariableDeclaration" ||
      declaration.kind !== "const" ||
      declaration.declarations.length !== 1
    ) {
      throw new ScriptError("Workflow metadata must use export const meta");
    }
    const entry = declaration.declarations[0];
    if (
      entry.id.type !== "Identifier" ||
      entry.id.name !== "meta" ||
      !entry.init ||
      first.end > WORKFLOW_MAX_META_CHARS
    ) {
      throw new ScriptError(
        "Invalid or oversized Workflow metadata declaration",
      );
    }
    const value = staticValue(entry.init, { nodes: 0 });
    const meta = workflowMetaSchema.parse(value);
    return {
      meta,
      body:
        source.slice(0, first.start) +
        source.slice(first.start, first.end).replace(/[^\r\n]/gu, " ") +
        source.slice(first.end),
    };
  } catch (error) {
    if (error instanceof ScriptError) {
      throw error;
    }
    throw new ScriptError(
      error instanceof Error ? error.message : "Invalid Workflow script",
    );
  }
}

export interface ParsedScript {
  meta: WorkflowMeta | null;
  body: string;
}

export function parseScript(source: string): ParsedScript {
  return extractMeta(source);
}
