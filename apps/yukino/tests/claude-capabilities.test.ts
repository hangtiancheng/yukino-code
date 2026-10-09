import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Agent } from "@/agent/index.js";
import { configureBashSandbox } from "@/bootstrap/sandbox.js";
import { ConversationManager } from "@/conversation/index.js";
import { FileHistory } from "@/file-history/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import { MemoryExtractor } from "@/memory/extractor.js";
import { MemoryManager } from "@/memory/manager.js";
import { PermissionChecker } from "@/permissions/index.js";
import { getOrCreatePlanPath } from "@/plan-file/index.js";
import * as sandbox from "@/sandbox/index.js";
import { yukinoPath, projectPath } from "@/storage/paths.js";
import { AgentTool } from "@/subagent/agent-tool.js";
import type { AgentDefinition } from "@/subagent/definition.js";
import { TaskManager } from "@/subagent/task-manager.js";
import { FileMailbox } from "@/teams/file-mailbox.js";
import { scrubTelemetryPayload } from "@/telemetry/privacy.js";
import { BashTool } from "@/tools/bash.js";
import { ComputerUseTool } from "@/tools/computer-use.js";
import { ExitPlanModeTool } from "@/tools/exit-plan-mode.js";
import { ToolRegistry } from "@/tools/registry.js";
import { WebFetchTool } from "@/tools/web-fetch.js";
import { WebSearchTool } from "@/tools/web-search.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  homedir: vi.fn(),
}));
let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(os.tmpdir(), "yukino-claude-"));
  vi.mocked(os.homedir).mockReturnValue(cwd);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});
const end: StreamEvent = {
  type: "stream_end",
  stopReason: "end_turn",
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
};

