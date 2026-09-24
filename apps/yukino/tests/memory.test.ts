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

import { writeFileSync } from "fs";
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import { MemoryExtractor } from "@/memory/extractor.js";
import { MemoryManager } from "@/memory/manager.js";

class MockClient implements LLMClient {
  constructor(private text: string) {}
  setSystemPrompt(_prompt: string): void {
    /** noop */
  }
  setMaxOutputTokens?(_maxTokens: number): void {
    /** noop */
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async *stream(): AsyncGenerator<StreamEvent> {
    yield { type: "text_delta", text: this.text };
    yield {
      type: "stream_end",
      stopReason: "end_turn",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    };
  }
}

describe("MemoryExtractor", () => {
  it("parses memory blocks and routes project/reference memories to the project dir", async () => {
    // Only project-scoped types so the test writes into the temp workDir,
    // never the real home directory.
    const response = [
      "MEMORY_NAME: build-cmd",
      "MEMORY_TYPE: project",
      "MEMORY_DESC: how to build",
      "MEMORY_BODY: Run pnpm build.",
      "---",
      "MEMORY_NAME: api-docs",
      "MEMORY_TYPE: reference",
      "MEMORY_DESC: api reference link",
      "MEMORY_BODY: See https://example.com/api",
      "---",
    ].join("\n");

    const workDir = mkdtempSync(join(tmpdir(), "yukino-mem-"));
    const saved = await new MemoryExtractor(
      new MockClient(response),
      workDir,
    ).extract("conversation");

    expect(saved.sort()).toEqual(["api-docs", "build-cmd"]);

    const memDir = join(workDir, ".yukino", "memory");
    expect(existsSync(join(memDir, "build-cmd.md"))).toBe(true);
    const file = readFileSync(join(memDir, "build-cmd.md"), "utf-8");
    expect(file).toContain('name: "build-cmd"');
    expect(file).toContain('type: "project"');
    expect(file).toContain("Run pnpm build.");
  });

  it("round-trips descriptions containing YAML special characters", async () => {
    const description = 'blocked: package --- #1 says "wait"';
    const response = [
      "MEMORY_NAME: yaml-safe",
      "MEMORY_TYPE: project",
      `MEMORY_DESC: ${description}`,
      "MEMORY_BODY: body",
    ].join("\n");
    const workDir = mkdtempSync(join(tmpdir(), "yukino-mem-"));

    await new MemoryExtractor(new MockClient(response), workDir).extract(
      "conversation",
    );

    const memory = new MemoryManager(workDir)
      .loadAll()
      .find(
        (entry) =>
          entry.path === join(workDir, ".yukino", "memory", "yaml-safe.md"),
      );
    expect(memory?.description).toBe(description);
  });

  it("returns nothing when the model says NONE", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-mem-"));
    const saved = await new MemoryExtractor(
      new MockClient("NONE"),
      workDir,
    ).extract("conversation");
    expect(saved).toEqual([]);
  });
});

describe("MemoryManager malformed files", () => {
  it("skips malformed frontmatter from load, index, and recall", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-malformed-"));
    const dir = join(workDir, ".yukino", "memory");
    mkdirSync(dir, { recursive: true });
    const badPath = join(dir, "bad.md");
    writeFileSync(
      badPath,
      "---\nname: bad\ndescription: package: cannot publish\ntype: project\n---\n\nbody\n",
      "utf-8",
    );
    const manager = new MemoryManager(workDir);

    expect(manager.loadAll().some((memory) => memory.path === badPath)).toBe(
      false,
    );
    expect(readFileSync(join(dir, "MEMORY.md"), "utf-8")).not.toContain(
      "bad.md",
    );
    await expect(
      manager.findRelevantMemories(
        "query",
        new MockClient('{"selected_memories":["bad.md"]}'),
      ),
    ).resolves.toEqual([]);
  });
});

describe("MemoryManager index truncation", () => {
  function seed(count: number, descLen: number, filler = "a"): string {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-cap-"));
    const dir = join(workDir, ".yukino", "memory");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i++) {
      const name = `mem${String(i).padStart(4, "0")}`;
      writeFileSync(
        join(dir, `${name}.md`),
        `---\nname: ${name}\ndescription: ${filler.repeat(descLen)}\nmetadata:\n  type: project\n---\n\nbody\n`,
        "utf-8",
      );
    }
    return workDir;
  }

  it("injects entries verbatim without a warning when there are few of them", () => {
    const mgr = new MemoryManager(seed(3, 10));
    const out = mgr.buildSystemReminder();
    expect(out).toContain("Active memories:");
    expect(out).not.toContain("WARNING");
  });

  it("truncates with a notice when entries exceed the line limit", () => {
    const mgr = new MemoryManager(seed(230, 10));
    const out = mgr.buildSystemReminder();
    expect(out).toContain("WARNING");
    expect(out).toContain("lines (limit: 200)");
    const body = out
      .split("\n\n> WARNING")[0]
      ?.replace("Active memories:\n", "");
    expect(body.split("\n").length).toBe(200);
  });

  it("truncates over-long CJK entries by bytes without exceeding the limit", () => {
    const mgr = new MemoryManager(seed(20, 800, "桜"));
    const out = mgr.buildSystemReminder();
    expect(out).toContain("WARNING");
    const body = out
      .split("\n\n> WARNING")[0]
      ?.replace("Active memories:\n", "");
    expect(Buffer.byteLength(body, "utf-8")).toBeLessThanOrEqual(25_000);
    expect(body).not.toContain("\uFFFD");
  });
});
