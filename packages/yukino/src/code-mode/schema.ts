import { z } from "zod";

import {
  CODE_MODE_MAX_OUTPUT_CHARS,
  VM_MAX_JSON_DEPTH,
  VM_MAX_JSON_NODES,
} from "@/code-mode/constants.js";

export function assertBoundedVmJson(
  value: unknown,
  maxChars = CODE_MODE_MAX_OUTPUT_CHARS,
  forbiddenKeys?: ReadonlySet<string>,
): void {
  const stack: { value: unknown; depth: number; exit?: boolean }[] = [
    { value, depth: 0 },
  ];
  const ancestors = new Set<object>();
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop();
    if (!item) {
      break;
    }
    const current = item.value;
    if (item.exit) {
      if (current !== null && typeof current === "object") {
        ancestors.delete(current);
      }
      continue;
    }
    if (++nodes > VM_MAX_JSON_NODES || item.depth > VM_MAX_JSON_DEPTH) {
      throw new Error("VM JSON depth or node limit exceeded");
    }
    if (current !== null && typeof current === "object") {
      if (ancestors.has(current)) {
        throw new Error("VM JSON must be acyclic");
      }
      if (
        !Array.isArray(current) &&
        Object.getPrototypeOf(current) !== Object.prototype &&
        Object.getPrototypeOf(current) !== null
      ) {
        throw new Error("VM value must be plain JSON");
      }
      ancestors.add(current);
      stack.push({ value: current, depth: item.depth, exit: true });
      for (const [key, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(current),
      )) {
        if (!("value" in descriptor)) {
          throw new Error("VM JSON accessors are not allowed");
        }
        if (key === "toJSON" && typeof descriptor.value === "function") {
          throw new Error("VM JSON serializers are not allowed");
        }
        if (!descriptor.enumerable) {
          continue;
        }
        if (forbiddenKeys?.has(key)) {
          throw new Error("Dangerous Workflow JSON key");
        }
        stack.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    } else if (!(
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean" ||
      (typeof current === "number" && Number.isFinite(current))
    )) {
      throw new Error("VM value must be JSON");
    }
  }
  if (JSON.stringify(value).length > maxChars) {
    throw new Error("VM JSON size limit exceeded");
  }
}

export const VmJsonSchema = z.custom<unknown>((value) => {
  try {
    assertBoundedVmJson(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid or oversized VM JSON");
export const VmJsonObjectSchema = z.custom<Record<string, unknown>>(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    VmJsonSchema.safeParse(value).success,
);
