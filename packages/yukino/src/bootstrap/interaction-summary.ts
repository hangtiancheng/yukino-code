export interface InteractionSummary {
  agentActiveMs: number;
  /** Prompt tokens written to the provider's cache. */
  cacheCreationTokens: number;
  /** Prompt tokens served from the provider's cache. */
  cacheReadTokens: number;
  failedToolCalls: number;
  /** Uncached prompt tokens; the cached prefix is counted separately. */
  inputTokens: number;
  latestVersion?: string;
  outputTokens: number;
  sessionId: string;
  startedAt: number;
  successfulToolCalls: number;
  toolTimeMs: number;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) {
    return `${String(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes)}m ${String(remainder)}s`;
}

function formatTokens(value: number): string {
  const tokens = Math.max(0, Math.round(value));
  if (tokens < 1000) {
    return String(tokens);
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function percentage(value: number, total: number): string {
  return `${(total > 0 ? (value / total) * 100 : 0).toFixed(1)}%`;
}

export function formatInteractionSummary(
  summary: InteractionSummary,
  endedAt = Date.now(),
): string {
  const totalToolCalls = summary.successfulToolCalls + summary.failedToolCalls;
  const apiTimeMs = Math.max(0, summary.agentActiveMs - summary.toolTimeMs);
  const successRate =
    totalToolCalls > 0
      ? (summary.successfulToolCalls / totalToolCalls) * 100
      : 0;
  const promptTokens =
    summary.inputTokens + summary.cacheReadTokens + summary.cacheCreationTokens;
  const cacheHitRate = percentage(summary.cacheReadTokens, promptTokens);

  return [
    `### Session \`${summary.sessionId}\``,
    [
      `**Tools** ${String(totalToolCalls)} calls · ✓ ${String(summary.successfulToolCalls)} · ✗ ${String(summary.failedToolCalls)} · ${successRate.toFixed(1)}% success`,
      `**Time** ${formatDuration(endedAt - summary.startedAt)} wall · ${formatDuration(summary.agentActiveMs)} active`,
      `**Breakdown** API ${formatDuration(apiTimeMs)} (${percentage(apiTimeMs, summary.agentActiveMs)}) · Tools ${formatDuration(summary.toolTimeMs)} (${percentage(summary.toolTimeMs, summary.agentActiveMs)})`,
      `**Tokens** ↑ ${formatTokens(summary.inputTokens)} input · ↓ ${formatTokens(summary.outputTokens)} output`,
      `**Cache** ${formatTokens(summary.cacheReadTokens)} read · ${formatTokens(summary.cacheCreationTokens)} write`,
      `**Cache hit** ${cacheHitRate} (${formatTokens(summary.cacheReadTokens)} of ${formatTokens(promptTokens)} prompt)`,
      `\`yukino --resume ${summary.sessionId}\``,
    ].join("  \n"),
  ].join("\n");
}
