import { z } from "zod";

import { VM_MAX_SOURCE_CHARS } from "@/code-mode/constants.js";
import { VmJsonSchema } from "@/code-mode/schema.js";
import {
  MAX_CONCURRENCY_CAP,
  RUN_ID_RE,
  WORKFLOW_JOURNAL_FORMAT,
  WORKFLOW_MAX_ARGS_CHARS,
} from "@/workflow/constants.js";

export const workflowInputSchema = z
  .object({
    script: z
      .string()
      .min(1)
      .max(VM_MAX_SOURCE_CHARS)
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
      .refine(
        (value) => JSON.stringify(value).length <= WORKFLOW_MAX_ARGS_CHARS,
        "Workflow args limit exceeded",
      )
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

export const agentRunParamsSchema = z.strictObject({
  prompt: z.string().min(1).max(WORKFLOW_MAX_ARGS_CHARS),
  schema: z.record(z.string(), z.json()).optional(),
  model: z.string().min(1).max(256).optional(),
  maxTokens: z.number().int().positive().max(1_000_000).optional(),
  agentType: z.string().min(1).max(256).optional(),
  isolation: z.literal("worktree").optional(),
  allowedTools: z
    .array(z.string().min(1).max(256))
    .max(2000)
    .refine(
      (names) => new Set(names).size === names.length,
      "Duplicate allowed tool",
    )
    .optional(),
  label: z.string().max(1000).optional(),
  phase: z.string().min(1).max(1000).optional(),
});
export const agentRunResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    output: z.unknown(),
    usage: z.object({ outputTokens: z.number().nonnegative() }),
    model: z.string().optional(),
    toolCount: z.number().optional(),
    tokenCount: z.number().optional(),
  }),
  z.object({
    kind: z.literal("skipped"),
    usage: z.object({ outputTokens: z.number().nonnegative() }).optional(),
  }),
  z.object({
    kind: z.literal("dead"),
    usage: z.object({ outputTokens: z.number().nonnegative() }).optional(),
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
]);

const jsonValue = VmJsonSchema;
const workflowOutcomeSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    value: z.strictObject({
      data: jsonValue,
      budgetSpent: z.number().nonnegative(),
    }),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.string(),
    budgetSpent: z.number().nonnegative(),
  }),
]);
const workflowResultSchema = z.strictObject({
  status: z.enum(["completed", "failed", "killed"]),
  returnValue: jsonValue.optional(),
  error: z.string().optional(),
  partial: z.array(jsonValue).optional(),
});
const scope = z.string().min(1).max(1000);
const id = z.number().int().positive();
export const journalEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("header"),
    format: z.literal(WORKFLOW_JOURNAL_FORMAT),
    scope,
    fingerprint: z.string(),
    source: z.string().max(VM_MAX_SOURCE_CHARS),
    args: jsonValue,
    environment: z.strictObject({
      cwd: z.string(),
      maxConcurrency: z.number(),
      budgetTotal: z.number().nullable(),
      declarations: z.string(),
    }),
    runtime: z.string(),
    startedAt: z.number(),
    deadline: z.number(),
    budgetSpent: z.number().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("call"),
    scope,
    call: z.strictObject({
      id,
      name: z.enum(["agent", "workflow", "phase", "log"]),
      args: z.record(z.string(), jsonValue),
    }),
  }),
  z.strictObject({ kind: z.literal("started"), scope, id }),
  z.strictObject({
    kind: z.literal("outcome"),
    scope,
    id,
    seq: id,
    now: z.number(),
    outcome: workflowOutcomeSchema,
  }),
  z.strictObject({
    kind: z.literal("idle"),
    scope,
    seq: z.number().int().nonnegative(),
    issued: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("invalidate"),
    scope,
    from: id,
    reason: z.string(),
  }),
  z.strictObject({
    kind: z.literal("final"),
    scope,
    result: workflowResultSchema,
  }),
]);
export type JournalEntry = z.infer<typeof journalEntrySchema>;
