import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { feedbackLogPath } from "@/feedback/collect.js";
import {
  issueFingerprint,
  loadFiledIssues,
  recordFiledIssues,
} from "@/feedback/dedup.js";
import type * as feedbackGithub from "@/feedback/github.js";
import type { IssueResult } from "@/feedback/github.js";
import { runFeedbackPipeline } from "@/feedback/pipeline.js";
import type {
  CollectedFile,
  FeedbackChannel,
  IssueDraft,
} from "@/feedback/types.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent, UsageInfo } from "@/llm/events.js";
import { closeLogger, initLogger } from "@/logger/index.js";
import { saveCompactBoundary, saveMessage } from "@/session/index.js";
import { sessionPath } from "@/storage/index.js";

const mocks = vi.hoisted(() => ({
  detectChannel: vi.fn<() => Promise<FeedbackChannel>>(),
  createGist:
    vi.fn<
      (
        channel: "gh" | "token",
        files: CollectedFile[],
        description: string,
        abortSignal?: AbortSignal,
      ) => Promise<string>
    >(),
  createIssue:
    vi.fn<
      (
        channel: "gh" | "token",
        title: string,
        body: string,
        labels: string[],
        abortSignal?: AbortSignal,
      ) => Promise<IssueResult>
    >(),
  fetchRepoLabels:
    vi.fn<
      (channel: "gh" | "token", abortSignal?: AbortSignal) => Promise<string[]>
    >(),
  openInBrowser: vi.fn<(url: string) => void>(),
}));

vi.mock("@/feedback/github.js", async (importOriginal) => {
  const original = await importOriginal<typeof feedbackGithub>();
  return { ...original, ...mocks };
});

const SESSION = "pipeline-test-session";

const USAGE: UsageInfo = {
  inputTokens: 10,
  outputTokens: 10,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

/** Client whose every stream call replies with the same canned text. */
function fakeClient(reply: string): LLMClient {
  return {
    stream: async function* (): AsyncGenerator<StreamEvent> {
      await Promise.resolve();
      yield { type: "text_delta", text: reply };
      yield { type: "stream_end", stopReason: "end_turn", usage: USAGE };
    },
    setSystemPrompt: vi.fn(),
  };
}

/** Client whose stream always fails on the first pull. */
function explodingClient(): LLMClient {
  return {
    stream: async function* (): AsyncGenerator<StreamEvent> {
      await Promise.resolve();
      yield* [];
      throw new Error("provider exploded");
    },
    setSystemPrompt: vi.fn(),
  };
}

function analysisReply(issues: { title: string; body: string }[]): string {
  return JSON.stringify({ issues });
}

function makeDeps(client: LLMClient, cwd: string) {
  return {
    cwd,
    sessionId: SESSION,
    client,
    messages: [],
    runtime: {
      provider: { name: "anthropic", model: "claude-sonnet-x" },
      permissionMode: "default",
    },
    contextWindow: 200_000,
    abortSignal: new AbortController().signal,
    onProgress: vi.fn<(message: string) => void>(),
    confirmIssues: vi.fn((_issues: IssueDraft[]) =>
      Promise.resolve({ approved: true }),
    ),
  };
}

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "yukino-feedback-pipeline-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function bundleFiles(): string[] {
  const dir = sessionPath(SESSION, "feedback");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir);
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.detectChannel.mockResolvedValue("gh");
  mocks.fetchRepoLabels.mockResolvedValue(["bug", "yukino-feedback"]);
  mocks.createGist.mockResolvedValue("https://gist.github.com/gist123");
});

