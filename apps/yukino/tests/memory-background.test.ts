import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConversationManager } from "@yukino.js/conversation";
import type { LLMClient } from "@yukino.js/llm/client.js";
import type { StreamEvent } from "@yukino.js/llm/events.js";
import { BackgroundMemoryTasks } from "@yukino.js/memory/background.js";
import { MemoryConsolidator } from "@yukino.js/memory/consolidation.js";
import { MemoryExtractor } from "@yukino.js/memory/extractor.js";
import { projectPath } from "@yukino.js/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cwd of directories.splice(0)) {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(projectPath(cwd), { recursive: true, force: true });
  }
});

function directory(): string {
  const cwd = mkdtempSync(join(tmpdir(), "yukino-memory-lifecycle-"));
  directories.push(cwd);
  return cwd;
}

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

function blockingClient() {
  let started = false;
  const client: LLMClient = {
    setSystemPrompt: vi.fn(),
    async *stream(_conversation, _tools, signal) {
      started = true;
      yield {
        type: "text_delta",
        text: "MEMORY_NAME: cancelled\nMEMORY_TYPE: project\nMEMORY_BODY: must not be saved",
      };
      await new Promise<void>((resolve) => {
        signal?.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
      });
      yield end;
    },
  };
  return { client, started: () => started };
}

describe("background memory ownership", () => {
  it("coalesces turns, consumes only new messages and survives compaction", async () => {
    const cwd = directory();
    let release: (names: string[]) => void = () => undefined;
    const extract = vi
      .spyOn(MemoryExtractor.prototype, "extract")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue([]);
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream() {
        await Promise.resolve();
        yield end;
      },
    };
    const tasks = new BackgroundMemoryTasks(client, cwd);
    const conv = new ConversationManager();
    conv.addUserMessage("first user message");
    conv.addAssistantFull("first assistant response", [], []);
    tasks.run(conv);
    conv.addUserMessage("second user message");
    conv.addAssistantFull("second assistant response", [], []);
    tasks.run(conv);
    conv.addUserMessage("third user message");
    conv.addAssistantFull("third assistant response", [], []);
    tasks.run(conv);
    expect(extract).toHaveBeenCalledTimes(1);
    release([]);
    await vi.waitFor(() => {
      expect(extract).toHaveBeenCalledTimes(2);
    });
    expect(extract.mock.calls[1][0]).toContain("second user message");
    expect(extract.mock.calls[1][0]).toContain("third user message");
    expect(extract.mock.calls[1][0]).not.toContain("first user message");
    conv.reset();
    conv.addUserMessage("compacted context");
    conv.addAssistantFull("new reply after compaction", [], []);
    tasks.run(conv);
    await vi.waitFor(() => {
      expect(extract).toHaveBeenCalledTimes(3);
    });
    expect(extract.mock.calls[2][0]).toContain("compacted context");
    await tasks.dispose();
    tasks.run(conv);
    expect(extract).toHaveBeenCalledTimes(3);
  });

  it("does not write text fallback memories after cancellation", async () => {
    const cwd = directory();
    const { client, started } = blockingClient();
    const extractor = new MemoryExtractor(client, cwd);
    const result = extractor
      .extract("some conversation")
      .catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(started()).toBe(true);
    });
    await extractor.dispose();
    await result;
    expect(existsSync(projectPath(cwd, "memory", "cancelled.md"))).toBe(false);
  });

  it("does not mark cancelled consolidation successful or retain its lock", async () => {
    const cwd = directory();
    mkdirSync(projectPath(cwd, "memory"), { recursive: true });
    const { client, started } = blockingClient();
    const appendSystem = vi.fn();
    const consolidator = new MemoryConsolidator(client, cwd, {
      minHours: 0,
      minSessions: 0,
      appendSystem,
    });
    await consolidator.maybeRun();
    await vi.waitFor(() => {
      expect(started()).toBe(true);
    });
    await consolidator.dispose();
    expect(existsSync(projectPath(cwd, "memory", ".consolidate-lock"))).toBe(
      false,
    );
    expect(appendSystem).not.toHaveBeenCalled();
  });
});
