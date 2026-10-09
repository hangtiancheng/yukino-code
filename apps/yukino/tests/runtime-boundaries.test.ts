import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import { Agent, type AgentConfig } from "@/agent/index.js";
import {
  registerExitCleanup,
  runExitCleanups,
} from "@/bootstrap/exit-cleanup.js";
import { forceCompact } from "@/compact/compact.js";
import { ConversationManager } from "@/conversation/index.js";
import { HookEngine } from "@/hooks/index.js";
import type { LLMClient } from "@/llm/client.js";
import { ContextTooLongError } from "@/llm/errors.js";
import type { StreamEvent } from "@/llm/events.js";
import { buildMcpToolName } from "@/mcp/tool-wrapper.js";
import { PermissionChecker } from "@/permissions/index.js";
import {
  COMPACT_BOUNDARY,
  loadSession,
  messageToKeptRecord,
  rebuildFromSession,
  saveCompactBoundary,
  saveMessage,
} from "@/session/index.js";
import { McpCallTool } from "@/tools/mcp-call.js";
import { ToolRegistry } from "@/tools/registry.js";
import { ToolSearchTool } from "@/tools/tool-search.js";
import type { MCPToolLike, Tool } from "@/tools/types.js";
import { contentToText } from "@/utils/index.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const end = (stopReason = "end_turn"): StreamEvent => ({
  type: "stream_end",
  stopReason,
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
});
const call = (
  toolName: string,
  args: Record<string, unknown> = {},
  toolId = "call",
): StreamEvent => ({
  type: "tool_call_complete",
  toolName,
  toolId,
  arguments: args,
});
function client(scripts: StreamEvent[][]): LLMClient {
  let index = 0;
  return {
    setSystemPrompt: vi.fn(),
    setMaxOutputTokens: vi.fn(),
    async *stream() {
      await Promise.resolve();
      yield* scripts[index++] ?? [end()];
    },
  };
}
function tool(
  name: string,
  execute: Tool["execute"] = vi.fn(() =>
    Promise.resolve({ output: "ok", isError: false }),
  ),
): Tool {
  return {
    name,
    description: name,
    category: "read",
    execute,
    schema: () => ({
      name,
      description: name,
      input_schema: { type: "object", properties: {} },
    }),
  };
}
function fixture(llm: LLMClient, options: Partial<AgentConfig> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "yukino-runtime-"));
  directories.push(cwd);
  const conversation = new ConversationManager();
  conversation.addUserMessage("task");
  const config: AgentConfig = {
    client: llm,
    conversation,
    cwd,
    sessionId: "session",
    registry: new ToolRegistry(),
    checker: new PermissionChecker(cwd, "bypassPermissions"),
    ...options,
  };
  saveMessage(cwd, "session", {
    role: "user",
    content: "task",
    timestamp: 1,
  });
  return { ...config, agent: new Agent(config) };
}
async function collect(agent: Agent): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.run()) {
    events.push(event);
  }
  return events;
}
function history() {
  const conversation = new ConversationManager();
  for (let i = 0; i < 20; i++) {
    conversation.addUserMessage(`task ${String(i)} ` + "context ".repeat(200));
    conversation.addAssistantFull("answer", [], []);
  }
  conversation.addAssistantFull(
    "",
    [{ thinking: "signed thought", signature: "signature" }],
    [],
  );
  conversation.addUserMessage("latest constraint");
  return conversation;
}

