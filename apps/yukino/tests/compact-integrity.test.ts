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

import { describe, expect, it, vi } from "vitest";

import { computeKeepStartIndex, forceCompact } from "@/compact/compact.js";
import { buildCompactionSummaryMessage, buildSummaryPrompt } from "@/compact/prompts.js";
import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import { ContextTooLongError } from "@/llm/errors.js";

function history() {
  const conv = new ConversationManager();
  for (let index = 0; index < 20; index++) {
    conv.addUserMessage(`task ${String(index)} ` + "context ".repeat(200));
    conv.addAssistantMessage("answer");
  }
  conv.addAssistantMessageWithTools("read image", [
    { toolUseId: "read", toolName: "ReadFile", arguments: { file_path: "a.png" } },
  ]);
  conv.addToolResultMessage("read", "image read", false, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
  ]);
  conv.addSystemReminder("Keep the latest user constraints");
  return conv;
}

describe("compaction integrity", () => {
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
    await expect(forceCompact(conv, client, null, [], [], "", controller.signal)).rejects.toThrow();
    expect(conv.getMessages()).toEqual(before);
  });

  it("does not replace new messages appended while a summary is being generated", async () => {
    const conv = history();
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/require-await
      async *stream() {
        conv.addUserMessage("A newer task");
        yield { type: "text_delta", text: "<summary>older task</summary>" };
      },
    };
    await expect(forceCompact(conv, client, null, [], [])).rejects.toThrow("changed");
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
        expect(request.getMessages().slice(0, -1)).toEqual(before.slice(0, keepStart));
        yield { type: "text_delta", text: "<summary>Retained context</summary>" };
      },
    };
    const setSystemPrompt = vi.spyOn(client, "setSystemPrompt");
    const result = await forceCompact(conv, client, null, [], []);
    expect(result.compacted).toBe(true);
    expect(conv.getMessages().slice(1)).toEqual(before.slice(keepStart));
    expect(conv.getMessages()[0].content).toBe(
      buildCompactionSummaryMessage("Retained context", true),
    );
    expect(conv.getMessages().flatMap((m) => m.toolResults ?? [])[0].contentBlocks).toEqual(
      before.at(-2)?.toolResults?.[0].contentBlocks,
    );
    expect(setSystemPrompt).not.toHaveBeenCalled();
  });

  it.each(["", "<analysis>unfinished reasoning</analysis>", "<summary>   </summary>"])(
    "preserves history when the summary is unusable: %j",
    async (text) => {
      const conv = history();
      const before = structuredClone(conv.getMessages());
      const client: LLMClient = {
        setSystemPrompt: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/require-await
        async *stream() {
          yield { type: "text_delta", text };
        },
      };
      await expect(forceCompact(conv, client, null, [], [])).rejects.toThrow();
      expect(conv.getMessages()).toEqual(before);
    },
  );

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
        yield { type: "text_delta", text: "<summary>Retained context</summary>" };
      },
    };
    expect((await forceCompact(conv, client, null, [], [])).compacted).toBe(true);
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
      },
    };
    await forceCompact(conv, client, null, [], [], "", undefined, "Keep the failing test names");
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toContain("Additional focus:\nKeep the failing test names");
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
        yield { type: "text_delta", text: "<summary>Not a checkpoint</summary>" };
        yield { type: "tool_call_start", toolName: "Bash", toolId: "wrong-task" };
      },
    };
    await expect(forceCompact(conv, client, null, [], [])).rejects.toThrow("requested a tool");
    expect(conv.getMessages()).toEqual(before);
  });
});
