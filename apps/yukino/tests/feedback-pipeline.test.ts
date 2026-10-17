import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  issueFingerprint,
  loadFiledIssues,
  recordFiledIssues,
} from "@/feedback/dedup.js";
import type * as feedbackGithub from "@/feedback/github.js";
import type { IssueResult } from "@/feedback/github.js";
import { runFeedbackPipeline } from "@/feedback/pipeline.js";
import type { CollectedFile, FeedbackChannel } from "@/feedback/types.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent, UsageInfo } from "@/llm/events.js";
import { sessionPath } from "@/storage/paths.js";

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
    const report = await runFeedbackPipeline(
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
    const report = await runFeedbackPipeline(
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
    const report = await runFeedbackPipeline(
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
    const report = await runFeedbackPipeline(
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
    expect(loadFiledIssues(SESSION)[0].channel).toBe("browser");
  });

  it("falls back to a description issue when analysis output is unparseable", async () => {
    mocks.createIssue.mockResolvedValue({
      url: "https://github.com/hangtiancheng/yukino-code/issues/3",
      number: 3,
    });
    const client = fakeClient("I looked but cannot say anything definitive.");
    const report = await runFeedbackPipeline(
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
    const report = await runFeedbackPipeline(
      { description: "", attachments: ["env"] },
      deps,
    );
    const progress = deps.onProgress.mock.calls
      .map((call) => call[0])
      .join("\n");
    expect(progress).toContain("Gist upload failed");
    expect(report).toContain("issues/4");
    expect(report).toContain("exported locally");
    expect(bundleFiles().some((f) => f.endsWith(".zip"))).toBe(true);
    // The issue body points at the local bundle, not a gist.
    const body: string = mocks.createIssue.mock.calls[0][2];
    expect(body).toContain("not uploaded");
  });

  it("files the description when the analysis stream itself fails", async () => {
    mocks.createIssue.mockResolvedValue({
      url: "https://github.com/hangtiancheng/yukino-code/issues/5",
      number: 5,
    });
    const report = await runFeedbackPipeline(
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
});
