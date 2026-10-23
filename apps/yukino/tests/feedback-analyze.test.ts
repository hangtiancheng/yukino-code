import type { Message } from "@yukino.js/conversation";
import { analyzeHarnessAnomalies } from "@yukino.js/feedback/analyze.js";
import type { AnalyzeInput } from "@yukino.js/feedback/analyze.js";
import {
  ANALYSIS_INSTRUCTIONS,
  buildAnalysisPrompt,
} from "@yukino.js/feedback/prompts.js";
import { describe, expect, it, vi } from "vitest";

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
    runAgent: vi.fn(() => Promise.resolve('{"issues":[]}')),
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
    expect(logMatch?.[1].length).toBeLessThanOrEqual(2_100);
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

  it("caps large sessions independently of a million-token provider window", () => {
    const prompt = buildAnalysisPrompt(
      promptInput({
        contextWindow: 1_000_000,
        messages: makeMessages(10_000),
        logContent: makeLog(10_000),
      }),
    );
    expect(prompt.length).toBeLessThan(115_000);
    expect(prompt).toContain("msg-9999");
    expect(prompt).not.toContain("msg-0 ");
    expect(prompt).not.toContain(ANALYSIS_INSTRUCTIONS);
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
    expect(ANALYSIS_INSTRUCTIONS).toContain("One issue per distinct defect");
  });

  it("bounds a single oversized tool result and user report", () => {
    const prompt = buildAnalysisPrompt(
      promptInput({
        contextWindow: 32_000,
        description: "report ".repeat(100_000),
        messages: [
          {
            role: "user",
            content: "",
            toolResults: [
              {
                toolUseId: "t1",
                content: "x".repeat(1_000_000) + "FAILURE_TAIL",
                isError: true,
              },
            ],
          },
        ],
      }),
    );
    expect(prompt.length).toBeLessThan(60_000);
    expect(prompt).toContain("FAILURE_TAIL");
    expect(prompt).toContain("truncated");
  });
});

describe("analyzeHarnessAnomalies", () => {
  it("waits for the foreground worker and includes the analysis assignment", async () => {
    let release!: (result: string) => void;
    const runAgent = vi.fn(
      (_prompt: string) =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const result = analyzeHarnessAnomalies(
      promptInput({ runAgent, description: "权限弹窗卡死" }),
    );
    expect(runAgent).toHaveBeenCalledOnce();
    const prompt = runAgent.mock.calls[0][0];
    expect(prompt).toContain(ANALYSIS_INSTRUCTIONS);
    expect(prompt).toContain("权限弹窗卡死");
    expect(prompt).toContain("inherited main-agent conversation");
    expect(prompt).toContain(
      "Do not modify project files, upload attachments, or file issues",
    );
    release('{"issues":[{"title":"[ui] Lost input","body":"evidence"}]}');
    await expect(result).resolves.toEqual([
      { title: "[ui] Lost input", body: "evidence" },
    ]);
  });

  it("retries malformed output with the complete assignment and evidence", async () => {
    const runAgent = vi
      .fn<AnalyzeInput["runAgent"]>()
      .mockResolvedValueOnce('{"issues":[{"title":"')
      .mockResolvedValueOnce(
        '{"issues":[{"title":"[tool] Retry","body":"evidence"}]}',
      );
    await expect(
      analyzeHarnessAnomalies(
        promptInput({ runAgent, description: "A reported defect" }),
      ),
    ).resolves.toEqual([{ title: "[tool] Retry", body: "evidence" }]);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[1][0]).toContain(runAgent.mock.calls[0][0]);
    expect(runAgent.mock.calls[1][0]).toContain("not valid issue JSON");
  });

  it("accepts an empty issue list without retrying", async () => {
    const runAgent = vi.fn(() => Promise.resolve('{"issues":[]}'));
    await expect(
      analyzeHarnessAnomalies(promptInput({ runAgent })),
    ).resolves.toEqual([]);
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("leaves description fallback to the pipeline after unusable replies", async () => {
    const runAgent = vi.fn(() => Promise.resolve("not issue JSON"));
    await expect(
      analyzeHarnessAnomalies(
        promptInput({ runAgent, description: "权限弹窗卡死" }),
      ),
    ).rejects.toThrow("valid issue JSON after retry");
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it("propagates worker failures without starting another run", async () => {
    const runAgent = vi.fn(() => Promise.reject(new Error("Worker failed")));
    await expect(
      analyzeHarnessAnomalies(promptInput({ runAgent })),
    ).rejects.toThrow("Worker failed");
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("does not start a worker after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const runAgent = vi.fn(() => Promise.resolve('{"issues":[]}'));
    await expect(
      analyzeHarnessAnomalies(
        promptInput({ runAgent, abortSignal: controller.signal }),
      ),
    ).rejects.toThrow();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects output arriving after cancellation without retrying", async () => {
    const controller = new AbortController();
    const runAgent = vi.fn(() => {
      controller.abort();
      return Promise.resolve(
        '{"issues":[{"title":"[tool] Late reply","body":"evidence"}]}',
      );
    });
    await expect(
      analyzeHarnessAnomalies(
        promptInput({ runAgent, abortSignal: controller.signal }),
      ),
    ).rejects.toThrow();
    expect(runAgent).toHaveBeenCalledOnce();
  });
});
