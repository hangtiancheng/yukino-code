import { describe, expect, it, vi } from "vitest";

import type { Message } from "@/conversation/index.js";
import { buildAnalysisPrompt } from "@/feedback/analyze.js";
import type { AnalyzeInput } from "@/feedback/analyze.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";

function stubClient(): LLMClient {
  return {
    stream: async function* (): AsyncGenerator<StreamEvent> {
      await Promise.resolve();
      yield* [];
    },
    setSystemPrompt: vi.fn(),
  };
}

function makeMessages(count: number, chars = 490): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${String(i)} ${"x".repeat(chars)}`,
    });
  }
  return messages;
}

function makeLog(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(JSON.stringify({ level: 50, line: i, pad: "y".repeat(60) }));
  }
  return out.join("\n");
}

function promptInput(overrides: Partial<AnalyzeInput>): AnalyzeInput {
  return {
    client: stubClient(),
    messages: [],
    logContent: null,
    description: "",
    filedIssues: [],
    contextWindow: 200_000,
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe("buildAnalysisPrompt budget", () => {
  it("keeps the whole prompt inside a tiny real context window", () => {
    // 8k provider: without shared budgeting the old floor (32k) plus the
    // 200k-char log section would overflow the real window many times over.
    const prompt = buildAnalysisPrompt(
      promptInput({
        contextWindow: 8_000,
        messages: makeMessages(200),
        logContent: makeLog(4_000),
      }),
    );

    // Bounded: instructions (~2k chars) + log quarter + conversation rest.
    expect(prompt.length).toBeLessThan(20_000);
    // Conversation truncated to the recent tail.
    expect(prompt).toContain("msg-199");
    expect(prompt).not.toContain("msg-0 ");
    expect(prompt).toContain("messages of the session were omitted");
    // Log scaled down and tail-kept.
    expect(prompt).toContain('"line":3999');
    expect(prompt).not.toContain('"line":0,');
    const logMatch = /<yukino-log>\n([\s\S]*?)\n<\/yukino-log>/.exec(prompt);
    expect(logMatch).toBeTruthy();
    expect(logMatch?.[1].length).toBeLessThanOrEqual(2_000);
  });

  it("caps the log at MAX_LOG_CHARS for very large windows", () => {
    const bigLog = `${"z".repeat(100_000)}\n${makeLog(50)}`;
    const prompt = buildAnalysisPrompt(
      promptInput({
        contextWindow: 1_000_000,
        messages: makeMessages(3),
        logContent: bigLog,
      }),
    );
    const logMatch = /<yukino-log>\n([\s\S]*?)\n<\/yukino-log>/.exec(prompt);
    expect(logMatch).toBeTruthy();
    // 100k filler + ~4k log; the cap (200k) trims the filler, keeps the tail.
    expect(logMatch?.[1].length).toBeLessThanOrEqual(200_000);
    expect(logMatch?.[1]).toContain('"line":49');
  });

  it("still produces a well-formed prompt for a minimal window", () => {
    const prompt = buildAnalysisPrompt(
      promptInput({
        contextWindow: 1_000,
        messages: makeMessages(50),
        logContent: makeLog(500),
        description: "权限弹窗卡死",
      }),
    );
    expect(prompt).toContain("ONLY a JSON object");
    expect(prompt).toContain("权限弹窗卡死");
    expect(prompt.length).toBeLessThan(20_000);
  });

  it("splits multiple defects and lists already-filed issues", () => {
    const prompt = buildAnalysisPrompt(
      promptInput({
        filedIssues: [
          {
            fingerprint: "fp",
            title: "[tool] Bash retry storm",
            url: "https://example.com/issues/1",
            channel: "gh",
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    expect(prompt).toContain("[tool] Bash retry storm");
    expect(prompt).toContain("One issue per distinct defect");
  });
});
