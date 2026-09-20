/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { Tool, ToolCategory, ToolContext, ToolResult, ToolSchema } from "./types.js";

import { asErrorString } from "@/utils/index.js";

/**
 * Lets the Agent deliver its final result as structured data. In
 * non-interactive mode and coordinator mode, callers want JSON they can parse
 * directly, not a snippet of text buried inside natural language.
 */
export class SyntheticOutputTool implements Tool {
  name = "SyntheticOutput";
  description =
    "Return structured output in JSON format. Use this tool to return your final response " +
    "as structured data in non-interactive or coordinator mode sessions.";
  category: ToolCategory = "read";

  /** jsonSchema is optional; when set, output is validated against the structure agreed with the caller. */
  constructor(private jsonSchema?: Record<string, unknown>) {}

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          output: {
            description: "The structured result: an object, an array, or a plain string",
          },
        },
        required: ["output"],
      },
    };
  }

  execute(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    if (!("output" in args)) {
      return Promise.resolve({ output: "Error: output is required", isError: true });
    }
    const output = args.output;

    const err = this.validateSchema(output);
    if (err) {
      return Promise.resolve({
        output: `Output does not match required schema: ${err}`,
        isError: true,
      });
    }

    // Return strings as-is, without a second JSON wrapping
    if (typeof output === "string") {
      return Promise.resolve({ output, isError: false });
    }

    try {
      return Promise.resolve({ output: JSON.stringify(output, null, 2), isError: false });
    } catch (e) {
      return Promise.resolve({
        output: `Error: output is not serializable: ${asErrorString(e)}`,
        isError: true,
      });
    }
  }

  /**
   * Only covers top-level type and required fields; an empty return string
   * means it passed. Full JSON Schema validation is unnecessary here — what
   * we guard against is the model delivering a structurally malformed result.
   */
  private validateSchema(data: unknown): string {
    if (!this.jsonSchema) {
      return "";
    }

    const expected = this.jsonSchema.type;
    if (typeof expected === "string") {
      const isArray = Array.isArray(data);
      const isObject = typeof data === "object" && data !== null && !isArray;
      if (expected === "object" && !isObject) {
        return `Expected object, got ${isArray ? "array" : typeof data}`;
      }
      if (expected === "array" && !isArray) {
        return `Expected array, got ${typeof data}`;
      }
      if (expected === "string" && typeof data !== "string") {
        return `Expected string, got ${isArray ? "array" : typeof data}`;
      }
    }

    const required = this.jsonSchema.required;
    if (
      Array.isArray(required) &&
      typeof data === "object" &&
      data !== null &&
      !Array.isArray(data)
    ) {
      const missing = required.filter((k): k is string => typeof k === "string" && !(k in data));
      if (missing.length > 0) {
        return `Missing required fields: ${missing.join(", ")}`;
      }
    }

    return "";
  }
}