describe("runtime boundaries", () => {
  it("does not recommend disabled deferred-tool discovery to restricted roles", async () => {
    const registry = new ToolRegistry();
    registry.mcpLoadingMode = "dispatch";
    registry.exposeToolSearch = true;
    registry.exposeMcpCall = true;
    registry.register(new ToolSearchTool(registry));
    registry.register(new McpCallTool(registry));
    registry.register({
      ...tool(buildMcpToolName("server", "action")),
      deferred: true,
    });
    const f = fixture(client([[end()]]), {
      registry,
      toolFilter: (name) => name !== "ToolSearch" && name !== "McpCall",
    });
    await collect(f.agent);
    expect(JSON.stringify(f.conversation.getMessages())).not.toMatch(
      /ToolSearch|McpCall|mcp__server/,
    );
  });

  it("does not repeat unchanged tool guidance across new runs in the same conversation", async () => {
    const registry = new ToolRegistry();
    registry.register(tool("ReadFile"));
    const f = fixture(client([[end()]]), { registry });
    await collect(f.agent);
    await collect(new Agent(f));
    expect(
      f.conversation
        .getMessages()
        .filter((message) =>
          contentToText(message.content).includes("# Active tool guidance"),
        ),
    ).toHaveLength(1);
  });

  it("refreshes capability guidance on filter changes and after compaction without mutating the system prefix", async () => {
    const registry = new ToolRegistry();
    const conversation = new ConversationManager();
    conversation.addUserMessage("task");
    let visible = true;
    let switches = 0;
    registry.register(tool("ReadFile"));
    registry.register(
      tool("Switch", () => {
        switches++;
        visible = switches !== 1;
        if (switches === 3) {
          conversation.replaceWithCompacted("checkpoint", []);
        }
        return Promise.resolve({ output: "updated", isError: false });
      }),
    );
    const snapshots: { text: string; count: number }[] = [];
    const scripts = [
      [call("ReadFile"), end("tool_use")],
      [call("Switch"), end("tool_use")],
      [call("Switch"), end("tool_use")],
      [call("Switch"), end("tool_use")],
      [end()],
    ];
    const llm = client(scripts);
    const setSystemPrompt = vi.spyOn(llm, "setSystemPrompt");
    const stream = llm.stream.bind(llm);
    vi.spyOn(llm, "stream").mockImplementation(async function* (...args) {
      const reminders = args[0]
        .getMessages()
        .map((message) => contentToText(message.content))
        .filter((text) => text.includes("# Active tool guidance"));
      snapshots.push({ text: reminders.at(-1) ?? "", count: reminders.length });
      yield* stream(...args);
    });
    await collect(
      fixture(llm, {
        registry,
        conversation,
        toolFilter: (name) => name !== "ReadFile" || visible,
      }).agent,
    );
    expect(snapshots.map((snapshot) => snapshot.count)).toEqual([
      1, 1, 2, 3, 1,
    ]);
    expect(snapshots[0]?.text).toContain("0-based");
    expect(snapshots[2]?.text).not.toContain("ReadFile");
    expect(snapshots[3]?.text).toBe(snapshots[0]?.text);
    expect(snapshots[4]?.text).toBe(snapshots[0]?.text);
    expect(setSystemPrompt).not.toHaveBeenCalled();
  });

  it("invalidates earlier guidance when no tools remain callable", async () => {
    const registry = new ToolRegistry();
    registry.register(
      tool("Remove", () => {
        registry.unregister("Remove");
        return Promise.resolve({ output: "removed", isError: false });
      }),
    );
    const f = fixture(client([[call("Remove"), end("tool_use")], [end()]]), {
      registry,
    });
    await collect(f.agent);
    const reminders = f.conversation
      .getMessages()
      .map((message) => contentToText(message.content))
      .filter((text) => text.includes("# Active tool guidance"));
    expect(reminders).toHaveLength(2);
    expect(reminders[1]).toContain("No tools are currently callable");
  });

  it("replaces inherited parent tool guidance for a child with no tools", async () => {
    const conversation = new ConversationManager();
    conversation.addSystemReminder(
      "# Active tool guidance\nCallable tools: ReadFile",
    );
    const f = fixture(client([[end()]]), { conversation });
    await collect(f.agent);
    expect(
      conversation
        .getMessages()
        .map((message) => contentToText(message.content))
        .at(-1),
    ).toContain("No tools are currently callable");
  });

  it("never executes even valid-looking calls from a truncated response", async () => {
    const registry = new ToolRegistry();
    const action = tool("Action");
    const execute = vi.spyOn(action, "execute");
    registry.register(action);
    const f = fixture(
      client([
        [call("Action"), call("Action", {}, "second"), end("max_tokens")],
        [end()],
      ]),
      { registry },
    );
    const results = (await collect(f.agent)).filter(
      (event) => event.type === "tool_result",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
    expect(
      results.every(
        (result) =>
          result.isError && result.output.includes("output token limit"),
      ),
    ).toBe(true);
    expect(
      rebuildFromSession(loadSession(f.cwd, "session")).flatMap(
        (message) => message.toolResults ?? [],
      ),
    ).toHaveLength(2);
  });

  it("refreshes added and removed tool schemas on the next turn", async () => {
    const registry = new ToolRegistry();
    registry.register(
      tool("Replace", () => {
        registry.unregister("Old");
        registry.register(tool("New"));
        return Promise.resolve({ output: "reloaded", isError: false });
      }),
    );
    registry.register(tool("Old"));
    const llm = client([[call("Replace"), end("tool_use")], [end()]]);
    const stream = vi.spyOn(llm, "stream");
    await collect(fixture(llm, { registry }).agent);
    expect(
      stream.mock.calls.map(([, schemas]) =>
        schemas.map((schema) =>
          "name" in schema ? schema.name : schema.function.name,
        ),
      ),
    ).toEqual([
      ["Replace", "Old"],
      ["Replace", "New"],
    ]);
  });

  it("updates schemas when a local deferred tool is discovered", async () => {
    const registry = new ToolRegistry();
    registry.exposeToolSearch = true;
    registry.register(new ToolSearchTool(registry));
    registry.register({ ...tool("Deferred"), deferred: true });
    const llm = client([
      [call("ToolSearch", { query: "select:Deferred" }), end("tool_use")],
      [end()],
    ]);
    const stream = vi.spyOn(llm, "stream");
    await collect(fixture(llm, { registry }).agent);
    expect(
      stream.mock.calls.map(([, schemas]) =>
        schemas.map((schema) =>
          "name" in schema ? schema.name : schema.function.name,
        ),
      ),
    ).toEqual([["ToolSearch"], ["ToolSearch", "Deferred"]]);
  });

  it("keeps a dispatch MCP tool list stable after discovery", async () => {
    const registry = new ToolRegistry();
    registry.mcpLoadingMode = "dispatch";
    registry.exposeToolSearch = true;
    registry.exposeMcpCall = true;
    registry.register(new ToolSearchTool(registry));
    registry.register(new McpCallTool(registry));
    registry.register({
      ...tool(buildMcpToolName("server", "action")),
      deferred: true,
    });
    const llm = client([
      [
        call("ToolSearch", {
          query: `select:${buildMcpToolName("server", "action")}`,
        }),
        end("tool_use"),
      ],
      [end()],
    ]);
    const stream = vi.spyOn(llm, "stream");
    await collect(fixture(llm, { registry }).agent);
    expect(stream.mock.calls[1][1]).toEqual(stream.mock.calls[0][1]);
  });

  it("refreshes runtime filters and does not advertise filtered deferred tools", async () => {
    const registry = new ToolRegistry();
    let visible = true;
    registry.register(
      tool("Hide", () => {
        visible = false;
        return Promise.resolve({ output: "hidden", isError: false });
      }),
    );
    registry.register(tool("Visible"));
    registry.register({ ...tool("HiddenDeferred"), deferred: true });
    const llm = client([[call("Hide"), end("tool_use")], [end()]]);
    const stream = vi.spyOn(llm, "stream");
    const f = fixture(llm, {
      registry,
      toolFilter: (name) =>
        name !== "HiddenDeferred" && (name !== "Visible" || visible),
    });
    await collect(f.agent);
    expect(stream.mock.calls[1][1]).toHaveLength(1);
    expect(
      f.conversation
        .getMessages()
        .map((message) => contentToText(message.content))
        .join("\n"),
    ).not.toContain("HiddenDeferred");
  });

  it("persists a thinking-only response and its signature", async () => {
    const f = fixture(
      client([
        [
          {
            type: "thinking_complete",
            thinking: "thought",
            signature: "signed",
          },
          end(),
        ],
      ]),
    );
    await collect(f.agent);
    expect(
      rebuildFromSession(loadSession(f.cwd, "session")).at(-1),
    ).toMatchObject({
      role: "assistant",
      content: "",
      thinkingBlocks: [{ thinking: "thought", signature: "signed" }],
    });
  });

  it("persists the actual recovery prompts after max_tokens", async () => {
    const f = fixture(
      client([
        [
          {
            type: "thinking_complete",
            thinking: "partial",
            signature: "signed",
          },
          end("max_tokens"),
        ],
        [{ type: "text_delta", text: "still partial" }, end("max_tokens")],
        [{ type: "text_delta", text: "done" }, end()],
      ]),
    );
    await collect(f.agent);
    expect(
      rebuildFromSession(loadSession(f.cwd, "session")).map(
        ({ role, content, thinkingBlocks }) => ({
          role,
          content,
          thinkingBlocks,
        }),
      ),
    ).toEqual(
      f.conversation.getMessages().map(({ role, content, thinkingBlocks }) => ({
        role,
        content,
        thinkingBlocks,
      })),
    );
  });

  it("preserves signed thinking-only messages in a compacted retained tail", async () => {
    const conversation = history();
    const result = await forceCompact(
      conversation,
      client([
        [{ type: "text_delta", text: "<summary>Summary</summary>" }, end()],
      ]),
      null,
      [],
      [],
    );
    const f = fixture(client([]));
    expect(result.boundary).toBeDefined();
    if (!result.boundary) {
      throw new Error("Missing compaction boundary");
    }
    saveCompactBoundary(f.cwd, "session", result.boundary);
    const replay = rebuildFromSession(loadSession(f.cwd, "session"));
    expect(
      replay.find((message) => message.thinkingBlocks?.length)?.thinkingBlocks,
    ).toEqual([{ thinking: "signed thought", signature: "signature" }]);
    expect(conversation.getMessages().map(messageToKeptRecord)).toEqual(
      replay.map(messageToKeptRecord),
    );
  });

  it.each(["automatic", "context-error"])(
    "persists %s compaction before publishing its event without a frontend",
    async (kind) => {
      const conversation = history();
      if (kind === "automatic") {
        conversation.recordUsageAnchor(190000, 1, 0, 0);
      }
      const llm = client([
        [{ type: "text_delta", text: "<summary>Summary</summary>" }, end()],
        [{ type: "text_delta", text: "done" }, end()],
      ]);
      if (kind === "context-error") {
        const originalStream = llm.stream.bind(llm);
        let first = true;
        llm.stream = async function* (...args) {
          if (first) {
            first = false;
            throw new ContextTooLongError("too long");
          }
          yield* originalStream(...args);
        };
      }
      const f = fixture(llm, {
        conversation,
        contextWindow: 200000,
        maxOutput: 8000,
      });
      let compactions = 0;
      for await (const event of f.agent.run()) {
        if (event.type === "compact" && event.boundary) {
          compactions++;
          expect(
            loadSession(f.cwd, "session").filter(
              (message) => message.type === COMPACT_BOUNDARY,
            ),
          ).toHaveLength(1);
        }
      }
      expect(compactions).toBe(1);
      expect(
        contentToText(
          rebuildFromSession(loadSession(f.cwd, "session"))[0].content,
        ),
      ).toContain("Summary");
    },
  );

  it("runs exit cleanups once, including reentrant cleanup calls", () => {
    const second = vi.fn();
    const first = vi.fn(() => {
      runExitCleanups();
      throw new Error("cleanup failed");
    });
    const removeFirst = registerExitCleanup(first);
    const removeSecond = registerExitCleanup(second);
    try {
      runExitCleanups();
      runExitCleanups();
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    } finally {
      removeFirst();
      removeSecond();
    }
  });

  it("reports interruption, not a stale context error, when recovery compaction is cancelled", async () => {
    const conversation = history();
    const before = structuredClone(conversation.getMessages());
    const controller = new AbortController();
    let requests = 0;
    const llm: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream() {
        await Promise.resolve();
        if (requests++ === 0) {
          throw new ContextTooLongError("too long");
        }
        yield { type: "text_delta", text: "<summary>partial" };
        controller.abort();
        controller.signal.throwIfAborted();
      },
    };
    const f = fixture(llm, { conversation, abortSignal: controller.signal });
    const events = await collect(f.agent);
    expect(events.at(-1)).toEqual({
      type: "loop_complete",
      stopReason: "interrupted",
    });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(conversation.getMessages()).toEqual(before);
    expect(
      loadSession(f.cwd, "session").some(
        (message) => message.type === COMPACT_BOUNDARY,
      ),
    ).toBe(false);
  });
});

