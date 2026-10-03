import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import { Agent, type AgentConfig } from "@/agent/index.js";
import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import { ContextTooLongError } from "@/llm/errors.js";
import type { StreamEvent } from "@/llm/events.js";
import { PermissionChecker } from "@/permissions/index.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool } from "@/tools/types.js";

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
const call: StreamEvent = {
  type: "tool_call_complete",
  toolId: "write",
  toolName: "WriteFile",
  arguments: { file_path: "file.txt" },
};

function fixture(overrides: Partial<AgentConfig> = {}) {
  const workDir = mkdtempSync(join(tmpdir(), "yukino-harness-"));
  const conversation = new ConversationManager();
  conversation.addUserMessage("task");
  const execute = vi.fn(() =>
    Promise.resolve({ output: "written", isError: false }),
  );
  const tool: Tool = {
    name: "WriteFile",
    description: "write",
    category: "write",
    execute,
    schema: () => ({
      name: "WriteFile",
      description: "write",
      input_schema: { type: "object", properties: {} },
    }),
  };
  const registry = new ToolRegistry();
  registry.register(tool);
  let calls = 0;
  const client: LLMClient = {
    setSystemPrompt: vi.fn(),
    async *stream() {
      if (calls++ === 0) {
        await Promise.resolve();
        yield call;
      }
      yield end;
    },
  };
  const config: AgentConfig = {
    workDir,
    conversation,
    client,
    registry,
    checker: new PermissionChecker(workDir, "acceptEdits"),
    maxIterations: 3,
    ...overrides,
  };
  return { config, execute };
}

async function collect(config: AgentConfig): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of new Agent(config).run()) {
    events.push(event);
  }
  return events;
}

describe("harness execution boundaries", () => {
  it("rejects a tool excluded by the current agent filter", async () => {
    const { config, execute } = fixture({ toolFilter: () => false });
    const events = await collect(config);
    expect(execute).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolId: "write",
        isError: true,
      }),
    );
  });

  it("does not execute an ask decision without an approval callback", async () => {
    const { config, execute } = fixture();
    config.checker.mode = "default";
    await collect(config);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rechecks cancellation after the permission callback", async () => {
    const controller = new AbortController();
    const toolCallIds: string[] = [];
    const { config, execute } = fixture({
      abortSignal: controller.signal,
      onPermissionRequest: (_toolName, _args, _decision, toolCallId) => {
        toolCallIds.push(toolCallId);
        controller.abort();
        return Promise.resolve("allow");
      },
    });
    config.checker.mode = "default";
    const events = await collect(config);
    expect(toolCallIds).toEqual(["write"]);
    expect(execute).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({
      type: "loop_complete",
      stopReason: "interrupted",
    });
  });

  it("preserves streamed text when the provider throws on abort", async () => {
    const controller = new AbortController();
    const { config } = fixture({ abortSignal: controller.signal });
    config.client.stream = async function* () {
      yield { type: "text_delta", text: "Partial answer" };
      await Promise.resolve();
      controller.abort();
      throw new Error("aborted");
    };
    await collect(config);
    expect(config.conversation.getMessages().at(-1)?.content).toBe(
      "Partial answer",
    );
  });

  it("stops retrying context errors when no compaction can be performed", async () => {
    const { config } = fixture();
    let calls = 0;
    config.client.stream = async function* () {
      calls++;
      yield await Promise.reject(new ContextTooLongError("context too long"));
    };
    const events = await collect(config);
    expect(calls).toBe(1);

    expect(
      events.some(
        (e) => e.type === "error" && e.error instanceof ContextTooLongError,
      ),
    ).toBe(true);
  });
});

describe("permission path boundaries", () => {
  it("resolves relative paths against the agent workDir and rejects sibling prefixes", () => {
    const { config } = fixture();
    expect(
      config.checker.check("WriteFile", "write", { file_path: "src/new.ts" })
        .effect,
    ).toBe("allow");
    const checker = new PermissionChecker("/workspace/project", "acceptEdits");
    expect(
      checker.check("WriteFile", "write", {
        file_path: "/workspace/project-neighbor/a.ts",
      }).effect,
    ).toBe("ask");
    expect(
      config.checker.check("WriteFile", "write", {
        file_path: ".yukino/permissions.yaml",
      }).effect,
    ).toBe("allow");
  });

  it("checks symlink targets including not-yet-created descendants", () => {
    const { config } = fixture();
    const outside = mkdtempSync(join(tmpdir(), "yukino-outside-"));
    // Symlink aliases resolve to their real target: a write through the
    // in-project skill-alias stays allowed, and a read through the external
    // symlink reaches the allowed tmpdir root.
    mkdirSync(join(config.workDir, ".agents", "skills"), { recursive: true });
    symlinkSync(
      join(config.workDir, ".agents", "skills"),
      join(config.workDir, "skill-alias"),
    );
    expect(
      config.checker.check("WriteFile", "write", {
        file_path: join(config.workDir, "skill-alias", "new", "SKILL.md"),
      }).effect,
    ).toBe("allow");
    symlinkSync(outside, join(config.workDir, "external"));
    expect(
      config.checker.check("ReadFile", "read", {
        file_path: join(config.workDir, "external", "file"),
      }).effect,
    ).toBe("allow");
  });

  it("only applies the plan-write exception to the configured plan file", () => {
    const { config } = fixture();
    config.checker.mode = "plan";
    config.checker.planFilePath = join(
      config.workDir,
      ".yukino",
      "plans",
      "current.md",
    );
    expect(
      config.checker.check("WriteFile", "write", {
        file_path: config.checker.planFilePath,
      }).effect,
    ).toBe("allow");
    expect(
      config.checker.check("WriteFile", "write", {
        file_path: config.workDir + "/.yukino/plans/../../source.ts",
      }).effect,
    ).toBe("ask");
    expect(
      config.checker.check("WriteFile", "write", {
        file_path: ".yukino/plans/other.md",
      }).effect,
    ).toBe("ask");
  });

  it("honors explicit deny rules for commands with safe prefixes", () => {
    const { config } = fixture();
    mkdirSync(join(config.workDir, ".yukino"));
    writeFileSync(
      join(config.workDir, ".yukino/permissions.yaml"),
      '- rule: "Bash(git status*)"\n  effect: deny\n',
    );
    expect(
      config.checker.check("Bash", "command", { command: "git status" }).effect,
    ).toBe("deny");
  });
});
