import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultRegistry, resolve } from "@/commands/commands.js";
import { CommandUsageTracker } from "@/commands/usage-tracker.js";
import {
  compactActivity,
  getCommandUsage,
  recordInput,
} from "@/history/index.js";

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
    now += 8 * 86_400_000;
    record("status");
    const tracker = new CommandUsageTracker();
    expect(getCommandUsage().help.usageCount).toBe(2);
    expect(tracker.getRecentlyUsed()).toEqual(["status", "help"]);
    compactActivity();
    expect(new CommandUsageTracker().getRecentlyUsed()).toEqual([
      "status",
      "help",
    ]);
    expect(getCommandUsage().help.usageCount).toBe(2);
  });
});
