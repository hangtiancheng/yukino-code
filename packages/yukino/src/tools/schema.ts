import { Ajv, type ValidateFunction } from "ajv";
import { z } from "zod";

import type { ToolSchema } from "@/tools/types.js";

const cache = new WeakMap<object, ValidateFunction>();

function getValidator(schema: object): ValidateFunction {
  const cached = cache.get(schema);
  if (cached) {
    return cached;
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if ("$async" in validate && validate.$async === true) {
    throw new Error("Async JSON schemas are not supported");
  }
  cache.set(schema, validate);
  return validate;
}

export function assertValidJsonSchema(schema: object): void {
  getValidator(schema);
}

export function validateAgainstSchema(
  value: unknown,
  schema: object,
): { valid: boolean; errors: string[] } {
  const validate = getValidator(schema);
  const valid = validate(value);
  return {
    valid,
    errors: valid
      ? []
      : (validate.errors ?? []).map((e) => {
          const message = e.message ?? "validation error";
          return e.instancePath ? `${e.instancePath} ${message}` : message;
        }),
  };
}

export const ToolJsonSchema = z.looseObject({
  type: z.literal("object"),
  properties: z.record(z.string(), z.looseObject({})),
  required: z.array(z.string()).optional(),
});

const toolSchemaCache = new WeakMap<z.ZodType, ToolSchema["input_schema"]>();

export function createToolSchema(
  name: string,
  description: string,
  parameters: z.ZodType,
  options: Pick<ToolSchema, "strict" | "defer_loading"> = {},
): ToolSchema {
  let inputSchema = toolSchemaCache.get(parameters);
  if (!inputSchema) {
    const { $schema: _schema, ...input } = z.toJSONSchema(parameters, {
      target: "draft-7",
      io: "input",
    });
    inputSchema = ToolJsonSchema.parse(input);
    toolSchemaCache.set(parameters, inputSchema);
  }
  return { name, description, ...options, input_schema: inputSchema };
}
