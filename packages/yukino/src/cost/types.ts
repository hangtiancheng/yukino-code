import { z } from "zod";

import { ProviderPriceSchema } from "@/config/provider-config.js";
import { COST_FORMAT, EXECUTION_PURPOSES } from "@/cost/constants.js";

export const MoneySchema = z.strictObject({
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable(),
  amount: z.number().nonnegative().nullable(),
});
export type Money = z.infer<typeof MoneySchema>;
export type ExecutionPurpose = (typeof EXECUTION_PURPOSES)[number];

export const UsageSnapshotSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  cacheCreationByTTL: z
    .record(z.string(), z.number().int().nonnegative())
    .optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

export const RunRelationSchema = z
  .strictObject({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    parentRunId: z.string().min(1).optional(),
  })
  .refine((run) => run.runId !== run.parentRunId, {
    error: "Execution run cannot parent itself",
  });
export type RunRelation = z.infer<typeof RunRelationSchema>;

export const CostEntrySchema = z.strictObject({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  parentRunId: z.string().min(1).optional(),
  agentId: z.string().min(1),
  purpose: z.enum(EXECUTION_PURPOSES),
  requestId: z.uuid(),
  attemptId: z.uuid(),
  attempt: z.number().int().nonnegative(),
  provider: z.strictObject({
    name: z.string(),
    endpoint: z.string(),
    model: z.string(),
    protocol: z.string(),
  }),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  outcome: z.enum(["pending", "completed", "error", "aborted", "incomplete"]),
  usage: UsageSnapshotSchema.nullable(),
  usageComplete: z.boolean(),
  price: ProviderPriceSchema.nullable(),
  estimate: MoneySchema,
  providerAmount: MoneySchema.nullable(),
  cacheTTLSeconds: z.number().int().positive().optional(),
  cacheIdentity: z.string().optional(),
});
export type CostEntry = z.infer<typeof CostEntrySchema>;
export type EntryFilter = Partial<
  Pick<
    CostEntry,
    "sessionId" | "runId" | "parentRunId" | "agentId" | "purpose" | "requestId"
  >
> & { includeDescendants?: boolean };

export const LedgerRecordSchema = z.discriminatedUnion("type", [
  z.strictObject({
    format: z.literal(COST_FORMAT),
    revision: z.number().int().positive(),
    type: z.literal("run"),
    run: RunRelationSchema,
  }),
  z.strictObject({
    format: z.literal(COST_FORMAT),
    revision: z.number().int().positive(),
    type: z.literal("attempt"),
    entry: CostEntrySchema,
  }),
]);
export type LedgerRecord = z.infer<typeof LedgerRecordSchema>;

export interface CostSummary {
  attempts: number;
  requests: number;
  incompleteAttempts: number;
  usage: UsageSnapshot;
  estimated: Record<
    string,
    { amount: number | null; knownAmount: number; unknownAttempts: number }
  >;
  providerReported: Record<
    string,
    { amount: number | null; knownAmount: number; unknownAttempts: number }
  >;
  unknownCurrencyEstimates: number;
  unknownProviderAmounts: number;
}
