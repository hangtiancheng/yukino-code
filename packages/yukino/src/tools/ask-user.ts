import { z } from "zod";

import { OPERATION_INTERRUPTED_ERROR } from "@/tools/constants.js";
import {
  ASK_USER_MULTI_SELECT_DESCRIPTION,
  ASK_USER_OPTION_DESCRIPTION_DESCRIPTION,
  ASK_USER_OPTION_LABEL_DESCRIPTION,
  ASK_USER_OPTIONS_DESCRIPTION,
  ASK_USER_QUESTION_DESCRIPTION,
  ASK_USER_QUESTION_TEXT_DESCRIPTION,
  ASK_USER_QUESTIONS_DESCRIPTION,
} from "@/tools/prompts.js";
import type { ToolCategory, ToolContext, ToolResult } from "@/tools/types.js";
import { ValidatedTool } from "@/tools/validated-tool.js";

const QuestionOptionSchema = z.strictObject({
  label: z.string().describe(ASK_USER_OPTION_LABEL_DESCRIPTION),
  description: z
    .string()
    .describe(ASK_USER_OPTION_DESCRIPTION_DESCRIPTION)
    .optional(),
});
const QuestionSchema = z.strictObject({
  question: z.string().describe(ASK_USER_QUESTION_TEXT_DESCRIPTION),
  options: z
    .array(QuestionOptionSchema)
    .min(2)
    .max(4)
    .describe(ASK_USER_OPTIONS_DESCRIPTION),
  multiSelect: z.boolean().describe(ASK_USER_MULTI_SELECT_DESCRIPTION),
});

export type Question = z.infer<typeof QuestionSchema>;

// Maps each question text to the user's chosen answer (labels joined for multi-select, or free text for "Other")

export type Asker = (
  questions: Question[],
  signal?: AbortSignal,
) => Promise<
  Record<string /** question text */, string /** user chosen answer */>
>;

// Structured single/multiple-choice question tool
// The actual prompting is delegated to an injected asker (the UI dialog),
// the same pattern as onPermissionRequest
const AskUserQuestionToolInputSchema = z.strictObject({
  questions: z
    .array(QuestionSchema)
    .min(1)
    .max(4)
    .describe(ASK_USER_QUESTIONS_DESCRIPTION),
});

export class AskUserQuestionTool extends ValidatedTool<
  z.output<typeof AskUserQuestionToolInputSchema>
> {
  // Use a hardcoded string instead of AskUserQuestionTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "AskUserQuestion";

  description = ASK_USER_QUESTION_DESCRIPTION;

  category: ToolCategory = "read";
  constructor(private ask: Asker) {
    super();
  }

  parameters() {
    return AskUserQuestionToolInputSchema;
  }

  protected async executeValidated(
    ctx: ToolContext,
    args: z.output<typeof AskUserQuestionToolInputSchema>,
  ): Promise<ToolResult> {
    const questions = args.questions;
    if (ctx.abortSignal?.aborted) {
      return { output: OPERATION_INTERRUPTED_ERROR, isError: true };
    }
    const answer = await this.ask(questions, ctx.abortSignal);
    if (Object.keys(answer).length === 0) {
      return {
        output: "User cancelled or did not answer the questions.",
        isError: true,
      };
    }
    const parts = Object.entries(answer).map(([q, a]) => `"${q}" = "${a}"`);

    return {
      output: `User has answered your questions: ${parts.join(", ")}. You can now continue with the user's answers`,
      isError: false,
    };
  }
}
