export const COST_FORMAT = "yukino.execution-ledger.v2";
export const COST_DIRECTORY = "cost";
export const TOKENS_PER_PRICE_UNIT = 1_000_000;
export const MAX_REQUEST_RETRIES = 3;
export const DEFAULT_REQUEST_RETRIES = 0;
export const REQUEST_RETRY_DELAY_MS = 250;
export const MAX_REQUEST_RETRY_DELAY_MS = 30_000;
export const EXECUTION_PURPOSES = [
  "main",
  "subagent",
  "teammate",
  "workflow",
  "memory",
  "compaction",
  "branch_summary",
  "cache_warming",
] as const;
