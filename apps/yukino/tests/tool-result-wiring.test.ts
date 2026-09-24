/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import { Agent } from "@/agent/index.js";
import { RecoveryState } from "@/compact/recovery.js";
import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent, UsageInfo } from "@/llm/events.js";
import { PermissionChecker } from "@/permissions/index.js";
import { loadSession, rebuildFromSession } from "@/session/index.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool, ToolResultContentBlock } from "@/tools/types.js";
import { asString, isRecord } from "@/utils/index.js";

// Wiring test for the tool-result budget in the Agent main loop: drives the
// full main loop and verifies single-result spill, aggregate spill, readback
// exemption, and that what enters the conversation history is the final form.

const USAGE: UsageInfo = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};
const end = (reason = "end_turn"): StreamEvent => ({
  type: "stream_end",
  stopReason: reason,
  usage: USAGE,
});

class MockClient implements LLMClient {
  calls = 0;
  constructor(private scripts: StreamEvent[][]) {}
  setSystemPrompt(_prompt: string): void {
    /** noop */
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async *stream(): AsyncGenerator<StreamEvent> {
    const script = this.scripts[this.calls++] ?? [end()];
    for (const ev of script) {
      yield ev;
    }
  }
  setMaxOutputTokens(): void {
    /** noop */
  }
}

function fixedTool(name: string, output: string): Tool {
  return {
    name,
    description: "fixed output",
    category: "read",
    schema: () => ({
      name,
      description: "fixed",
      input_schema: { type: "object", properties: {} },
    }),
    execute: () => Promise.resolve({ output, isError: false }),
  };
}

async function runAgent(
  client: LLMClient,
  workDir: string,
  tools: Tool[],
  recoveryState?: RecoveryState,
) {
  const conv = new ConversationManager();
  conv.addUserMessage("go");
  const registry = new ToolRegistry();
  for (const t of tools) {
    registry.register(t);
  }
  const agent = new Agent({
    client,
    registry,
    checker: new PermissionChecker(workDir, "bypassPermissions"),
    conversation: conv,
    workDir,
    sessionId: "wiring",
    recoveryState,
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of agent.run()) {
    // drain
  }
  return conv;
}

function toolResultsMsg(conv: ConversationManager) {
  const msg = conv
    .getMessages()
    .find((m) => m.toolResults && m.toolResults.length > 0);
  expect(msg).toBeDefined();
  return msg;
}

const spillDirOf = (workDir: string) =>
  join(workDir, ".yukino", "sessions", "wiring", "tool-results");

describe("tool result budget wiring", () => {
  it("passes each concurrent tool its own call ID", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-wire-"));
    const seen = new Map<string, string | undefined>();
    const contextTool = (name: string): Tool => ({
      name,
      description: "captures context",
      category: "read",
      schema: () => ({
        name,
        description: "captures context",
        input_schema: { type: "object", properties: {} },
      }),
      execute: (context) => {
        seen.set(name, context.toolCallId);
        return Promise.resolve({ output: "done", isError: false });
      },
    });
    const client = new MockClient([
      [
        {
          type: "tool_call_complete",
          toolId: "call-a",
          toolName: "ToolA",
          arguments: {},
        },
        {
          type: "tool_call_complete",
          toolId: "call-b",
          toolName: "ToolB",
          arguments: {},
        },
        end("tool_use"),
      ],
      [end()],
    ]);

    await runAgent(client, workDir, [
      contextTool("ToolA"),
      contextTool("ToolB"),
    ]);

    expect(seen).toEqual(
      new Map([
        ["ToolA", "call-a"],
        ["ToolB", "call-b"],
      ]),
    );
  });

  it("spills a single oversized result at ingest", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-wire-"));
    const client = new MockClient([
      [
        {
          type: "tool_call_complete",
          toolId: "t1",
          toolName: "BigTool",
          arguments: {},
        },
        end("tool_use"),
      ],
      [{ type: "text_delta", text: "done" }, end()],
    ]);

    const conv = await runAgent(client, workDir, [
      fixedTool("BigTool", "x".repeat(60000)),
    ]);

    // What enters history is the preview, not the original text
    const tr = toolResultsMsg(conv)?.toolResults?.[0];
    expect(tr?.content).toContain("<persisted-output>");
    // The spill file stores the complete original text
    const spilled = readFileSync(join(spillDirOf(workDir), "t1.txt"), "utf-8");
    expect(spilled.length).toBe(60000);
  });

  it("exempts readbacks of spill files", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-wire-"));
    const readbackPath = join(spillDirOf(workDir), "toolu_old.txt");
    const client = new MockClient([
      [
        {
          type: "tool_call_complete",
          toolId: "t_rb",
          toolName: "ReadFile",
          arguments: { file_path: readbackPath },
        },
        end("tool_use"),
      ],
      [{ type: "text_delta", text: "done" }, end()],
    ]);

    const conv = await runAgent(client, workDir, [
      fixedTool("ReadFile", "y".repeat(60000)),
    ]);

    // Readback results are exempt from spilling: the original text enters history, and no new spill file is generated
    const tr = toolResultsMsg(conv)?.toolResults?.[0] ?? undefined;
    expect(tr?.content.length).toBe(60000);
    expect(existsSync(join(spillDirOf(workDir), "t_rb.txt"))).toBe(false);
  });