describe("MCP dispatch execution boundaries", () => {
  function setup() {
    const registry = new ToolRegistry();
    const target: MCPToolLike = {
      ...tool(buildMcpToolName("server", "action")),
      category: "command",
      mcpServerName: "server",
      mcpInputSchema: () => ({
        type: "object",
        properties: { limit: { type: "integer" } },
      }),
      setDeferLoading: vi.fn(),
    };
    registry.register(target);
    registry.register(new McpCallTool(registry));
    const args = {
      server: "server",
      tool: target.name,
      arguments: { limit: "3" },
    };
    const hooks = new HookEngine([]);
    const f = fixture(
      client([[call("McpCall", args), end("tool_use")], [end()]]),
      { registry, hookEngine: hooks },
    );
    return { ...f, target, hooks, args, execute: vi.spyOn(target, "execute") };
  }

  it("checks and hooks exactly the arguments forwarded to the target", async () => {
    const f = setup();
    const check = vi.spyOn(f.checker, "check");
    const hooks = vi.spyOn(f.hooks, "fire");
    await collect(f.agent);
    expect(check).toHaveBeenCalledWith(f.target.name, "command", { limit: 3 });
    expect(f.execute).toHaveBeenCalledWith(expect.anything(), { limit: 3 });
    const toolHooks = hooks.mock.calls.filter(
      ([event]) => event === "pre_tool_use" || event === "post_tool_use",
    );
    expect(
      toolHooks.map(([event, context]) => [event, context.toolName]),
    ).toEqual([
      ["pre_tool_use", "McpCall"],
      ["pre_tool_use", f.target.name],
      ["post_tool_use", f.target.name],
      ["post_tool_use", "McpCall"],
    ]);
    expect(toolHooks[1][1].args).toEqual({ limit: 3 });
    expect(toolHooks[2][1].args).toEqual({ limit: 3 });
  });

  it("honors the target's pre-tool hook rejection", async () => {
    const f = setup();
    vi.spyOn(f.hooks, "firePreToolHooks").mockImplementation((name) =>
      Promise.resolve({
        rejected: name === f.target.name,
        reason: "blocked target",
      }),
    );
    const events = await collect(f.agent);
    expect(f.execute).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === "tool_result")).toMatchObject({
      isError: true,
      output: "Rejected by hook: blocked target",
    });
  });

  it("keeps the original model arguments identical in memory and on disk", async () => {
    const f = setup();
    await collect(f.agent);
    const inMemory = f.conversation
      .getMessages()
      .flatMap((message) => message.toolUses ?? []);
    const onDisk = rebuildFromSession(loadSession(f.cwd, "session")).flatMap(
      (message) => message.toolUses ?? [],
    );
    expect(inMemory[0].arguments).toEqual(f.args);
    expect(onDisk[0].arguments).toEqual(f.args);
  });

  it("does not fire the target's post hook when dispatch arguments are invalid", async () => {
    const f = setup();
    Reflect.set(f.args, "arguments", []);
    const hooks = vi.spyOn(f.hooks, "fire");
    await collect(f.agent);
    expect(f.execute).not.toHaveBeenCalled();
    expect(
      hooks.mock.calls
        .filter(([event]) => event === "post_tool_use")
        .map(([, context]) => context.toolName),
    ).toEqual(["McpCall"]);
  });

  it("records allowAlways for every approval-required layer", async () => {
    const f = setup();
    vi.spyOn(f.checker, "check").mockReturnValue({
      effect: "ask",
      reason: "confirmation",
    });
    const allowAlways = vi
      .spyOn(f.checker, "allowAlways")
      .mockImplementation(() => undefined);
    const onPermissionRequest = vi.fn(() =>
      Promise.resolve("allowAlways" as const),
    );
    await collect(new Agent({ ...f, onPermissionRequest }));
    expect(onPermissionRequest).toHaveBeenCalledTimes(1);
    expect(allowAlways).toHaveBeenCalledTimes(2);
    expect(allowAlways).toHaveBeenCalledWith(f.target.name, { limit: 3 });
  });

  it("does not let allowAlways override a target denial", async () => {
    const f = setup();
    vi.spyOn(f.checker, "check").mockImplementation((name) => ({
      effect: name === f.target.name ? "deny" : "ask",
      reason: "security policy",
    }));
    const onPermissionRequest = vi.fn(() =>
      Promise.resolve("allowAlways" as const),
    );
    await collect(new Agent({ ...f, onPermissionRequest }));
    expect(onPermissionRequest).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
});
