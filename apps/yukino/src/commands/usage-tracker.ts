import {
  COMMAND_RECENCY_HALF_LIFE_DAYS,
  COMMAND_MIN_RECENCY_WEIGHT,
  MILLISECONDS_PER_DAY,
} from "@/commands/constants.js";
import { getCommandUsage, type CommandUsage } from "@/history/index.js";

export class CommandUsageTracker {
  getScore(name: string): number {
    return this.score(getCommandUsage()[name], Date.now());
  }

  private score(entry: CommandUsage | undefined, now: number): number {
    if (!entry) {
      return 0;
    }
    const daysSince =
      Math.max(0, now - entry.lastUsedAt) / MILLISECONDS_PER_DAY;
    const recency = Math.pow(0.5, daysSince / COMMAND_RECENCY_HALF_LIFE_DAYS);
    return entry.usageCount * Math.max(recency, COMMAND_MIN_RECENCY_WEIGHT);
  }

  getRecentlyUsed(limit = 5): string[] {
    const now = Date.now();
    return Object.entries(getCommandUsage())
      .map(([name, entry]) => ({ name, score: this.score(entry, now) }))
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((e) => e.name);
  }
}
