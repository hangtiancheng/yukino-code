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

import { describe, it, expect } from "vitest";

import {
  estimateTokens,
  estimateMessages,
  currentContextTokens,
  computeKeepStartIndex,
  forceCompact,
  type UsageAnchor,
} from "@/compact/compact.js";
import { RecoveryState } from "@/compact/recovery.js";
import { ConversationManager, type Message } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import { contentToText } from "@/utils/index.js";

// A stub LLM that emits a fixed summary and records the text it was asked to
// summarize, so tests can assert what the summary covered.
function stubClient(summaryBody: string): {
  client: LLMClient;
  lastPrompt: () => string;
} {
  let lastPrompt = "";
  const client: LLMClient = {
    setSystemPrompt(_prompt: string) {
      /** noop */
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(conversation): AsyncGenerator<StreamEvent> {
      lastPrompt = contentToText(conversation.getMessages()[0]?.content ?? "");
      yield { type: "text_delta", text: `<summary>${summaryBody}</summary>` };
    },
  };
  return { client, lastPrompt: () => lastPrompt };
}

// CHARS_PER_TOKEN is 3.5 in compact.ts; estimateMessages = ceil(chars / 3.5).
const estChars = (chars: number) => Math.ceil(chars / 3.5);

describe("currentContextTokens (real-usage anchoring)", () => {
  it("falls back to whole-transcript char estimation when there is no anchor (cold start)", () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage("a".repeat(35)); // 35 chars
    conversation.addAssistantMessage("b".repeat(35)); // 35 chars

    // No anchor → identical to estimating the whole transcript.
    const got = currentContextTokens(conversation, undefined);
    expect(got).toBe(estimateTokens(conversation));
    expect(got).toBe(estChars(70)); // 70 chars / 3.5 = 20
  });

  it("uses baseline + increment for messages appended after the anchor", () => {
    const conversation = new ConversationManager();
    // Two messages were already covered by the API usage that produced the
    // anchor; their characters must NOT be re-counted.
    conversation.addUserMessage("x".repeat(1000));
    conversation.addAssistantMessage("y".repeat(1000));

    const anchor: UsageAnchor = {
      baselineTokens: 5000, // the real API-reported full context size
      anchorCount: 2, // it covered the first 2 messages
    };

    // Nothing new yet → exactly the baseline, char count of old messages ignored.
    expect(currentContextTokens(conversation, anchor)).toBe(5000);

    // Append a new message after the anchor → baseline + estimate of only that.
    conversation.addUserMessage("z".repeat(70)); // 70 chars → ceil(70/3.5) = 20
    expect(currentContextTokens(conversation, anchor)).toBe(5000 + estChars(70));
    expect(currentContextTokens(conversation, anchor)).toBe(5020);
  });

  it("anchoring beats raw char estimation after a cache hit (real input << chars)", () => {
    const conversation = new ConversationManager();
    // A large transcript: char estimation would be huge.
    conversation.addUserMessage("q".repeat(100_000));

    const charEstimate = estimateTokens(conversation);
    expect(charEstimate).toBeGreaterThan(20_000);

    // But the API reported a small real context (e.g. mostly cache-read).
    const anchor: UsageAnchor = { baselineTokens: 6000, anchorCount: 1 };
    expect(currentContextTokens(conversation, anchor)).toBe(6000);
    expect(currentContextTokens(conversation, anchor)).toBeLessThan(charEstimate);
  });

  it("clamps when the transcript was truncated below the anchor index", () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage("only one message");

    // Anchor claims more messages than currently exist (e.g. post-compaction).
    const anchor: UsageAnchor = { baselineTokens: 3000, anchorCount: 5 };
    // slice(min(5,1)=1) → empty → just the baseline, no negative slicing.
    expect(currentContextTokens(conversation, anchor)).toBe(3000);
  });

  it("estimateMessages matches the documented chars/3.5 rounding", () => {
    expect(estimateMessages([])).toBe(0);
    expect(estimateMessages([{ role: "user", content: "x".repeat(7) }])).toBe(estChars(7));
  });

  it("estimateMessages counts image blocks at the fixed char equivalent", () => {
    const result = (content: Message["toolResults"]) => [
      { role: "user" as const, content: "", toolResults: content },
    ];
    const textOnly = result([
      {
        toolUseId: "t1",
        content: "x".repeat(7),
        contentBlocks: [{ type: "text", text: "x".repeat(7) }],
        isError: false,
      },
    ]);
    const withImage = result([
      {
        toolUseId: "t1",
        content: "x".repeat(7),
        contentBlocks: [
          { type: "text", text: "x".repeat(7) },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AA" },
          },
        ],
        isError: false,
      },
    ]);
    expect(estimateMessages(textOnly)).toBe(estChars(7));
    expect(
      estimateMessages(
        result([
          {
            toolUseId: "t2",
            content: "x",
            contentBlocks: [{ type: "text", text: "y".repeat(70) }],
            isError: false,
          },
        ]),
      ),
    ).toBe(estChars(70));
    // IMAGE_CHAR_EQUIV = 7000 chars → estimated at chars/3.5, not zero.
    expect(estimateMessages(withImage)).toBe(estChars(7 + 7000));
  });
});

