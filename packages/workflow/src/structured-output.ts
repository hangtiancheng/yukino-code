import { Ajv, type ValidateFunction } from "ajv";

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
