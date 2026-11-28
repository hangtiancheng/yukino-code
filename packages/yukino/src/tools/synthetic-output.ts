import { z } from "zod";

import { OUTPUT_REQUIRED_ERROR } from "@/tools/constants.js";
import {
  SYNTHETIC_OUTPUT_DESCRIPTION,
  SYNTHETIC_OUTPUT_OUTPUT_DESCRIPTION,
} from "@/tools/prompts.js";
import { validateAgainstSchema } from "@/tools/schema.js";
import type { ToolCategory, ToolContext, ToolResult } from "@/tools/types.js";
import { ValidatedTool } from "@/tools/validated-tool.js";
import { asErrorString } from "@/utils/index.js";

/**
 * Lets the Agent deliver its final result as structured data. In
 * non-interactive mode and coordinator mode, callers want JSON they can parse
 * directly, not a snippet of text buried inside natural language.
 */
const SyntheticOutputToolInputSchema = z.strictObject({
  output: z.json().describe(SYNTHETIC_OUTPUT_OUTPUT_DESCRIPTION),
});

export class SyntheticOutputTool extends ValidatedTool<
  z.output<typeof SyntheticOutputToolInputSchema>
> {
  name = "SyntheticOutput";
  description = SYNTHETIC_OUTPUT_DESCRIPTION;
  category: ToolCategory = "read";

  /** jsonSchema is optional; when set, output is validated against the structure agreed with the caller. */
  constructor(private jsonSchema?: Record<string, unknown>) {
    super();
  }

  parameters() {
    return SyntheticOutputToolInputSchema;
  }

  protected executeValidated(
    _ctx: ToolContext,
    args: z.output<typeof SyntheticOutputToolInputSchema>,
  ): Promise<ToolResult> {
    if (!("output" in args)) {
      return Promise.resolve({
        output: OUTPUT_REQUIRED_ERROR,
        isError: true,
      });
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
      return Promise.resolve({
        output: JSON.stringify(output, null, 2),
        isError: false,
      });
    } catch (e) {
      return Promise.resolve({
        output: `Error: output is not serializable: ${asErrorString(e)}`,
        isError: true,
      });
    }
  }

  private validateSchema(data: unknown): string {
    if (!this.jsonSchema) {
      return "";
    }
    return validateAgainstSchema(data, this.jsonSchema).errors.join("; ");
  }
}
