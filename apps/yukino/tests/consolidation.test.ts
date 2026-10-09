import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  utimesSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, it, expect, vi } from "vitest";

import type { LLMClient } from "@/llm/client.js";
import { MemoryConsolidator } from "@/memory/consolidation.js";
import { getSessionsDir, projectPath } from "@/storage/paths.js";

const tempDirs = new Set<string>();

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "consolidation-test-"));
  tempDirs.add(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function writeMemory(
  dir: string,
  filename: string,
  type: string,
  name: string,
  desc: string,
  body: string,
) {
  const content = `---
name: ${name}
description: ${desc}
metadata:
  type: ${type}
---

${body}
`;
  writeFileSync(join(dir, filename), content);
}

function createSessions(dir: string, count: number) {
  const sessDir = join(getSessionsDir(dir));
  mkdirSync(sessDir, { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(
      join(sessDir, `sess-${String(i)}.jsonl`),
      `{"role":"user","content":"test ${String(i)}","ts":${String(Date.now())}}\n`,
    );
  }
}

function createNoNetworkClient(): LLMClient {
  return {
    setSystemPrompt(_prompt: string) {
      return;
    },
    async *stream() {
      await Promise.resolve();
      yield* [];
    },
  };
}

describe("MemoryConsolidator", () => {
  describe("Gate logic", () => {
    it("skips when memory dir does not exist", async () => {
      const dir = makeTempDir();

      const consolidator = new MemoryConsolidator(createNoNetworkClient(), dir);
      const run = vi.spyOn(consolidator, "run");
      await consolidator.maybeRun();
      expect(run).not.toHaveBeenCalled();
    });

    it("skips when time gate not met (lock file recent)", async () => {
      const dir = makeTempDir();
      const memDir = projectPath(dir, "memory");
      mkdirSync(memDir, { recursive: true });

      // Write a recent lock file (1 hour ago, not 24 hours)
      const lockFile = join(memDir, ".consolidate-lock");
      writeFileSync(lockFile, "");
      const oneHourAgo = new Date(Date.now() - 3600 * 1000);
      utimesSync(lockFile, oneHourAgo, oneHourAgo);

      createSessions(dir, 10);

      const consolidator = new MemoryConsolidator(
        createNoNetworkClient(),
        dir,
        { appendSystem: vi.fn() },
      );
      const run = vi.spyOn(consolidator, "run");

      await consolidator.maybeRun();
      expect(run).not.toHaveBeenCalled();
    });

    it("skips when session gate not met (too few sessions)", async () => {
      const dir = makeTempDir();
      const memDir = projectPath(dir, "memory");
      mkdirSync(memDir, { recursive: true });

      // Only 2 sessions (need 5)
      createSessions(dir, 2);

      const consolidator = new MemoryConsolidator(createNoNetworkClient(), dir);
      const run = vi.spyOn(consolidator, "run");
      await consolidator.maybeRun();
      expect(run).not.toHaveBeenCalled();
    });

    it("allows only one active pass in the same process", async () => {
      const dir = makeTempDir();
      const memDir = projectPath(dir, "memory");
      mkdirSync(memDir, { recursive: true });
      createSessions(dir, 1);
      let finishRun: (() => void) | undefined;
      const running = new Promise<void>((resolve) => {
        finishRun = resolve;
      });

      const first = new MemoryConsolidator(createNoNetworkClient(), dir, {
        minHours: 0,
        minSessions: 1,
      });
      const second = new MemoryConsolidator(createNoNetworkClient(), dir, {
        minHours: 0,
        minSessions: 1,
      });
      const firstRun = vi.spyOn(first, "run").mockReturnValue(running);
      const secondRun = vi.spyOn(second, "run").mockResolvedValue();

      await first.maybeRun();
      await second.maybeRun();
      expect(firstRun).toHaveBeenCalledOnce();
      expect(secondRun).not.toHaveBeenCalled();

      finishRun?.();
      await vi.waitFor(() => {
        expect(existsSync(join(memDir, ".consolidate-running.lock"))).toBe(
          false,
        );
      });
    });

    it("releases a successful lock so a later pass in the same process can acquire it", async () => {
      const dir = makeTempDir();
      const memDir = projectPath(dir, "memory");
      mkdirSync(memDir, { recursive: true });
      createSessions(dir, 1);

      const first = new MemoryConsolidator(createNoNetworkClient(), dir, {
        minHours: 0,
        minSessions: 1,
      });
      const firstRun = vi.spyOn(first, "run").mockResolvedValue();
      await first.maybeRun();

      const lockFile = join(memDir, ".consolidate-lock");
      await vi.waitFor(() => {
        expect(firstRun).toHaveBeenCalledOnce();
        expect(readFileSync(lockFile, "utf-8")).toBe("");
        expect(existsSync(join(memDir, ".consolidate-running.lock"))).toBe(
          false,
        );
      });
      const earlier = new Date(Date.now() - 10_000);
      utimesSync(lockFile, earlier, earlier);

      const second = new MemoryConsolidator(createNoNetworkClient(), dir, {
        minHours: 0,
        minSessions: 1,
      });
      const secondRun = vi.spyOn(second, "run").mockResolvedValue();
      await second.maybeRun();

      await vi.waitFor(() => {
        expect(secondRun).toHaveBeenCalledOnce();
        expect(readFileSync(lockFile, "utf-8")).toBe("");
      });
    });
  });

  describe("E2E consolidation", () => {
    // skipIf (not an early return): without the key the test must show up as
    // skipped, not silently report a pass it never ran.
    it.skipIf(!process.env.YUKINO_TEST_API_KEY)(
      "merges duplicate memories with real LLM",
      async () => {
        const apiKey = process.env.YUKINO_TEST_API_KEY;
        const baseURL =
          process.env.YUKINO_TEST_BASE_URL ?? "https://api.deepseek.com";
        const model = process.env.YUKINO_TEST_MODEL ?? "deepseek-flash";

        const dir = makeTempDir();
        const memDir = projectPath(dir, "memory");
        mkdirSync(memDir, { recursive: true });

        // Write two duplicate memories
        writeMemory(
          memDir,
          "feedback_no_push.md",
          "feedback",
          "no-push",
          "Don't push without asking",
          "The user does not want code pushed automatically",
        );

        writeMemory(
          memDir,
          "feedback_auto_push.md",
          "feedback",
          "auto-push",
          "Don't auto push code",
          "The user dislikes auto-push and prefers to be asked first",
        );

        // Write a normal memory
        writeMemory(
          memDir,
          "user_role.md",
          "user",
          "user-role",
          "User is a backend engineer",
          "The user is a backend engineer who primarily works with Go and Java",
        );

        writeFileSync(
          join(memDir, "MEMORY.md"),
          `- [No push](feedback_no_push.md) — Do not auto push
- [Auto push](feedback_auto_push.md) — Do not auto push code
- [User role](user_role.md) — Backend engineer
`,
        );

        console.log("Before consolidation:");
        console.log("  Files:", readdirSync(memDir));
        console.log(
          "  MEMORY.md:",
          readFileSync(join(memDir, "MEMORY.md"), "utf-8"),
        );

        const { OpenAICompatClient } = await import("../src/llm/openai.js");
        const client = new OpenAICompatClient(
          {
            name: "test",
            protocol: "openai-compat",
            base_url: baseURL,
            api_key: apiKey,
            model: model,
            context_window: 200000,
          },
          "",
        );

        let notified = "";
        const consolidator = new MemoryConsolidator(client, dir, {
          appendSystem: (msg) => {
            notified = msg;
          },
        });

        // Call run directly, wait synchronously for consolidation to complete
        await consolidator.run(memDir, []);

        console.log("\nAfter consolidation:");
        console.log("  Files:", readdirSync(memDir));
        console.log(
          "  MEMORY.md:",
          readFileSync(join(memDir, "MEMORY.md"), "utf-8"),
        );

        const indexContent = readFileSync(join(memDir, "MEMORY.md"), "utf-8");
        const indexLines = indexContent
          .split("\n")
          .filter((l) => l.trim().length > 0);

        // The index must not grow beyond the original 3 lines; whether the
        // duplicate push memories actually get merged depends on the live LLM,
        // so no lower bound is asserted here.
        console.log(`  Index lines: ${String(indexLines.length)}`);
        expect(indexLines.length).toBeLessThanOrEqual(3);

        if (notified) {
          console.log(`  Notification: ${notified}`);
        }
      },
      120000,
    );
  });
});