describe("runFeedbackPipeline", () => {
  it("files one issue per detected defect via gh with a gist attachment", async () => {
    mocks.createIssue
      .mockResolvedValueOnce({
        url: "https://github.com/hangtiancheng/yukino-code/issues/1",
        number: 1,
      })
      .mockResolvedValueOnce({
        url: "https://github.com/hangtiancheng/yukino-code/issues/2",
        number: 2,
      });
    const client = fakeClient(
      analysisReply([
        { title: "[tool] Bash retry storm", body: "## What happened\nLoop." },
        { title: "[ui] Render corruption", body: "## What happened\nGarbled." },
      ]),
    );
    const { report } = await runFeedbackPipeline(
      { description: "", attachments: ["env"] },
      makeDeps(client, makeProject()),
    );

    expect(report).toContain("Filed 2 issue(s) via gh");
    expect(report).toContain("issues/1");
    expect(report).toContain("issues/2");
    expect(report).toContain("https://gist.github.com/gist123");

    // Gist carried the environment attachment.
    const gistFiles = mocks.createGist.mock.calls[0][1];
    expect(gistFiles.map((f) => f.name)).toContain("environment.json");

    // Issue bodies embed the model analysis and the footer.
    const issueBody = mocks.createIssue.mock.calls[0][2];
    expect(issueBody).toContain("What happened");
    expect(issueBody).toContain("Reported via /feedback");

    // Both issues recorded for session dedup.
    const filed = loadFiledIssues(SESSION);
    expect(filed.map((r) => r.title)).toEqual([
      "[tool] Bash retry storm",
      "[ui] Render corruption",
    ]);
    expect(filed[0].channel).toBe("gh");
    expect(filed[0].gistUrl).toBe("https://gist.github.com/gist123");
  });

  it("files nothing when no anomalies and no description", async () => {
    const client = fakeClient(analysisReply([]));
    const { report } = await runFeedbackPipeline(
      { description: "", attachments: ["env"] },
      makeDeps(client, makeProject()),
    );
    expect(report).toContain("No yukino harness anomalies detected");
    expect(mocks.createIssue).not.toHaveBeenCalled();
    expect(mocks.createGist).not.toHaveBeenCalled();
    expect(loadFiledIssues(SESSION)).toEqual([]);
  });

  it("skips issues already filed in this session", async () => {
    recordFiledIssues(SESSION, [
      {
        fingerprint: issueFingerprint("[tool] Bash retry storm"),
        title: "[tool] Bash retry storm",
        url: "https://github.com/hangtiancheng/yukino-code/issues/9",
        channel: "gh",
        createdAt: new Date().toISOString(),
      },
    ]);
    const client = fakeClient(
      analysisReply([
        { title: "tool bash RETRY storm!", body: "same defect again" },
      ]),
    );
    const { report } = await runFeedbackPipeline(
      { description: "", attachments: [] },
      makeDeps(client, makeProject()),
    );
    expect(report).toContain("already filed in this session");
    expect(mocks.createIssue).not.toHaveBeenCalled();
  });

  it("opens prefilled browser pages and exports a zip on the browser channel", async () => {
    mocks.detectChannel.mockResolvedValue("browser");
    const client = fakeClient(
      analysisReply([
        { title: "[context] Compaction loses messages", body: "b" },
      ]),
    );
    const { report } = await runFeedbackPipeline(
      { description: "", attachments: ["env"] },
      makeDeps(client, makeProject()),
    );

    expect(mocks.createIssue).not.toHaveBeenCalled();
    expect(mocks.createGist).not.toHaveBeenCalled();
    expect(mocks.openInBrowser).toHaveBeenCalledTimes(1);
    const url: string = mocks.openInBrowser.mock.calls[0][0];
    expect(url).toContain("/issues/new?title=");
    expect(url).toContain(
      encodeURIComponent("[context] Compaction loses messages"),
    );
    expect(report).toContain("prefilled issue page");

    // Attachments exported as a local zip instead of a gist.
    expect(
      bundleFiles().some((f) => f.startsWith("bundle-") && f.endsWith(".zip")),
    ).toBe(true);
    expect(report).toContain("exported locally");
    expect(loadFiledIssues(SESSION)).toEqual([]);
    await runFeedbackPipeline(
      { description: "", attachments: [] },
      makeDeps(client, makeProject()),
    );
    expect(mocks.openInBrowser).toHaveBeenCalledTimes(2);
  });

  it("falls back to a description issue when analysis output is unparseable", async () => {
    mocks.createIssue.mockResolvedValue({
      url: "https://github.com/hangtiancheng/yukino-code/issues/3",
      number: 3,
    });
    const client = fakeClient("I looked but cannot say anything definitive.");
    const { report } = await runFeedbackPipeline(
      { description: "权限弹窗在 tmux 里卡死", attachments: [] },
      makeDeps(client, makeProject()),
    );
    expect(mocks.createIssue).toHaveBeenCalledTimes(1);
    const title: string = mocks.createIssue.mock.calls[0][1];
    expect(title).toContain("[feedback]");
    expect(title).toContain("权限弹窗");
    expect(report).toContain("issues/3");
  });

  it("exports a local bundle when the gist upload fails, still files issues", async () => {
    mocks.createGist.mockRejectedValue(new Error("gist 422"));
    mocks.createIssue.mockResolvedValue({
      url: "https://github.com/hangtiancheng/yukino-code/issues/4",
      number: 4,
    });
    const client = fakeClient(
      analysisReply([{ title: "[tool] Bash hangs", body: "b" }]),
    );
    const deps = makeDeps(client, makeProject());
    const { report } = await runFeedbackPipeline(
      { description: "", attachments: ["env"] },
      deps,
    );
    const progress = deps.onProgress.mock.calls
      .map((call) => call[0])
      .join("\n");
    expect(progress).toContain("Gist upload failed");
    expect(report).toContain("issues/4");
    expect(report).toContain("exported locally");
    expect(report).toContain("Attachment upload failed: gist 422");
    expect(bundleFiles().some((f) => f.endsWith(".zip"))).toBe(true);
    // The issue body points at the local bundle, not a gist.
    const body: string = mocks.createIssue.mock.calls[0][2];
    expect(body).toContain("not uploaded");
    expect(body).toContain("Attachment upload failed: gist 422");
  });

  it("redacts and persists attachment upload errors", async () => {
    const secret = "feedback-upload-secret";
    mocks.createGist.mockRejectedValue(
      new Error(`Gist rejected token ${secret}`),
    );
    mocks.createIssue.mockResolvedValue({
      url: "https://github.com/hangtiancheng/yukino-code/issues/4",
    });
    const client = fakeClient(
      analysisReply([{ title: "[tool] Bash hangs", body: "b" }]),
    );
    const deps = makeDeps(client, makeProject());
    initLogger({ sessionId: SESSION, mode: "terminal", skipCleanup: true });
    try {
      const { report } = await runFeedbackPipeline(
        { description: "", attachments: ["env"] },
        { ...deps, runtime: { ...deps.runtime, config: { api_key: secret } } },
      );
      const body: string = mocks.createIssue.mock.calls[0][2];
      const log = readFileSync(feedbackLogPath(SESSION), "utf-8");
      const progress = deps.onProgress.mock.calls
        .map(([message]) => message)
        .join("\n");
      for (const output of [report, body, log, progress]) {
        expect(output).toContain("Gist rejected token <redacted>");
        expect(output).not.toContain(secret);
      }
      expect(log).toContain("Feedback attachment upload failed");
    } finally {
      closeLogger();
    }
  });

  it("files the description when the analysis stream itself fails", async () => {
    mocks.createIssue.mockResolvedValue({
      url: "https://github.com/hangtiancheng/yukino-code/issues/5",
      number: 5,
    });
    const { report } = await runFeedbackPipeline(
      { description: "compact 之后工具调用配对错乱", attachments: [] },
      makeDeps(explodingClient(), makeProject()),
    );
    expect(mocks.createIssue).toHaveBeenCalledTimes(1);
    expect(report).toContain("issues/5");
  });

  it("rethrows analysis failure when there is no description to fall back to", async () => {
    await expect(
      runFeedbackPipeline(
        { description: "", attachments: [] },
        makeDeps(explodingClient(), makeProject()),
      ),
    ).rejects.toThrow("provider exploded");
  });

  it.each(["max_tokens", "end_turn"])(
    "does not report no anomalies after two unusable %s replies",
    async (stopReason) => {
      const client = fakeClient("");
      const stream = vi
        .spyOn(client, "stream")
        .mockImplementation(async function* () {
          await Promise.resolve();
          yield { type: "text_delta", text: '{"issues":[{"title":"' };
          yield { type: "stream_end", stopReason, usage: USAGE };
        });
      const deps = makeDeps(client, makeProject());
      await expect(
        runFeedbackPipeline({ description: "", attachments: [] }, deps),
      ).rejects.toThrow(
        stopReason === "max_tokens"
          ? "max_tokens after retry"
          : "valid issue JSON after retry",
      );
      expect(stream).toHaveBeenCalledTimes(2);
      expect(deps.confirmIssues).not.toHaveBeenCalled();
      expect(mocks.detectChannel).not.toHaveBeenCalled();
      expect(mocks.createIssue).not.toHaveBeenCalled();
    },
  );

  it("asks for approval once per round and files all issues when approved", async () => {
    mocks.createIssue
      .mockResolvedValueOnce({
        url: "https://github.com/hangtiancheng/yukino-code/issues/21",
        number: 21,
      })
      .mockResolvedValueOnce({
        url: "https://github.com/hangtiancheng/yukino-code/issues/22",
        number: 22,
      });
    const client = fakeClient(
      analysisReply([
        { title: "[tool] Bash retry storm", body: "b1" },
        { title: "[ui] Render corruption", body: "b2" },
      ]),
    );
    const confirmIssues = vi.fn((_issues: IssueDraft[]) =>
      Promise.resolve({ approved: true }),
    );
    const deps = makeDeps(client, makeProject());
    const { report, rejection } = await runFeedbackPipeline(
      { description: "", attachments: [] },
      { ...deps, confirmIssues },
    );

    // One confirmation for the whole batch, carrying both drafts.
    expect(confirmIssues).toHaveBeenCalledTimes(1);
    const presented = confirmIssues.mock.calls[0][0];
    expect(presented.map((d) => d.title)).toEqual([
      "[tool] Bash retry storm",
      "[ui] Render corruption",
    ]);
    expect(mocks.createIssue).toHaveBeenCalledTimes(2);
    expect(report).toContain("issues/21");
    expect(report).toContain("issues/22");
    expect(rejection).toBeUndefined();
  });

  it("files nothing and reports the reason when the user rejects", async () => {
    const client = fakeClient(
      analysisReply([{ title: "[tool] Bash retry storm", body: "b" }]),
    );
    const confirmIssues = vi.fn((_issues: IssueDraft[]) =>
      Promise.resolve({
        approved: false,
        reason: "这是我项目代码的问题，不是 yukino 的缺陷",
      }),
    );
    const deps = makeDeps(client, makeProject());
    const result = await runFeedbackPipeline(
      { description: "", attachments: ["env"] },
      { ...deps, confirmIssues },
    );

    expect(result.report).toContain("Issue filing rejected");
    expect(result.report).toContain("这是我项目代码的问题，不是 yukino 的缺陷");
    expect(result.rejection).toEqual({
      issues: [{ title: "[tool] Bash retry storm", body: "b" }],
      reason: "这是我项目代码的问题，不是 yukino 的缺陷",
    });
    // Nothing is uploaded or filed after a rejection.
    expect(mocks.createIssue).not.toHaveBeenCalled();
    expect(mocks.createGist).not.toHaveBeenCalled();
    expect(mocks.openInBrowser).not.toHaveBeenCalled();
    expect(loadFiledIssues(SESSION)).toEqual([]);
  });

  it("rejects cleanly without a reason", async () => {
    const client = fakeClient(
      analysisReply([{ title: "[tool] Bash retry storm", body: "b" }]),
    );
    const confirmIssues = vi.fn((_issues: IssueDraft[]) =>
      Promise.resolve({ approved: false }),
    );
    const deps = makeDeps(client, makeProject());
    const result = await runFeedbackPipeline(
      { description: "", attachments: [] },
      { ...deps, confirmIssues },
    );
    expect(result.report).toContain("Issue filing rejected");
    expect(result.rejection?.reason).toBeUndefined();
    expect(mocks.createIssue).not.toHaveBeenCalled();
  });

  it("presents the deduplicated list for approval", async () => {
    recordFiledIssues(SESSION, [
      {
        fingerprint: issueFingerprint("[tool] Bash retry storm"),
        title: "[tool] Bash retry storm",
        url: "https://github.com/hangtiancheng/yukino-code/issues/9",
        channel: "gh",
        createdAt: new Date().toISOString(),
      },
    ]);
    const client = fakeClient(
      analysisReply([
        { title: "tool bash retry storm", body: "dup" },
        { title: "[ui] Render corruption", body: "fresh" },
      ]),
    );
    const confirmIssues = vi.fn((_issues: IssueDraft[]) =>
      Promise.resolve({ approved: false }),
    );
    const deps = makeDeps(client, makeProject());
    await runFeedbackPipeline(
      { description: "", attachments: [] },
      { ...deps, confirmIssues },
    );
    expect(confirmIssues).toHaveBeenCalledTimes(1);
    const presented = confirmIssues.mock.calls[0][0];
    expect(presented.map((d) => d.title)).toEqual(["[ui] Render corruption"]);
  });

  it("does not upload or open a browser if cancelled during channel detection", async () => {
    const controller = new AbortController();
    mocks.detectChannel.mockImplementation(() => {
      controller.abort();
      return Promise.resolve("browser");
    });
    await expect(
      runFeedbackPipeline(
        { description: "", attachments: ["env"] },
        {
          ...makeDeps(
            fakeClient(analysisReply([{ title: "[ui] Hang", body: "b" }])),
            makeProject(),
          ),
          abortSignal: controller.signal,
        },
      ),
    ).rejects.toThrow();
    expect(mocks.openInBrowser).not.toHaveBeenCalled();
    expect(mocks.createGist).not.toHaveBeenCalled();
    expect(bundleFiles().some((file) => file.endsWith(".zip"))).toBe(false);
  });

  it("retains successfully filed issues if the next submission is cancelled", async () => {
    const controller = new AbortController();
    mocks.createIssue
      .mockResolvedValueOnce({ url: "https://example.com/issues/1", number: 1 })
      .mockImplementationOnce(() => {
        controller.abort();
        return Promise.reject(new DOMException("Cancelled", "AbortError"));
      });
    await expect(
      runFeedbackPipeline(
        { description: "", attachments: [] },
        {
          ...makeDeps(
            fakeClient(
              analysisReply([
                { title: "[tool] First defect", body: "b1" },
                { title: "[ui] Second defect", body: "b2" },
                { title: "[context] Third defect", body: "b3" },
              ]),
            ),
            makeProject(),
          ),
          abortSignal: controller.signal,
        },
      ),
    ).rejects.toThrow();
    expect(mocks.createIssue).toHaveBeenCalledTimes(2);
    expect(loadFiledIssues(SESSION).map((issue) => issue.title)).toEqual([
      "[tool] First defect",
    ]);
  });

  it("analyzes evidence from before compaction even when session attachments are disabled", async () => {
    const cwd = makeProject();
    saveMessage(cwd, SESSION, {
      role: "assistant",
      content: "PRE_COMPACTION_HARNESS_FAILURE",
      timestamp: 1,
    });
    saveCompactBoundary(cwd, SESSION, {
      summary: "Compacted task summary",
      keep: [],
    });
    const client = fakeClient(analysisReply([]));
    const stream = vi.spyOn(client, "stream");
    await runFeedbackPipeline(
      { description: "", attachments: [] },
      makeDeps(client, cwd),
    );
    const prompt = stream.mock.calls[0][0].getMessages()[0].content;
    expect(prompt).toContain("PRE_COMPACTION_HARNESS_FAILURE");
    expect(mocks.createGist).not.toHaveBeenCalled();
  });
});
