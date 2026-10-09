import { stripVTControlCharacters } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { InteractionSummary } from "@/bootstrap/interaction-summary.js";
import { renderInteractionSummary } from "@/ui/interaction-summary.js";
import { setThemeMode, THEME } from "@/ui/styles.js";
import { visibleWidth } from "@/ui/terminal-text.js";

const summary: InteractionSummary = {
  agentActiveMs: 10_000,
  cacheCreationTokens: 2_000,
  cacheReadTokens: 8_000,
  failedToolCalls: 1,
  inputTokens: 2_000,
  outputTokens: 500,
  sessionId: "session-123",
  startedAt: 1_000,
  successfulToolCalls: 3,
  toolTimeMs: 4_000,
};

afterEach(() => {
  setThemeMode("dark");
});

describe("interaction summary", () => {
  it("prints session, tool, and timing metrics with a resume command", () => {
    const output = renderInteractionSummary(summary, {
      color: false,
      columns: 80,
      endedAt: 16_000,
    });

    expect(output).toContain("Session session-123");
    expect(output).toContain("4 calls · ✓ 3 · ✗ 1 · 75.0% success");
    expect(output).toContain("15s wall · 10s active");
    expect(output).toContain("API 6s (60.0%) · Tools 4s (40.0%)");
    expect(output).toContain("↑ 2.0k input · ↓ 500 output");
    expect(output).toContain("8.0k read · 2.0k write");
    expect(output).toContain("66.7% (8.0k of 12k prompt)");
    expect(output).toContain("yukino --resume session-123");
    expect(output).not.toContain("yukino update");
    expect(output).not.toMatch(/\x1b|\*\*|`|###/u);
  });

  it.each([false, true])(
    "prints an available update on the last line with color=%s",
    (color) => {
      const output = renderInteractionSummary(
        { ...summary, latestVersion: "999.0.0" },
        { color, columns: 100, endedAt: 16_000 },
      );
      const lines = stripVTControlCharacters(output).split("\n");
      expect(lines.at(-1)?.trim()).toBe(
        "New Yukino version v999.0.0 is available. Run yukino update",
      );
      expect(lines.at(-2)).toBe("─".repeat(100));
      if (!color) {
        expect(output).not.toContain("\x1b");
      }
    },
  );

  it("prints zero rates when no tools or agent work occurred", () => {
    const output = renderInteractionSummary(
      {
        agentActiveMs: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        failedToolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        sessionId: "empty",
        startedAt: 1_000,
        successfulToolCalls: 0,
        toolTimeMs: 0,
      },
      { color: false, columns: 80, endedAt: 1_000 },
    );

    expect(output).toContain("0 calls · ✓ 0 · ✗ 0 · 0.0% success");
    expect(output).toContain("0s wall · 0s active");
    expect(output).toContain("API 0s (0.0%) · Tools 0s (0.0%)");
    expect(output).toContain("0.0% (0 of 0 prompt)");
  });

  it("reports cache write tokens when nothing was served from cache", () => {
    const output = renderInteractionSummary(
      {
        agentActiveMs: 1_000,
        cacheCreationTokens: 20_000,
        cacheReadTokens: 0,
        failedToolCalls: 0,
        inputTokens: 5_000,
        outputTokens: 0,
        sessionId: "cold",
        startedAt: 0,
        successfulToolCalls: 0,
        toolTimeMs: 0,
      },
      { color: false, columns: 80, endedAt: 1_000 },
    );

    expect(output).toContain("0.0% (0 of 25k prompt)");
    expect(output).toContain("0 read · 20k write");
  });

  it("scales token formatting from raw counts to millions", () => {
    const output = renderInteractionSummary(
      {
        agentActiveMs: 1_000,
        cacheCreationTokens: 1_000_000,
        cacheReadTokens: 2_500_000,
        failedToolCalls: 0,
        inputTokens: 999,
        outputTokens: 0,
        sessionId: "big",
        startedAt: 0,
        successfulToolCalls: 0,
        toolTimeMs: 0,
      },
      { color: false, columns: 80, endedAt: 1_000 },
    );

    expect(output).toContain("999 input");
    expect(output).toContain("2.5M read · 1.0M write");
    expect(output).toContain("71.4% (2.5M of 3.5M prompt)");
  });

  it.each([1, 2, 3, 10, 20, 40, 80, 160])(
    "keeps all content within a %i-column terminal without truncating the resume command",
    (columns) => {
      const sessionId = "muuxygb5-4929a904";
      const output = renderInteractionSummary(
        { ...summary, sessionId, latestVersion: "999.0.0" },
        { color: true, columns, endedAt: 16_000 },
      );

      expect(
        output.split("\n").every((line) => visibleWidth(line) <= columns),
      ).toBe(true);
      const text = stripVTControlCharacters(output).replace(/\s/gu, "");
      expect(text).toContain(`yukino--resume${sessionId}`);
      expect(text).toContain("API6s(60.0%)");
      expect(text).toContain("66.7%(8.0kof12kprompt)");
      expect(text).toContain(
        "NewYukinoversionv999.0.0isavailable.Runyukinoupdate",
      );
      expect(text).not.toContain("…");
    },
  );

  it.each(["dark", "light"] as const)(
    "uses the active %s theme for Markdown and borders",
    (theme) => {
      setThemeMode(theme);
      const output = renderInteractionSummary(summary, {
        color: true,
        columns: 80,
        endedAt: 16_000,
      });

      for (const value of [THEME.borderMuted, THEME.mdHeading, THEME.mdCode]) {
        const rgb = [1, 3, 5].map((offset) =>
          Number.parseInt(value.slice(offset, offset + 2), 16),
        );
        expect(output).toContain(`\x1b[38;2;${rgb.join(";")}m`);
      }
      expect(output).toContain("\x1b[1m");
    },
  );
});
