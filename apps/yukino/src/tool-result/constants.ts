// Aggregate cap across all tool results within a single message. The size of
// an individual result is gated by MAX_OUTPUT_CHARS in the agent; what we
// manage here is the aggregate. When a turn fans out to several tools in
// parallel, each result can stay under the per-result threshold while their
// sum still blows up the context — a case the per-result threshold cannot
// catch.
export const MESSAGE_AGGREGATE_LIMIT = 200000;
export const TOOL_RESULT_PREVIEW_CHARS = 2000;
