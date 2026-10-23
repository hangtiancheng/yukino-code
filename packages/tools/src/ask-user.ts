import { safeParseAsync, z } from "zod";

import {
  OPERATION_INTERRUPTED_ERROR,
  QUESTION_COUNT_ERROR,
} from "./constants.js";
import {
  ASK_USER_MULTI_SELECT_DESCRIPTION,
  ASK_USER_OPTION_DESCRIPTION_DESCRIPTION,
  ASK_USER_OPTION_LABEL_DESCRIPTION,
  ASK_USER_OPTIONS_DESCRIPTION,
  ASK_USER_QUESTION_DESCRIPTION,
  ASK_USER_QUESTION_TEXT_DESCRIPTION,
  ASK_USER_QUESTIONS_DESCRIPTION,
} from "./prompts.js";
import type {
  Tool,
  ToolCategory,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "./types.js";

const QuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});

export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

const QuestionSchema = z.strictObject({
  question: z.string(),
  options: z.array(QuestionOptionSchema),
  multiSelect: z.boolean(),
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
export class AskUserQuestionTool implements Tool {
  // Use a hardcoded string instead of AskUserQuestionTool.name.replace("Tool", "")
  // because class names are not stable after minification — bundlers like
  // Terser/esbuild may rename or mangle them, producing incorrect tool names at runtime.
  name = "AskUserQuestion";

  description = ASK_USER_QUESTION_DESCRIPTION;

  category: ToolCategory = "read";
  constructor(private ask: Asker) {}

  schema(): ToolSchema {
    const inputSchema = {
      type: "object" as const,
      properties: {
        questions: {
          type: "array" as const,
          description: ASK_USER_QUESTIONS_DESCRIPTION,
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object" as const,
            properties: {
              question: {
                type: "string" as const,
                description: ASK_USER_QUESTION_TEXT_DESCRIPTION,
              },
              options: {
                type: "array" as const,
                description: ASK_USER_OPTIONS_DESCRIPTION,
                minItems: 2,
                maxItems: 4,
                items: {
                  type: "object" as const,
                  properties: {
                    label: {
                      type: "string" as const,
                      description: ASK_USER_OPTION_LABEL_DESCRIPTION,
                    },
                    description: {
                      type: "string" as const,
                      description: ASK_USER_OPTION_DESCRIPTION_DESCRIPTION,
                    },
                  },
                  required: ["label"],
                },
              },
              multiSelect: {
                type: "boolean" as const,
                description: ASK_USER_MULTI_SELECT_DESCRIPTION,
              },
            },
            required: ["question", "options", "multiSelect"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
    };

    return {
      name: this.name,
      description: this.description,
      input_schema: inputSchema,
    };
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const {
      success,
      data: argsData,
      error,
    } = await safeParseAsync(
      z.object({ questions: z.array(QuestionSchema) }),
      args,
    );
    if (!success) {
      return {
        output: error.message,
        isError: true,
      };
    }

    const questions = argsData.questions;
    if (
      !Array.isArray(questions) ||
      questions.length < 1 ||
      questions.length > 4
    ) {
      return { output: QUESTION_COUNT_ERROR, isError: true };
    }

    for (const q of questions) {
      if (
        !Array.isArray(q.options) ||
        q.options.length < 2 ||
        q.options.length > 4
      ) {
        return {
          output: `Error: question '${q.question}' must have 2-4 options`,
          isError: true,
        };
      }
    }

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
