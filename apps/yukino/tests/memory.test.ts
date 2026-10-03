import { writeFileSync } from "fs";
import {
  mkdtempSync as createTempDir,
  existsSync,
  readFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, it, expect } from "vitest";

import type { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import { MemoryExtractor } from "@/memory/extractor.js";
import { MemoryManager } from "@/memory/manager.js";

const tempDirs = new Set<string>();

function mkdtempSync(prefix: string): string {
  const directory = createTempDir(prefix);
  tempDirs.add(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirs.clear();
});

class MockClient implements LLMClient {
  lastPrompt = "";

  constructor(private text: string) {}
  setSystemPrompt(_prompt: string): void {
    /** noop */
  }
  setMaxOutputTokens?(_maxTokens: number): void {
    /** noop */
  }
  async *stream(
    conversation: ConversationManager,
  ): AsyncGenerator<StreamEvent> {
    const prompt = conversation.getMessages()[0]?.content;
    this.lastPrompt = typeof prompt === "string" ? prompt : "";
    await Promise.resolve();
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

  it("only reads complete type and description lines into the manifest", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-mem-"));
    const memoryDir = join(workDir, ".yukino", "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      join(memoryDir, "misleading.md"),
      [
        "---",
        "name: misleading",
        "metadata: {}",
        "---",
        "",
        "Implementation prototype: feedback",
        "Narrative description: body impostor",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(memoryDir, "valid.md"),
      [
        "---",
        "name: valid",
        'description: "real description"',
        "metadata:",
        '  type: "project"',
        "---",
        "body",
      ].join("\n"),
      "utf-8",
    );
    const client = new MockClient("NONE");

    await new MemoryExtractor(client, workDir).extract("conversation");

    expect(client.lastPrompt).toContain("- [reference] misleading.md:");
    expect(client.lastPrompt).not.toContain("[feedback] misleading.md");
    expect(client.lastPrompt).not.toContain("body impostor");
    expect(client.lastPrompt).toContain(
      "- [project] valid.md: real description",
    );
  });

  it("resets accumulated fields when MEMORY_NAME repeats", async () => {
    const response = [
      "MEMORY_NAME: stale",
      "MEMORY_TYPE: project",
      "MEMORY_DESC: stale description",
      "MEMORY_BODY: stale body",
      "stale continuation",
      "MEMORY_NAME: final",
      "MEMORY_BODY: fresh body",
    ].join("\n");
    const workDir = mkdtempSync(join(tmpdir(), "yukino-mem-"));

    const saved = await new MemoryExtractor(
      new MockClient(response),
      workDir,
    ).extract("conversation");

    expect(saved).toEqual(["final"]);
    expect(existsSync(join(workDir, ".yukino", "memory", "stale.md"))).toBe(
      false,
    );
    const file = readFileSync(
      join(workDir, ".yukino", "memory", "final.md"),
      "utf-8",
    );
    expect(file).toContain('type: "reference"');
    expect(file).toContain('description: ""');
    expect(file).toContain("fresh body");
    expect(file).not.toContain("stale description");
    expect(file).not.toContain("stale body");
    expect(file).not.toContain("stale continuation");

    const bodyLeakDir = mkdtempSync(join(tmpdir(), "yukino-mem-"));
    const bodyLeakResponse = [
      "MEMORY_NAME: stale-body",
      "MEMORY_TYPE: project",
      "MEMORY_BODY: must not leak",
      "nor may this continuation",
      "MEMORY_NAME: bodyless-final",
      "MEMORY_TYPE: project",
      "MEMORY_DESC: final description",
    ].join("\n");
    const bodyLeakSaved = await new MemoryExtractor(
      new MockClient(bodyLeakResponse),
      bodyLeakDir,
    ).extract("conversation");

    expect(bodyLeakSaved).toEqual([]);
    expect(
      existsSync(join(bodyLeakDir, ".yukino", "memory", "bodyless-final.md")),
    ).toBe(false);
  });

  it("replaces prior continuation content when MEMORY_BODY repeats", async () => {
    const response = [
      "MEMORY_NAME: replaced-body",
      "MEMORY_TYPE: project",
      "MEMORY_BODY: obsolete body",
      "obsolete continuation",
      "MEMORY_BODY: replacement body",
      "replacement continuation",
    ].join("\n");
    const workDir = mkdtempSync(join(tmpdir(), "yukino-mem-"));

    await new MemoryExtractor(new MockClient(response), workDir).extract(
      "conversation",
    );

    const file = readFileSync(
      join(workDir, ".yukino", "memory", "replaced-body.md"),
      "utf-8",
    );
    expect(file).toContain("replacement body\nreplacement continuation");
    expect(file).not.toContain("obsolete body");
    expect(file).not.toContain("obsolete continuation");
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
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);
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
