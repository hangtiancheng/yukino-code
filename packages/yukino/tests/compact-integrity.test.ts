import { afterEach, describe, expect, it, vi } from "vitest";

import { computeKeepStartIndex, forceCompact } from "@/compact/compact.js";
import {
  buildCompactionSummaryMessage,
  buildSummaryPrompt,
} from "@/compact/prompts.js";
import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import { ContextTooLongError, NetworkError } from "@/llm/errors.js";
import type { StreamEvent } from "@/llm/events.js";

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
afterEach(() => vi.useRealTimers());

function history() {
  const conv = new ConversationManager();
  for (let index = 0; index < 20; index++) {
    conv.addUserMessage(`task ${String(index)} ` + "context ".repeat(200));
    conv.addAssistantFull("answer", [], []);
  }
  conv.addAssistantFull(
    "read image",
    [],
    [
      {
        toolUseId: "read",
        toolName: "ReadFile",
        arguments: { file_path: "a.png" },
      },
    ],
  );
  conv.addToolResultsMessage([
    {
      toolUseId: "read",
      content: "image read",
      isError: false,
      contentBlocks: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "QUJD" },
        },
      ],
    },
  ]);
  conv.addSystemReminder("Keep the latest user constraints");
  return conv;
}

describe("compaction integrity", () => {
  it.each(["plain partial checkpoint", "<summary>looks complete</summary>"])(
    "rejects an unterminated summary stream: %s",
    async (text) => {
      const conv = history();
      const before = conv.getMessages();
      const client: LLMClient = {
        setSystemPrompt: vi.fn(),
        async *stream() {
          await Promise.resolve();
          yield { type: "text_delta", text };
        },
      };
      await expect(forceCompact(conv, client, null, [], [])).rejects.toThrow(
        "without a completion event",
      );
      expect(conv.getMessages()).toEqual(before);
    },
  );

  it("retries transient summary failures without retaining partial summary text", async () => {
    vi.useFakeTimers();
    const conv = history();
    let attempts = 0;
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream() {
        await Promise.resolve();
        if (attempts++ === 0) {
          yield { type: "text_delta", text: "<summary>discard this partial" };
          throw new NetworkError("connection reset");
        }
        yield {
          type: "text_delta",
          text: "<summary>Verified checkpoint</summary>",
        };
        yield end;
      },
    };
    const running = forceCompact(conv, client, null, [], []);
    await vi.runAllTimersAsync();
    expect((await running).boundary?.summary).toBe("Verified checkpoint");
    expect(attempts).toBe(2);
    expect(conv.getMessages()[0].content).not.toContain("discard");
  });

  it("cancels a pending summary retry without changing conversation history", async () => {
    vi.useFakeTimers();
    const conv = history();
    const before = conv.getMessages();
    const controller = new AbortController();
    let attempts = 0;
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream() {
        attempts++;
        await Promise.resolve();
        yield* [];
        throw new NetworkError("connection reset");
      },
    };
    const running = forceCompact(
      conv,
      client,
      null,
      [],
      [],
      "",
      controller.signal,
    );
    const rejected = expect(running).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await rejected;
    expect(attempts).toBe(1);
    expect(conv.getMessages()).toEqual(before);
  });

  it("propagates cancellation and retains the original history", async () => {
    const conv = history();
    const before = structuredClone(conv.getMessages());
    const controller = new AbortController();
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream(_request, _tools, signal) {
        expect(signal).toBe(controller.signal);
        yield { type: "text_delta", text: "<summary>partial" };
        await Promise.resolve();
        controller.abort();
      },
    };
    await expect(
      forceCompact(conv, client, null, [], [], "", controller.signal),
    ).rejects.toThrow();
    expect(conv.getMessages()).toEqual(before);
  });

  it("does not replace new messages appended while a summary is being generated", async () => {
    const conv = history();
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream() {
        conv.addUserMessage("A newer task");
        await Promise.resolve();
        yield { type: "text_delta", text: "<summary>older task</summary>" };
        yield end;
      },
    };
    await expect(forceCompact(conv, client, null, [], [])).rejects.toThrow(
      "changed",
    );
    expect(conv.getMessages().at(-1)?.content).toBe("A newer task");
  });
  it("summarizes only the immutable prefix and preserves the recent rich tail verbatim", async () => {
    const conv = history();
    const before = structuredClone(conv.getMessages());
    const keepStart = computeKeepStartIndex(before);
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream(request) {
        await Promise.resolve();
        expect(request.getMessages().slice(0, -1)).toEqual(
          before.slice(0, keepStart),
        );
        yield {
          type: "text_delta",
          text: "<summary>Retained context</summary>",
        };
        yield end;
      },
    };
    const setSystemPrompt = vi.spyOn(client, "setSystemPrompt");
    const result = await forceCompact(conv, client, null, [], []);
    expect(result.compacted).toBe(true);
    expect(conv.getMessages().slice(1)).toEqual(before.slice(keepStart));
    expect(conv.getMessages()[0].content).toBe(
      buildCompactionSummaryMessage("Retained context", true),
    );
    expect(
      conv.getMessages().flatMap((m) => m.toolResults ?? [])[0].contentBlocks,
    ).toEqual(before.at(-2)?.toolResults?.[0].contentBlocks);
    expect(setSystemPrompt).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "<analysis>unfinished reasoning</analysis>",
    "<summary>   </summary>",
  ])("preserves history when the summary is unusable: %j", async (text) => {
    const conv = history();
    const before = structuredClone(conv.getMessages());
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream() {
        await Promise.resolve();
        yield { type: "text_delta", text };
      },
    };
    await expect(forceCompact(conv, client, null, [], [])).rejects.toThrow();
    expect(conv.getMessages()).toEqual(before);
  });

  it("retries typed context errors during the text fallback", async () => {
    const conv = history();
    let attempts = 0;
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream() {
        await Promise.resolve();
        if (attempts++ < 2) {
          throw new ContextTooLongError("context too long");
        }
        yield {
          type: "text_delta",
          text: "<summary>Retained context</summary>",
        };
        yield end;
      },
    };
    expect((await forceCompact(conv, client, null, [], [])).compacted).toBe(
      true,
    );
    expect(attempts).toBe(3);
  });

  it("preserves manual focus across cache-sharing and serialized retries", async () => {
    const conv = history();
    const requests: string[] = [];
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream(request) {
        await Promise.resolve();
        const text = request.getMessages().at(-1)?.content;
        if (typeof text !== "string") {
          throw new Error("Expected text summary instructions");
        }
        requests.push(text);
        if (requests.length === 1) {
          throw new ContextTooLongError("context too long");
        }
        yield { type: "text_delta", text: "<summary>Checkpoint</summary>" };
        yield end;
      },
    };
    await forceCompact(
      conv,
      client,
      null,
      [],
      [],
      "",
      undefined,
      "Keep the failing test names",
    );
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toContain(
        "Additional focus:\nKeep the failing test names",
      );
      expect(request).toContain("## Constraints & Preferences");
    }
    expect(requests[1]).toContain("<conversation>");
    expect(buildSummaryPrompt("quoted instructions")).toContain(
      "<conversation>\nquoted instructions\n</conversation>",
    );
  });

  it("does not persist a summary response that tries to call tools", async () => {
    const conv = history();
    const before = structuredClone(conv.getMessages());
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream() {
        await Promise.resolve();
        yield {
          type: "text_delta",
          text: "<summary>Not a checkpoint</summary>",
        };
        yield {
          type: "tool_call_start",
          toolName: "Bash",
          toolId: "wrong-task",
        };
      },
    };
    await expect(forceCompact(conv, client, null, [], [])).rejects.toThrow(
      "requested a tool",
    );
    expect(conv.getMessages()).toEqual(before);
  });
});