  it("records the bounded ReadFile result instead of rereading the entire file", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-wire-"));
    const filePath = join(workDir, "large.txt");
    writeFileSync(filePath, "disk-content".repeat(20_000), "utf-8");
    const client = new MockClient([
      [
        {
          type: "tool_call_complete",
          toolId: "t_read",
          toolName: "ReadFile",
          arguments: { file_path: filePath },
        },
        end("tool_use"),
      ],
      [{ type: "text_delta", text: "done" }, end()],
    ]);
    const recovery = new RecoveryState();

    await runAgent(
      client,
      workDir,
      [fixedTool("ReadFile", "returned-lines")],
      recovery,
    );

    expect(recovery.snapshotFiles()).toEqual([
      expect.objectContaining({ path: filePath, content: "returned-lines" }),
    ]);
  });

  it("spills only the largest result when the aggregate exceeds the budget", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-wire-"));
    const sizes: Record<string, number> = {
      T1: 45000,
      T2: 45000,
      T3: 45001,
      T4: 45000,
      T5: 45000,
    };
    const calls: StreamEvent[] = Object.keys(sizes).map((name) => ({
      type: "tool_call_complete",
      toolId: "t" + name.slice(1).toLowerCase(),
      toolName: name,
      arguments: {},
    }));
    const client = new MockClient([
      [...calls, end("tool_use")],
      [{ type: "text_delta", text: "done" }, end()],
    ]);
    const toolsList = Object.entries(sizes).map(([name, n]) =>
      fixedTool(name, "z".repeat(n)),
    );

    const conv = await runAgent(client, workDir, toolsList);

    const msg = toolResultsMsg(conv);
    const total = msg?.toolResults?.reduce(
      (sum, r) => sum + r.content.length,
      0,
    );
    expect(total).toBeLessThanOrEqual(200000);
    const previews = msg?.toolResults?.filter((r) =>
      asString(r.content).includes("<persisted-output>"),
    );
    expect(previews?.length).toBe(1);
    const t3 = msg?.toolResults?.find((r) => r.toolUseId === "t3");
    expect(t3?.content).toContain("<persisted-output>");
  });
});

// End-to-end wiring for image tool results: the text fallback and structured
// blocks must both reach the conversation, while session JSONL stores the
// base64 payload inline and resume restores it.
describe("image tool result wiring", () => {
  const PNG_DATA = Buffer.from("not-a-real-png-but-that-is-fine").toString(
    "base64",
  );
  const imageBlocks: ToolResultContentBlock[] = [
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PNG_DATA },
    },
  ];

  function imageTool(name: string): Tool {
    return {
      name,
      description: "returns image blocks",
      category: "read",
      schema: () => ({
        name,
        description: "img",
        input_schema: { type: "object", properties: {} },
      }),
      execute: () =>
        Promise.resolve({
          output: "[Image: image/png]",
          contentBlocks: imageBlocks,
          isError: false,
        }),
    };
  }

  function blocksOf(content: ToolResultContentBlock[] | undefined) {
    if (!content) {
      throw new Error("expected tool result content blocks");
    }
    return content;
  }

  it("keeps image blocks intact through history, persists them inline, and restores on resume", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-wire-img-"));
    const client = new MockClient([
      [
        {
          type: "tool_call_complete",
          toolId: "img1",
          toolName: "Screenshot",
          arguments: {},
        },
        end("tool_use"),
      ],
      [{ type: "text_delta", text: "done" }, end()],
    ]);

    const conv = new ConversationManager();
    conv.addUserMessage("go");
    const registry = new ToolRegistry();
    registry.register(imageTool("Screenshot"));
    const agent = new Agent({
      client,
      registry,
      checker: new PermissionChecker(workDir, "bypassPermissions"),
      conversation: conv,
      workDir,
      sessionId: "wiring",
    });
    const events: AgentEvent[] = [];
    for await (const ev of agent.run()) {
      events.push(ev);
    }

    const resultEvent = events.find((event) => event.type === "tool_result");
    expect(resultEvent?.type).toBe("tool_result");
    expect(resultEvent?.type === "tool_result" ? resultEvent.output : "").toBe(
      "[Image: image/png]",
    );
    const eventBlocks =
      resultEvent?.type === "tool_result"
        ? resultEvent.contentBlocks
        : undefined;
    expect(blocksOf(eventBlocks)[0]?.type).toBe("image");

    const tr = toolResultsMsg(conv)?.toolResults?.[0];
    expect(tr?.content).toBe("[Image: image/png]");
    const historyImage = blocksOf(tr?.contentBlocks).find(
      (block) => block.type === "image",
    );
    expect(historyImage).toBeDefined();
    const historySource =
      historyImage && "source" in historyImage ? historyImage.source : null;
    expect(isRecord(historySource) ? historySource.data : null).toBe(PNG_DATA);

    const jsonl = readFileSync(
      join(workDir, ".yukino", "sessions", "wiring.jsonl"),
      "utf-8",
    );
    expect(jsonl).toContain('"content_blocks"');
    expect(jsonl).toContain(PNG_DATA);

    const saved = loadSession(workDir, "wiring");
    const restored = rebuildFromSession(saved);
    const restoredTr = restored.find((message) => message.toolResults?.length)
      ?.toolResults?.[0];
    expect(restoredTr?.content).toBe("[Image: image/png]");
    const restoredImage = blocksOf(restoredTr?.contentBlocks).find(
      (block) => block.type === "image",
    );
    expect(restoredImage).toBeDefined();
    const restoredSource =
      restoredImage && "source" in restoredImage ? restoredImage.source : null;
    expect(isRecord(restoredSource) ? restoredSource.data : null).toBe(
      PNG_DATA,
    );
  });
});
