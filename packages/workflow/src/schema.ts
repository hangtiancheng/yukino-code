import { z } from "zod";

import { MAX_CONCURRENCY_CAP, RUN_ID_RE } from "./constants.js";

export const workflowInputSchema = z
  .object({
    script: z
      .string()
      .min(1)
      .optional()
      .describe("Self-contained plain JavaScript workflow source."),
    name: z
      .string()
      .min(1)
      .optional()
      .describe("Named workflow in .yukino/workflows/<name>.js|mjs|ts."),
    scriptPath: z
      .string()
      .min(1)
      .optional()
      .describe("Path to a workflow script file."),
    args: z
      .json()
      .optional()
      .describe(
        "Actual JSON input passed to the script, never stringified JSON.",
      ),
    resumeFromRunId: z
      .string()
      .regex(RUN_ID_RE)
      .optional()
      .describe(
        "Resume a prior run using its saved script, arguments and journal; source and arguments may be overridden.",
      ),
    description: z
      .string()
      .optional()
      .describe("Short description of this invocation."),
    title: z.string().optional().describe("Progress viewer title."),
    maxConcurrency: z
      .number()
      .int()
      .min(1)
      .max(MAX_CONCURRENCY_CAP)
      .optional()
      .describe(
        "Concurrent agents, default 3, maximum 16. Honor the user's requested concurrency.",
      ),
  })
  .superRefine((input, context) => {
    const sources = [input.script, input.name, input.scriptPath].filter(
      (value) => value !== undefined,
    ).length;
    if (sources > 1 || (sources === 0 && !input.resumeFromRunId)) {
      context.addIssue({
        code: "custom",
        message:
          "Provide exactly one of script, name or scriptPath, or resumeFromRunId to reuse a saved script.",
      });
    }
  });
export type WorkflowInput = z.infer<typeof workflowInputSchema>;

export const agentRunParamsSchema = z.object({
  prompt: z.string(),
  schema: z.record(z.string(), z.json()).optional(),
  model: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  agentType: z.string().optional(),
  isolation: z.literal("worktree").optional(),
  allowedTools: z.array(z.string()).optional(),
  label: z.string().optional(),
  phase: z.string().optional(),
});
export const journalEntrySchema = z.object({
  key: z.string(),
  seq: z.number().int().nonnegative(),
  result: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("ok"),
      output: z.unknown(),
      usage: z.object({ outputTokens: z.number().nonnegative() }),
      model: z.string().optional(),
      toolCount: z.number().optional(),
      tokenCount: z.number().optional(),
    }),
    z.object({ kind: z.literal("skipped") }),
    z.object({
      kind: z.literal("dead"),
      reason: z
        .enum([
          "no-structured-output",
          "invalid-structured-output",
          "run-agent-threw",
          "worktree-failed",
          "unknown",
        ])
        .optional(),
      detail: z.string().optional(),
    }),
  ]),
});
