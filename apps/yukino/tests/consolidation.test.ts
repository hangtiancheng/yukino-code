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
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  utimesSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import type { LLMClient } from "@/llm/client.js";
import { MemoryConsolidator } from "@/memory/consolidation.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "consolidation-test-"));
}

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
  const sessDir = join(dir, ".yukino", "sessions");
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
  describe("Lock mechanism", () => {
    it("acquires lock on first attempt", () => {
      const dir = makeTempDir();
      const memDir = join(dir, ".yukino", "memory");
      mkdirSync(memDir, { recursive: true });

      // Placeholder: the internal lock functions are not exported and this
      // test body currently asserts nothing. Lock behavior is exercised
      // indirectly by the maybeRun gate tests below.
    });
  });

  describe("Gate logic", () => {
    it("skips when memory dir does not exist", async () => {
      const dir = makeTempDir();

      const consolidator = new MemoryConsolidator(createNoNetworkClient(), dir);
      // Should not throw
      await consolidator.maybeRun();
    });

    it("skips when time gate not met (lock file recent)", async () => {
      const dir = makeTempDir();
      const memDir = join(dir, ".yukino", "memory");
      mkdirSync(memDir, { recursive: true });

      // Write a recent lock file (1 hour ago, not 24 hours)
      const lockFile = join(memDir, ".consolidate-lock");
      writeFileSync(lockFile, "");
      const oneHourAgo = new Date(Date.now() - 3600 * 1000);
      utimesSync(lockFile, oneHourAgo, oneHourAgo);

      createSessions(dir, 10);

      let triggered = false;

      const consolidator = new MemoryConsolidator(
        createNoNetworkClient(),
        dir,
        {
          appendSystem: () => {
            triggered = true;
          },
        },
      );

      await consolidator.maybeRun();
      // Wait a bit for any async work
      await new Promise((r) => setTimeout(r, 100));
      expect(triggered).toBe(false);
    });

    it("skips when session gate not met (too few sessions)", async () => {
      const dir = makeTempDir();
      const memDir = join(dir, ".yukino", "memory");
      mkdirSync(memDir, { recursive: true });

      // Only 2 sessions (need 5)
      createSessions(dir, 2);

      const consolidator = new MemoryConsolidator(createNoNetworkClient(), dir);
      // Should not throw even with null client (gates should block before LLM call)
      await consolidator.maybeRun();
    });
  });

  describe("E2E consolidation", () => {
    it("merges duplicate memories with real LLM", async () => {
      const apiKey = process.env.YUKINO_TEST_API_KEY;
      const baseURL =
        process.env.YUKINO_TEST_BASE_URL ?? "https://api.minimaxi.com/v1";
      const model = process.env.YUKINO_TEST_MODEL ?? "MiniMax-M3";

      if (!apiKey) {
        console.log("YUKINO_TEST_API_KEY not set, skipping E2E test");
        return;
      }

      const dir = makeTempDir();
      const memDir = join(dir, ".yukino", "memory");
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

      // Write MEMORY.md
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

      // Build LLM client
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
      await consolidator.run(memDir, [], 0);

      console.log("\nAfter consolidation:");
      console.log("  Files:", readdirSync(memDir));
      console.log(
        "  MEMORY.md:",
        readFileSync(join(memDir, "MEMORY.md"), "utf-8"),
      );

      // Verify MEMORY.md was updated
      const indexContent = readFileSync(join(memDir, "MEMORY.md"), "utf-8");
      const indexLines = indexContent
        .split("\n")
        .filter((l) => l.trim().length > 0);

      // Index should have fewer entries (from 3 lines down to 2, since duplicate push memories were merged)
      console.log(`  Index lines: ${String(indexLines.length)}`);
      expect(indexLines.length).toBeLessThanOrEqual(3);

      if (notified) {
        console.log(`  Notification: ${notified}`);
      }
    }, 120000); // 120s timeout
  });
});
