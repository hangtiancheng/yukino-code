import {
  createDefaultRegistry,
  resolve,
} from "@yukino.js/commands/commands.js";
import { CommandUsageTracker } from "@yukino.js/commands/usage-tracker.js";
import {
  compactActivity,
  getCommandUsage,
  recordInput,
} from "@yukino.js/history";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("command activity", () => {
  it("resolves shorthand and case before recording canonical command names", () => {
    const registry = createDefaultRegistry();
    expect(resolve("/HELP", registry)?.command?.name).toBe("help");
    expect(resolve("/skill reload", registry)?.command?.name).toBe("skills");
    expect(resolve("/skill review 20", registry)).toMatchObject({
      name: "review",
      args: "20",
    });
    expect(resolve("/unknown", registry)?.command).toBeUndefined();
  });

  it("keeps usage frequency and recency scores after checkpointing", () => {
    let now = 1_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const record = (commandName: string | null) =>
      recordInput({
        cwd: process.cwd(),
        sessionId: null,
        source: "cli",
        text: commandName ? `/${commandName}` : "ordinary",
        commandName,
      });
    record("help");
    record("help");
    record(null);
    now += 7 * 86_400_000;
    record("status");
    const tracker = new CommandUsageTracker();
    expect(tracker.getScore("help")).toBe(1);
    expect(tracker.getScore("missing")).toBe(0);
    expect(getCommandUsage().help.usageCount).toBe(2);
    const ranked = tracker.getRecentlyUsed();
    compactActivity();
    expect(new CommandUsageTracker().getRecentlyUsed()).toEqual(ranked);
    expect(getCommandUsage().help.usageCount).toBe(2);
  });
});
