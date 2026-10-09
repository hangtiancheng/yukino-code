import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import { Agent } from "@/agent/index.js";
import * as git from "@/code-review/git.js";
import * as grouping from "@/code-review/grouping.js";
import { runCodeReview } from "@/code-review/runner.js";
import type { FileDiff, ReviewToolEvent } from "@/code-review/types.js";
import type { ProviderConfig } from "@/config/provider-config.js";
import * as llm from "@/llm/client.js";
import { OpenAIClient } from "@/llm/openai.js";

const provider: ProviderConfig = {
  name: "test",
  protocol: "openai",
  base_url: "https://example.invalid",
  api_key: "test",
  model: "test",
};

const client = new OpenAIClient(provider, "system");

function makeDiff(path: string): FileDiff {
  return {
    oldPath: path,
    newPath: path,
    diffText: `diff --git a/${path} b/${path}\n`,
    hunks: [],
    isBinary: false,
    isDeleted: false,
    isNew: false,
    isRenamed: false,
    insertions: 1,
    deletions: 0,
  };
}

function events(...items: AgentEvent[]): AsyncGenerator<AgentEvent> {
  return (async function* () {
    await Promise.resolve();
    for (const item of items) {
      yield item;
    }
  })();
}

function mockReviewSetup(diffs: FileDiff[]): void {
  vi.spyOn(git, "collectDiffs").mockResolvedValue(diffs);
  vi.spyOn(grouping, "groupDiffs").mockResolvedValue(
    diffs.map((diff, index) => ({
      label: `group-${String(index)}`,
      diffs: [diff],
    })),
  );
  vi.spyOn(llm, "createClient").mockResolvedValue(client);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("code review tool events", () => {
  it("forwards paired events with unique ids across concurrent groups", async () => {
    mockReviewSetup([makeDiff("a.ts"), makeDiff("b.ts")]);
    let invocation = 0;
    vi.spyOn(Agent.prototype, "run").mockImplementation(() => {
      const toolName = invocation++ === 0 ? "CodeComment" : "ReadFile";
      return events(
        {
          type: "tool_use",
          toolName,
          toolId: "same-provider-id",
          args: { path: "a.ts" },
        },
        { type: "stream_text", text: "internal output" },
        {
          type: "tool_result",
          toolName,
          toolId: "same-provider-id",
          output: "ok",
          isError: false,
          elapsed: 0.1,
        },
        { type: "loop_complete", stopReason: "end_turn" },
      );
    });
    const forwarded: ReviewToolEvent[] = [];

    await runCodeReview(
      {
        cwd: ".",
        maxConcurrency: 2,
        maxRounds: 1,
        skipFilter: true,
        onToolEvent: (event) => {
          forwarded.push(event);
        },
      },
      { provider },
    );

    expect(forwarded).toHaveLength(4);
    expect(forwarded.every((event) => event.type.startsWith("tool_"))).toBe(
      true,
    );
    const uses = forwarded.filter((event) => event.type === "tool_use");
    const results = forwarded.filter((event) => event.type === "tool_result");
    expect(new Set(uses.map((event) => event.toolId)).size).toBe(2);
    expect(results.map((event) => event.toolId).sort()).toEqual(
      uses.map((event) => event.toolId).sort(),
    );
  });

  it("completes a dangling tool card when an agent fails", async () => {
    mockReviewSetup([makeDiff("a.ts")]);
    vi.spyOn(Agent.prototype, "run").mockImplementation(() =>
      (async function* () {
        await Promise.resolve();
        yield {
          type: "tool_use",
          toolName: "CodeComment",
          toolId: "dangling",
          args: {},
        } satisfies AgentEvent;
        throw new Error("provider failed");
      })(),
    );
    const forwarded: ReviewToolEvent[] = [];

    await runCodeReview(
      {
        cwd: ".",
        maxRounds: 1,
        skipFilter: true,
        onToolEvent: (event) => {
          forwarded.push(event);
        },
      },
      { provider },
    );

    expect(forwarded).toHaveLength(2);
    expect(forwarded[0]?.type).toBe("tool_use");
    expect(forwarded[1]).toEqual(
      expect.objectContaining({
        type: "tool_result",
        toolName: "CodeComment",
        toolId: forwarded[0]?.toolId,
        isError: true,
      }),
    );
  });
});