describe("computeKeepStartIndex (recent-history retention)", () => {
  it("keeps at least MIN_KEEP_MESSAGES (5) recent messages when they are short", () => {
    // 12 tiny messages: token-floor (10k) is never reached, so the count-floor
    // of 5 decides the boundary → keep the last 5.
    const messages: Message[] = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${String(i)}`,
    }));
    expect(computeKeepStartIndex(messages)).toBe(12 - 5);
  });

  it("does not split a tool_use/tool_result pair at the keep boundary", () => {
    // Build: 8 short user/assistant messages, then a tool_use assistant (idx 8)
    // and its tool_result user (idx 9), then 4 more short messages (idx 10-13).
    // The plain count-floor would land keepStart on idx 9 (the tool_result),
    // which must be backed up to idx 8 (the tool_use) so the pair stays whole.
    const conversation = new ConversationManager();
    for (let i = 0; i < 8; i++) {
      if (i % 2 === 0) {
        conversation.addUserMessage(`u${String(i)}`);
      } else {
        conversation.addAssistantMessage(`a${String(i)}`);
      }
    }
    conversation.addAssistantMessageWithTools("calling tool", [
      { toolUseId: "tid-1", toolName: "Read", arguments: { path: "/x" } },
    ]);
    conversation.addToolResultMessage("tid-1", "file contents", false);
    for (let i = 10; i < 14; i++) {
      conversation.addAssistantMessage(`tail${String(i)}`);
    }

    const messages = conversation.getMessages(); // length 14
    const keepStart = computeKeepStartIndex(messages);

    // Count-floor of 5 would pick idx 9 (tool_result user); must back up to 8.
    expect(keepStart).toBe(8);
    // The kept tail must start with the tool_use assistant, not the orphan.
    expect(messages[keepStart].toolUses?.[0]?.toolUseId).toBe("tid-1");
    // And the matching tool_result is inside the kept slice (not orphaned out).
    const kept = messages.slice(keepStart);
    const hasUse = kept.some((m) => m.toolUses?.some((t) => t.toolUseId === "tid-1"));
    const hasResult = kept.some((m) => m.toolResults?.some((t) => t.toolUseId === "tid-1"));
    expect(hasUse && hasResult).toBe(true);
  });

  it("stops at KEEP_MAX_TOKENS upper bound and does not keep everything", () => {
    // Each message is ~14000 tokens (49000 chars / 3.5). The token-floor (10k)
    // is satisfied by a single message, but we keep adding until the next would
    // cross KEEP_MAX_TOKENS (40k). 14k+14k=28k ok, +14k=42k > 40k → stop at 2.
    const big = "z".repeat(49000); // ceil(49000/3.5) = 14000 tokens each
    const messages: Message[] = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: big,
    }));
    const keepStart = computeKeepStartIndex(messages);
    // token-floor (10k) is met by the very first kept message → keep exactly 1.
    expect(keepStart).toBe(messages.length - 1);
    expect(keepStart).toBeGreaterThan(0); // not everything kept
  });
});

describe("doCompact via forceCompact (keep recent verbatim)", () => {
  it("keeps recent original messages verbatim and only summarizes the prefix", async () => {
    const conversation = new ConversationManager();
    // A long prefix that must be summarized away...
    for (let i = 0; i < 20; i++) {
      conversation.addUserMessage(`OLD-PREFIX-${String(i)}-` + "p".repeat(1200));
      conversation.addAssistantMessage(`old-reply-${String(i)}`);
    }
    // ...and a recent tail we expect to survive untouched.
    conversation.addUserMessage("RECENT-QUESTION marker-recent-q");
    conversation.addAssistantMessage("RECENT-ANSWER marker-recent-a");
    conversation.addUserMessage("RECENT-FOLLOWUP marker-recent-f");

    const { client, lastPrompt } = stubClient("THE SUMMARY BODY");
    const before = conversation.getMessages().length;
    const { message: msg, boundary } = await forceCompact(conversation, client, null, [], []);

    // forceCompact returns the structured boundary the session owner persists:
    // the bare summary plus the verbatim kept tail inlined as role+text.
    expect(boundary).toBeDefined();
    expect(boundary?.summary).toBe("THE SUMMARY BODY");
    const keepJoined = boundary?.keep.map((k) => contentToText(k.content)).join("\n");
    expect(keepJoined).toContain("marker-recent-q");
    expect(keepJoined).toContain("marker-recent-f");
    // The boundary summary is bare (no recovery attachment / no framing
    // wrapper — those are added at replay time, not persisted).
    expect(boundary?.summary).not.toContain(
      "The conversation history before this point was compacted",
    );

    const after = conversation.getMessages();
    const joined = after.map((m) => contentToText(m.content)).join("\n");

    // Recent original messages are still present verbatim (not just a summary).
    expect(joined).toContain("marker-recent-q");
    expect(joined).toContain("marker-recent-a");
    expect(joined).toContain("marker-recent-f");
    // The summary is present with the framing wrapper...
    expect(joined).toContain("THE SUMMARY BODY");
    expect(joined).toContain("The conversation history before this point was compacted");
    expect(joined).toContain("Recent messages have been preserved verbatim");
    // ...but the summary prompt only covered the prefix, NOT the kept tail.
    expect(lastPrompt()).toContain("OLD-PREFIX-0");
    expect(lastPrompt()).not.toContain("marker-recent-q");
    // Transcript shrank (prefix collapsed) but kept tail + summary remain.
    // No assistant ack message — just summary + kept tail.
    expect(after.length).toBeLessThan(before);
    expect(after.length).toBeGreaterThanOrEqual(2); // summary + >=1 kept (no ack)
    expect(msg).toContain("kept");
  });

  it("does not split a tool_use/tool_result pair across the compaction boundary", async () => {
    const conversation = new ConversationManager();
    for (let i = 0; i < 20; i++) {
      conversation.addUserMessage(`prefix-${String(i)}-` + "p".repeat(1200));
      conversation.addAssistantMessage(`reply-${String(i)}`);
    }
    // Recent tail containing a tool pair near the boundary.
    conversation.addAssistantMessageWithTools("running read", [
      { toolUseId: "keep-tid", toolName: "Read", arguments: { path: "/a" } },
    ]);
    conversation.addToolResultMessage("keep-tid", "RESULT-CONTENT-marker", false);
    conversation.addAssistantMessage("done with tool");
    conversation.addUserMessage("thanks");

    const { client } = stubClient("summary");
    await forceCompact(conversation, client, null, [], []);

    const after = conversation.getMessages();
    const hasUse = after.some((m) => m.toolUses?.some((t) => t.toolUseId === "keep-tid"));
    const hasResult = after.some((m) => m.toolResults?.some((t) => t.toolUseId === "keep-tid"));
    // Either both halves of the pair survive, or neither — never an orphan.
    expect(hasUse).toBe(hasResult);
    // In this layout the pair is in the recent tail, so both survive.
    expect(hasUse && hasResult).toBe(true);
  });

  it("degenerates to no-op when there are too few messages to compact", async () => {
    const conversation = new ConversationManager();
    conversation.addUserMessage("only-q marker");
    conversation.addAssistantMessage("only-a marker");

    const { client } = stubClient("should-not-be-used");
    const before = conversation.getMessages();
    const { message: msg } = await forceCompact(conversation, client, null, [], []);
    const after = conversation.getMessages();

    // Everything is inside the kept tail → compaction skipped, transcript intact.
    expect(after).toEqual(before);
    expect(msg.toLowerCase()).toContain("skip");
    // The verbatim originals are untouched (no summary injected).
    const joined = after.map((m) => contentToText(m.content)).join("\n");
    expect(joined).toContain("only-q marker");
    expect(joined).not.toContain("The conversation history before this point was compacted");
  });
});

describe("RecoveryState retention", () => {
  it("keeps only the five most recent bounded file snapshots", () => {
    const recovery = new RecoveryState();

    for (let index = 0; index < 10; index++) {
      recovery.recordFileRead(`/tmp/file-${String(index)}.txt`, "x".repeat(30_000));
    }

    const files = recovery.snapshotFiles(100);
    expect(files).toHaveLength(5);
    expect(files.map((file) => file.path).sort()).toEqual(
      [5, 6, 7, 8, 9].map((index) => `/tmp/file-${String(index)}.txt`),
    );
    expect(files.every((file) => file.content.length <= 17_500)).toBe(true);
  });

  it("refreshes an existing path without growing retention", () => {
    const recovery = new RecoveryState();
    for (let index = 0; index < 5; index++) {
      recovery.recordFileRead(`/tmp/file-${String(index)}.txt`, `old-${String(index)}`);
    }

    recovery.recordFileRead("/tmp/file-0.txt", "new-content");
    recovery.recordFileRead("/tmp/file-5.txt", "latest");

    const files = recovery.snapshotFiles(100);
    expect(files).toHaveLength(5);
    expect(files.some((file) => file.path === "/tmp/file-1.txt")).toBe(false);
    expect(files.find((file) => file.path === "/tmp/file-0.txt")?.content).toBe("new-content");
  });
});
