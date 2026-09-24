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

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { Agent } from "@/agent/index.js";
import { ConversationManager, type Message } from "@/conversation/index.js";
import { AnthropicClient, buildAnthropicMessages } from "@/llm/anthropic.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import { buildChatCompletionMessages, buildOpenAIInput } from "@/llm/openai.js";
import { MemoryExtractor } from "@/memory/extractor.js";
import { MemoryPermissionChecker } from "@/memory/permissions.js";
import { extractWrittenPaths } from "@/memory/written-paths.js";
import { PermissionChecker } from "@/permissions/index.js";
import { AgentTool } from "@/subagent/agent-tool.js";
import { EditFileTool } from "@/tools/edit-file.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import { ReadFileTool } from "@/tools/read-file.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { ToolContext } from "@/tools/types.js";
import { WriteFileTool } from "@/tools/write-file.js";
import * as worktrees from "@/worktree/index.js";

const end: StreamEvent = {
  type: "stream_end",
  stopReason: "end_turn",
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
};
function mockClient(turns: StreamEvent[][]): LLMClient {
  let turn = 0;
  return {
    setSystemPrompt: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream() {
      yield* turns[turn++] ?? [end];
    },
  };
}
const workDir = () => mkdtempSync(join(tmpdir(), "yukino-data-"));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("file and memory execution", () => {
  it("reads, edits, and writes relative to the agent working directory", async () => {
    const directory = workDir();
    const ctx = { workDir: directory, fileStateCache: new FileStateCache() };
    expect(
      (
        await new WriteFileTool().execute(ctx, {
          file_path: "nested/test.txt",
          content: "before",
        })
      ).isError,
    ).toBe(false);
    expect(
      (await new ReadFileTool().execute(ctx, { file_path: "nested/test.txt" }))
        .output,
    ).toBe("1\tbefore");
    expect(
      (
        await new EditFileTool().execute(ctx, {
          file_path: "nested/test.txt",
          old_string: "before",
          new_string: "after",
        })
      ).isError,
    ).toBe(false);
    expect(readFileSync(join(directory, "nested/test.txt"), "utf-8")).toBe(
      "after",
    );
  });

  it("records actual successful memory tool calls and rebuilds their index", async () => {
    const directory = workDir();
    const path = join(directory, ".yukino/memory/preference.md");
    const client = mockClient([
      [
        {
          type: "tool_call_complete",
          toolId: "save",
          toolName: "WriteFile",
          arguments: {
            file_path: path,
            content:
              "---\nname: preference\ndescription: test project preference\nmetadata:\n  type: project\n---\nKeep task constraints.\n",
          },
        },
        end,
      ],
      [end],
    ]);
    expect(
      await new MemoryExtractor(client, directory).extract(
        "User explicitly requested a durable project preference.",
      ),
    ).toEqual(["preference.md"]);
    expect(
      readFileSync(join(directory, ".yukino/memory/MEMORY.md"), "utf-8"),
    ).toContain("preference.md");
  });

  it("does not report prose or failed tool calls as saved memories", () => {
    expect(
      extractWrittenPaths([
        {
          role: "assistant",
          content: '{"tool":"WriteFile","file_path":"fake.md"}',
          toolUses: [
            {
              toolName: "WriteFile",
              toolUseId: "failed",
              arguments: { file_path: "failed.md" },
            },
          ],
        },
        {
          role: "user",
          content: "",
          toolResults: [
            { toolUseId: "failed", content: "denied", isError: true },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("keeps multiline fallback memory bodies and rejects path traversal", async () => {
    const directory = workDir();
    const client = mockClient([
      [
        {
          type: "text_delta",
          text: "MEMORY_NAME: useful\nMEMORY_TYPE: project\nMEMORY_DESC: durable fact\nMEMORY_BODY:\nFirst line\nSecond line\n---\nMEMORY_NAME: ../escape\nMEMORY_TYPE: project\nMEMORY_BODY: unwanted",
        },
        end,
      ],
    ]);
    expect(
      await new MemoryExtractor(client, directory).extract("conversation"),
    ).toEqual(["useful"]);
    expect(
      readFileSync(join(directory, ".yukino/memory/useful.md"), "utf-8"),
    ).toContain("First line\nSecond line");
    expect(existsSync(join(directory, ".yukino/escape.md"))).toBe(false);
  });

  it("denies background writes through symlinks and outside memory storage", () => {
    const directory = workDir();
    mkdirSync(join(directory, ".yukino/memory"), { recursive: true });
    symlinkSync(workDir(), join(directory, ".yukino/memory/escape"));
    const checker = new MemoryPermissionChecker(directory, true);
    for (const path of [
      "source.ts",
      ".yukino/memory/escape/file.md",
      ".yukino/memory/lock",
    ]) {
      expect(
        checker.check("WriteFile", "write", { file_path: path }).effect,
      ).toBe("deny");
    }
    expect(
      checker.check("WriteFile", "write", {
        file_path: ".yukino/memory/valid.md",
      }).effect,
    ).toBe("allow");
    expect(
      checker.check("Bash", "command", {
        command: "echo dangerous > source.ts",
      }).effect,
    ).toBe("deny");
  });
});

describe("fork and restored context", () => {
  it("honors fork worktree isolation and keeps parent permission rules", async () => {
    const directory = workDir();
    const isolated = workDir();
    mkdirSync(join(directory, ".yukino"));
    writeFileSync(
      join(directory, ".yukino/permissions.yaml"),
      '- rule: "WriteFile(blocked*)"\n  effect: deny\n',
    );
    vi.spyOn(worktrees, "createAgentWorktree").mockResolvedValue({
      path: isolated,
      branch: "test-branch",
      headCommit: "test-head",
      gitRoot: directory,
    });
    const handler = vi.fn(
      (
        _prompt: string,
        _conversation: ConversationManager,
        _registry: ToolRegistry,
        _model?: string,
        context?: ToolContext,
      ) => {
        expect(context?.workDir).toBe(isolated);
        expect(
          context?.permissionChecker?.check("WriteFile", "write", {
            file_path: "blocked.ts",
          }).effect,
        ).toBe("deny");
        return Promise.resolve("isolated result");
      },
    );
    const parent = new ConversationManager();
    parent.addUserMessage("parent task");
    const tool = new AgentTool(
      directory,
      new ToolRegistry(),
      () => Promise.resolve("unused"),
      parent,
      handler,
    );
    const result = await tool.execute(
      {
        workDir: directory,
        permissionChecker: new PermissionChecker(directory, "acceptEdits"),
      },
      {
        description: "isolated audit",
        prompt: "Inspect this",
        isolation: "worktree",
      },
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(result.output).toContain(isolated);
    expect(parent.getMessages()).toEqual([
      { role: "user", content: "parent task" },
    ]);
  });

  it("forks deeply, keeps the initial reminder once, and returns worker evidence", async () => {
    const parent = new ConversationManager();
    parent.injectLongTermMemory("project constraints", "");
    parent.addUserMessage([{ type: "text", text: "parent attachment" }]);
    const before = structuredClone(parent.getMessages());
    const handler = vi.fn((_prompt: string, snapshot: ConversationManager) => {
      snapshot.injectLongTermMemory("duplicate", "");
      expect(snapshot.getMessages()).toEqual(before);
      const content = snapshot.getMessages().at(-1)?.content;
      if (Array.isArray(content)) {
        content[0].text = "child change";
      }
      snapshot.addAssistantMessage("worker result");
      return Promise.resolve("verified worker result");
    });
    const tool = new AgentTool(
      workDir(),
      new ToolRegistry(),
      () => Promise.resolve("unused"),
      parent,
      handler,
    );
    const result = await tool.execute(
      { workDir: workDir() },
      { description: "audit", prompt: "Inspect this" },
    );
    expect(result.output).toContain("verified worker result");
    expect(parent.getMessages()).toEqual(before);
  });

  it("restores instructions and active skills after manual compaction without changing the system prompt", async () => {
    const conversation = new ConversationManager();
    conversation.replaceWithCompacted("summary", []);
    const client = mockClient([[end]]);
    const setSystemPrompt = vi.spyOn(client, "setSystemPrompt");
    const agent = new Agent({
      client,
      conversation,
      workDir: workDir(),
      registry: new ToolRegistry(),
      checker: new PermissionChecker(workDir()),
      instructions: "preserve prefix",
      memoryContent: "memory fact",
      skillSection: "available skill",
      activeSkills: new Map([["audit", "active skill procedure"]]),
    });
    for await (const event of agent.run()) {
      expect(event.type).not.toBe("error");
    }
    expect(JSON.stringify(conversation.getMessages())).toContain(
      "active skill procedure",
    );
    expect(JSON.stringify(conversation.getMessages())).toContain(
      "preserve prefix",
    );
    expect(setSystemPrompt).not.toHaveBeenCalled();
  });
});

describe("multimodal provider requests", () => {
  it("retains attachments beside tool results in every protocol", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "attached note" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "IMAGE_PAYLOAD",
            },
          },
        ],
        toolResults: [{ toolUseId: "read", content: "result", isError: false }],
      },
    ];
    for (const converted of [
      buildAnthropicMessages(messages),
      buildOpenAIInput(messages),
      buildChatCompletionMessages(messages),
    ]) {
      expect(JSON.stringify(converted)).toContain("attached note");
      expect(JSON.stringify(converted)).toContain("IMAGE_PAYLOAD");
      expect(JSON.stringify(converted)).toContain("result");
    }
  });

  it.each(["high", "off"] as const)(
    "sends valid Anthropic thinking configuration when thinking=%s",
    async (thinking) => {
      let request: unknown;
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: unknown, init: RequestInit) => {
          request = JSON.parse(z.string().parse(init.body));
          const events = [
            {
              type: "message_start",
              message: {
                id: "test",
                type: "message",
                role: "assistant",
                model: "test",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            },
            { type: "message_stop" },
          ];
          return Promise.resolve(
            new Response(
              events
                .map(
                  (event) =>
                    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                )
                .join(""),
              { headers: { "content-type": "text/event-stream" } },
            ),
          );
        }),
      );
      const client = new AnthropicClient(
        {
          name: "test",
          protocol: "anthropic",
          base_url: "https://example.invalid",
          api_key: "test",
          model: "test",
          thinking,
        },
        "stable system",
      );
      const conversation = new ConversationManager();
      conversation.addUserMessage("hi");
      for await (const event of client.stream(conversation, [])) {
        expect(event.type).not.toBe("error");
      }
      const body = z
        .object({
          max_tokens: z.number(),
          thinking: z.object({
            type: z.string(),
            budget_tokens: z.number().optional(),
          }),
        })
        .parse(request);
      expect(body.max_tokens).toBe(128000);
      expect(body.thinking.type).toBe(
        thinking === "off" ? "disabled" : "enabled",
      );
      if (thinking !== "off") {
        expect(body.thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
        expect(body.thinking.budget_tokens).toBeLessThan(body.max_tokens);
      }
    },
  );
});

describe("Anthropic thinking budget under an output cap", () => {
  async function captureAnthropicBody(
    thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    maxOutputTokens: number,
  ) {
    let request: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init: RequestInit) => {
        request = JSON.parse(z.string().parse(init.body));
        const events = [
          {
            type: "message_start",
            message: {
              id: "test",
              type: "message",
              role: "assistant",
              model: "test",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ];
        return Promise.resolve(
          new Response(
            events
              .map(
                (event) =>
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              )
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      }),
    );
    const client = new AnthropicClient(
      {
        name: "test",
        protocol: "anthropic",
        base_url: "https://example.invalid",
        api_key: "test",
        model: "test",
        thinking,
        max_output_tokens: maxOutputTokens,
      },
      "stable system",
    );
    const conversation = new ConversationManager();
    conversation.addUserMessage("hi");
    for await (const event of client.stream(conversation, [])) {
      expect(event.type).not.toBe("error");
    }
    return z
      .object({
        max_tokens: z.number(),
        thinking: z.object({
          type: z.string(),
          budget_tokens: z.number().optional(),
        }),
      })
      .parse(request);
  }

  it("shrinks the budget instead of disabling thinking when it does not fit", async () => {
    // high requests 16384, but the cap only leaves 16384 - 1024 for thinking.
    const body = await captureAnthropicBody("high", 16384);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 15360 });
    expect(body.thinking.budget_tokens).toBeLessThan(body.max_tokens);
  });

  it("reserves at least one answer window for a tight cap", async () => {
    const body = await captureAnthropicBody("high", 2048);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  it("disables thinking when the cap cannot hold a valid budget", async () => {
    const body = await captureAnthropicBody("high", 1500);
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("disables thinking when the level is off", async () => {
    const body = await captureAnthropicBody("off", 128000);
    expect(body.thinking).toEqual({ type: "disabled" });
  });
});
