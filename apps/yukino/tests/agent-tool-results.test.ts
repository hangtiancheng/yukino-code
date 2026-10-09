import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Agent } from "@/agent/index.js";
import { runExitCleanups } from "@/bootstrap/exit-cleanup.js";
import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import { PermissionChecker } from "@/permissions/index.js";
import { getSessionsDir, sessionPath } from "@/storage/paths.js";
import { ReadFileTool } from "@/tools/read-file.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool } from "@/tools/types.js";

const cwds: string[] = [];

function makeCwd() {
  const cwd = mkdtempSync(join(tmpdir(), "yukino-agent-results-"));
  cwds.push(cwd);
  return cwd;
}

afterEach(() => {
  runExitCleanups();
  for (const cwd of cwds.splice(0)) {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function outputTool(name: string, output: string): Tool {
  return {
    name,
    description: name,
    category: "read",
    schema: () => ({
      name,
      description: name,
      input_schema: { type: "object", properties: {} },
    }),
    execute: () => Promise.resolve({ output, isError: false }),
  };
}

async function runBatch(
  cwd: string,
  tools: Tool[],
  options: {
    conversation?: ConversationManager;
    args?: Record<string, unknown>;
    sessionId?: string;
  } = {},
) {
  const conversation = options.conversation ?? new ConversationManager();
  conversation.addUserMessage("run tools");
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }
  let requests = 0;
  const client: LLMClient = {
    setSystemPrompt: () => undefined,
    async *stream() {
      await Promise.resolve();
      if (requests++ === 0) {
        for (const tool of tools) {
          yield {
            type: "tool_call_complete",
            toolId: tool.name,
            toolName: tool.name,
            arguments: options.args ?? {},
          };
        }
      }
      yield {
        type: "stream_end",
        stopReason: "end_turn",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      };
    },
  };
  const agent = new Agent({
    client,
    registry,
    conversation,
    cwd,
    sessionId: options.sessionId,
    checker: new PermissionChecker(cwd, "bypassPermissions"),
  });
  const events = [];
  for await (const event of agent.run()) {
    events.push(event);
  }
  expect(events.at(-1)).toMatchObject({
    type: "loop_complete",
    stopReason: "end_turn",
  });
  const results =
    conversation.getMessages().findLast((message) => message.toolResults)
      ?.toolResults ?? [];
  return { conversation, results };
}

function spillPath(content: string) {
  const path = /Full content saved to:\n([^\n]+)/.exec(content)?.[1];
  if (!path) {
    throw new Error("Expected a persisted tool result");
  }
  return path;
}

describe("agent tool-result artifacts", () => {
  it("spills anonymous outputs into isolated namespaces without creating resumable sessions", async () => {
    const cwd = makeCwd();
    const firstOutput = "a".repeat(60_000);
    const secondOutput = "b".repeat(60_000);
    const [first, second] = await Promise.all([
      runBatch(cwd, [outputTool("Large", firstOutput)]),
      runBatch(cwd, [outputTool("Large", secondOutput)]),
    ]);
    const firstPath = spillPath(first.results[0]?.content ?? "");
    const secondPath = spillPath(second.results[0]?.content ?? "");
    expect(firstPath).not.toBe(secondPath);
    expect(readFileSync(firstPath, "utf8")).toBe(firstOutput);
    expect(readFileSync(secondPath, "utf8")).toBe(secondOutput);
    expect(existsSync(getSessionsDir(cwd))).toBe(false);
    runExitCleanups();
    expect(existsSync(dirname(firstPath))).toBe(false);
    expect(existsSync(dirname(secondPath))).toBe(false);
  });

  it("enforces the aggregate output budget for anonymous agents", async () => {
    const cwd = makeCwd();
    const { results } = await runBatch(
      cwd,
      Array.from({ length: 5 }, (_, index) =>
        outputTool(`Large${String(index)}`, "x".repeat(45_000)),
      ),
    );
    expect(
      results.reduce((total, result) => total + result.content.length, 0),
    ).toBeLessThanOrEqual(200_000);
    const persisted = results.find((result) =>
      result.content.includes("<persisted-output>"),
    );
    expect(readFileSync(spillPath(persisted?.content ?? ""), "utf8")).toBe(
      "x".repeat(45_000),
    );
  });

  it("allows spill readback in subsequent anonymous runs of the same conversation", async () => {
    const cwd = makeCwd();
    const first = await runBatch(cwd, [
      outputTool("Large", "x".repeat(51_000)),
    ]);
    const path = spillPath(first.results[0]?.content ?? "");
    const second = await runBatch(cwd, [new ReadFileTool()], {
      conversation: first.conversation,
      args: { file_path: path },
    });
    expect(second.results[0]?.content.length).toBeGreaterThan(50_000);
    expect(second.results[0]?.content).not.toContain("<persisted-output>");
    expect(second.results[0]?.content).toContain("x".repeat(51_000));
  });

  it("keeps explicit session artifacts after cleanup", async () => {
    const cwd = makeCwd();
    const { results } = await runBatch(
      cwd,
      [outputTool("Large", "x".repeat(60_000))],
      { sessionId: "persistent-session" },
    );
    const path = spillPath(results[0]?.content ?? "");
    expect(path).toBe(
      sessionPath("persistent-session", "tool-results", "Large.txt"),
    );
    runExitCleanups();
    expect(existsSync(path)).toBe(true);
  });
});