describe("Claude capability contracts", () => {
  it("uses per-session plan paths and rejects empty plans regardless of another session's plan", async () => {
    const a = new PermissionChecker(cwd, "plan");
    const b = new PermissionChecker(cwd, "plan");
    const first = getOrCreatePlanPath(a);
    const second = getOrCreatePlanPath(b);
    expect(first).not.toBe(second);
    writeFileSync(second, "# Approved approach");
    expect(
      (await new ExitPlanModeTool().execute({ cwd, permissionChecker: a }, {}))
        .isError,
    ).toBe(true);
    expect(
      (await new ExitPlanModeTool().execute({ cwd, permissionChecker: b }, {}))
        .isError,
    ).toBe(false);
  });
  it("honors explicit foreground overrides for BOM-prefixed background agent definitions", async () => {
    const dir = yukinoPath("agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "worker.md"),
      "\uFEFF---\nname: worker\nbackground: true\n---\nHandle the task.",
    );
    const spawn = vi.fn(
      async (
        _definition: AgentDefinition,
        _prompt: string,
        _background: boolean,
      ) => {
        await Promise.resolve();
        return "completed inline";
      },
    );
    const tasks = new TaskManager();
    const tool = new AgentTool(
      cwd,
      new ToolRegistry(),
      spawn,
      undefined,
      undefined,
      tasks,
    );
    const result = await tool.execute(
      { cwd },
      {
        description: "Task",
        prompt: "Work",
        subagent_type: "worker",
        run_in_background: false,
      },
    );
    expect(result.output).toContain("completed inline");
    expect(tasks.list()).toHaveLength(0);
    expect(spawn.mock.calls[0]?.[2]).toBe(false);
    expect(
      (
        await tool.execute(
          { cwd },
          { description: "Task", prompt: "Work", run_in_background: "false" },
        )
      ).isError,
    ).toBe(true);
  });
  it("keeps enabled sandbox execution blocked when the platform sandbox is unavailable", async () => {
    vi.spyOn(sandbox, "createSandbox").mockResolvedValue(null);
    const registry = new ToolRegistry();
    const bash = new BashTool();
    registry.register(bash);
    const checker = new PermissionChecker(cwd);
    await configureBashSandbox(
      registry,
      cwd,
      { enabled: true, auto_allow: true },
      checker,
    );
    expect(checker.sandboxEnabled).toBe(true);
    expect(checker.sandboxAutoAllow).toBe(true);
    const result = await bash.execute(
      { cwd },
      { command: "printf must-not-run" },
    );
    expect(result.isError).toBe(true);
    expect(result.output).not.toBe("must-not-run");
  });
  it("captures a checkpoint before the first failing agent run and restores byte-distinct binary content", async () => {
    const history = new FileHistory("one");
    const path = join(cwd, "binary.dat");
    writeFileSync(path, Buffer.from([0x80]));
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream() {
        history.trackEdit(path);
        writeFileSync(path, Buffer.from([0x81]));
        await Promise.resolve();
        yield { type: "text_delta", text: "Partial" };
        throw new Error("provider failed");
      },
    };
    const conversation = new ConversationManager();
    conversation.addUserMessage("Edit safely");
    const agent = new Agent({
      client,
      conversation,
      registry: new ToolRegistry(),
      cwd,
      checker: new PermissionChecker(cwd),
      fileHistory: history,
    });
    for await (const event of agent.run()) {
      expect(event.type).not.toBe("loop_complete");
    }
    expect(history.getSnapshots()).toHaveLength(1);
    history.rewind(0);
    expect(readFileSync(path)).toEqual(Buffer.from([0x80]));
    history.trackEdit(path);
    history.makeSnapshot(1, "Tracked binary");
    writeFileSync(path, Buffer.from([0x81]));
    history.rewind(1);
    expect(readFileSync(path)).toEqual(Buffer.from([0x80]));
  });
  it("preserves unread mailbox evidence when the persisted mailbox is damaged", () => {
    const mailbox = new FileMailbox(cwd, "worker");
    const path = join(cwd, "worker.json");
    writeFileSync(path, "{damaged unread evidence");
    expect(() => {
      mailbox.sendSync("leader", "New task");
    }).toThrow("original contents were preserved");
    expect(readFileSync(path, "utf8")).toBe("{damaged unread evidence");
  });
  it("serializes the physical computer across independently created tools", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runner = vi.fn(async () => {
      await pending;
      return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
    });
    const first = new ComputerUseTool({
      platform: "linux",
      runCommand: runner,
    });
    const second = new ComputerUseTool({
      platform: "linux",
      runCommand: runner,
    });
    const running = first.execute({ cwd }, { action: "type", text: "one" });
    const busy = await second.execute({ cwd }, { action: "type", text: "two" });
    expect(busy.isError).toBe(true);
    expect(busy.output).toContain("another Yukino call");
    expect(runner).toHaveBeenCalledOnce();
    finish?.();
    expect((await running).isError).toBe(false);
    expect(
      (await second.execute({ cwd }, { action: "type", text: "two" })).isError,
    ).toBe(false);
  });
  it("releases Linux modifier keys after cancellation with a cleanup request independent of the aborted signal", async () => {
    const controller = new AbortController();
    const runner = vi.fn(
      async (
        _command: string,
        args: readonly string[],
        options?: { signal?: AbortSignal },
      ) => {
        await Promise.resolve();
        if (args[0] === "keydown") {
          controller.abort();
        }
        if (options?.signal?.aborted && args[0] !== "keydown") {
          throw new Error("interrupted");
        }
        return { code: 0, stdout: Buffer.alloc(0), stderr: "" };
      },
    );
    const result = await new ComputerUseTool({
      platform: "linux",
      runCommand: runner,
    }).execute(
      { cwd, abortSignal: controller.signal },
      { action: "left_click", coordinate: [1, 1], keys: ["shift"] },
    );
    expect(result.isError).toBe(true);
    expect(
      runner.mock.calls.find((call) => call[1][0] === "keyup")?.[2]?.signal,
    ).toBeUndefined();
  });
  it("never persists structured memory text from a failed extraction stream", async () => {
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream() {
        await Promise.resolve();
        yield {
          type: "text_delta",
          text: "MEMORY_NAME: invalid\nMEMORY_TYPE: project\nMEMORY_DESC: partial\nMEMORY_BODY: Unverified partial content",
        };
        throw new Error("incomplete extraction");
      },
    };
    await expect(
      new MemoryExtractor(client, cwd).extract("evidence"),
    ).rejects.toThrow("incomplete extraction");
    expect(new MemoryManager(cwd).loadAll()).toEqual([]);
  });
  it("deduplicates recall selections, caps them at five, and ignores incomplete selector output", async () => {
    const dir = projectPath(cwd, "memory");
    mkdirSync(dir, { recursive: true });
    const paths = Array.from({ length: 8 }, (_, index) => {
      const path = join(dir, `${String(index)}.md`);
      writeFileSync(
        path,
        `---\nname: memory-${String(index)}\ndescription: useful\n---\nEvidence`,
      );
      return path;
    });
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream() {
        await Promise.resolve();
        yield {
          type: "text_delta",
          text: JSON.stringify({ selected_memories: [paths[0], ...paths] }),
        };
        yield end;
      },
    };
    const manager = new MemoryManager(cwd);
    const selected = await manager.findRelevantMemories("query", client);
    expect(selected).toHaveLength(5);
    expect(new Set(selected.map((item) => item.path)).size).toBe(5);
    const incomplete: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream() {
        await Promise.resolve();
        yield {
          type: "text_delta",
          text: JSON.stringify({ selected_memories: paths }),
        };
      },
    };
    expect(await manager.findRelevantMemories("query", incomplete)).toEqual([]);
  });
  it("filters search sources by exact hostname and subdomain boundaries", async () => {
    const html = `<ol id="b_results">
      <li class="b_algo"><h2><a href="https://docs.example.com/a">Good</a></h2><div class="b_caption"><p>Useful</p></div></li>
      <li class="b_algo"><h2><a href="https://example.com.evil.test/a">Deceptive</a></h2><div class="b_caption"><p>Wrong domain</p></div></li>
      <li class="b_algo"><h2><a href="https://other.test/a">Other</a></h2><div class="b_caption"><p>Other</p></div></li>
    </ol>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await Promise.resolve();
        return new Response(html);
      }),
    );
    const tool = new WebSearchTool();
    const result = await tool.execute(
      { cwd },
      { query: "documentation", allowed_domains: ["EXAMPLE.COM"] },
    );
    expect(result.output).toContain("Useful");
    expect(result.output).not.toContain("Deceptive");
    expect(result.output).not.toContain("Other");
    const blocked = await tool.execute(
      { cwd },
      { query: "documentation", blocked_domains: ["example.com"] },
    );
    expect(blocked.output).not.toContain("Useful");
    expect(blocked.output).toContain("Deceptive");
    expect(
      (
        await tool.execute(
          { cwd },
          {
            query: "q",
            allowed_domains: ["example.com"],
            blocked_domains: ["other.test"],
          },
        )
      ).isError,
    ).toBe(true);
  });
  it("cancels rejected WebFetch bodies and honors cancellation before a cache hit", async () => {
    const cancel = vi.fn();
    const binary = new ReadableStream<Uint8Array>({ cancel });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(binary, { headers: { "content-type": "image/png" } }),
      )
      .mockResolvedValueOnce(new Response("cached page"));
    vi.stubGlobal("fetch", fetch);
    const tool = new WebFetchTool();
    expect(
      (await tool.execute({ cwd }, { url: "https://example.test/binary" }))
        .isError,
    ).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(
      (await tool.execute({ cwd }, { url: "https://example.test/cache" }))
        .output,
    ).toBe("cached page");
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await tool.execute(
          { cwd, abortSignal: controller.signal },
          { url: "https://example.test/cache" },
        )
      ).isError,
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("redacts Sentry credentials, nested payloads, and encoded environment secrets while retaining useful diagnostics", () => {
    vi.stubEnv("OPENAI_API_KEY", "private-key/secret");
    const event = {
      request: {
        headers: {
          Authorization: "Bearer arbitrary-credential",
          Cookie: "secret",
          Accept: "text/html",
        },
      },
      exception: {
        values: [
          { value: "failure private-key/secret and private-key%2Fsecret" },
        ],
      },
      extra: {
        client_secret: "other-credential",
        refreshToken: "another-credential",
        filename: join(cwd, "source.ts"),
      },
    };
    scrubTelemetryPayload(event);
    expect(JSON.stringify(event)).not.toContain("private-key");
    expect(event.request.headers.Authorization).toBe("[redacted]");
    expect(event.request.headers.Accept).toBe("text/html");
    expect(event.exception.values[0]?.value).toContain("failure");
    expect(event.extra).toEqual({
      client_secret: "[redacted]",
      refreshToken: "[redacted]",
      filename: "~/source.ts",
    });
  });
});
