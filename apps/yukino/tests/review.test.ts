import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentEvent } from "@yukino.js/agent/events.js";
import { createDefaultRegistry } from "@yukino.js/commands/commands.js";
import { runSubagentCommand } from "@yukino.js/commands/subagent.js";
import { ConversationManager } from "@yukino.js/conversation";
import { loadInputs } from "@yukino.js/history";
import type { LLMClient } from "@yukino.js/llm/client.js";
import { PermissionChecker } from "@yukino.js/permissions";
import { loadSession } from "@yukino.js/session";
import { yukinoPath } from "@yukino.js/storage";
import { AgentTool } from "@yukino.js/subagent/agent-tool.js";
import { BUILTIN_AGENTS } from "@yukino.js/subagent/constants.js";
import { spawnSubagent } from "@yukino.js/subagent/spawn.js";
import { ToolRegistry } from "@yukino.js/tools/registry.js";
import { contentToText } from "@yukino.js/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "yukino-review-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

function reviewCommand() {
  const command = createDefaultRegistry().find("review");
  if (!command?.agent) {
    throw new Error("Missing review command");
  }
  return { command, agentName: command.agent };
}

describe("/review", () => {
  it("accepts PR numbers, URLs, and review instructions without a form", () => {
    const { command } = reviewCommand();
    expect(command.type).toBe("prompt");
    expect(BUILTIN_AGENTS.some((agent) => agent.name === "review")).toBe(true);
    expect(command.handler({ cwd, args: "" })).toContain("gh pr list");
    for (const args of [
      "42",
      "https://github.com/acme/repo/pull/42",
      "42\nFocus on authentication",
    ]) {
      const prompt = command.handler({ cwd, args });
      expect(prompt).toContain(args);
      expect(prompt).toContain("gh pr view");
      expect(prompt).toContain("gh pr diff");
    }
  });

  it("waits for the foreground agent even when a user definition defaults to background", async () => {
    mkdirSync(yukinoPath("agents"), { recursive: true });
    writeFileSync(
      yukinoPath("agents", "review.md"),
      "---\nname: review\nbackground: true\n---\nReview the PR.",
    );
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const spawn = vi.fn(() => pending);
    const registry = new ToolRegistry();
    registry.register(new AgentTool(cwd, registry, spawn));
    const conversation = new ConversationManager();
    const checker = new PermissionChecker(cwd);
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const { command, agentName } = reviewCommand();
    const run = runSubagentCommand(
      agentName,
      command.handler({ cwd, args: "42" }),
      "/review 42",
      {
        cwd,
        sessionId: "foreground-review",
        registry,
        conversation,
        permissionChecker: checker,
        abortSignal: controller.signal,
        onEvent: (event) => events.push(event),
      },
    );
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ name: "review", background: true }),
      expect.stringContaining("42"),
      false,
      undefined,
      undefined,
      expect.objectContaining({
        permissionChecker: checker,
        abortSignal: controller.signal,
      }),
      undefined,
    );
    expect(events.map((event) => event.type)).toEqual(["tool_use"]);
    const input = loadInputs()[0];
    expect(conversation.getMessages()).toEqual([
      {
        role: "user",
        content: "/review 42",
        userInput: { id: input.id, timestamp: input.timestamp },
      },
    ]);
    resolve("Verified finding in src/auth.ts:12");
    await run;
    expect(conversation.getMessages().at(-1)?.content).toBe(
      "Verified finding in src/auth.ts:12",
    );
    expect(
      loadSession(cwd, "foreground-review").map(({ role, content }) => ({
        role,
        content,
      })),
    ).toEqual([
      { role: "user", content: "/review 42" },
      { role: "assistant", content: "Verified finding in src/auth.ts:12" },
    ]);
    expect(events.at(-1)).toEqual({
      type: "loop_complete",
      stopReason: "end_turn",
    });
  });

  it("uses a fresh child conversation and inherited permissions to inspect a PR", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(() =>
      Promise.resolve({ output: "diff", isError: false }),
    );
    registry.register({
      name: "Bash",
      category: "command",
      description: "Run a command",
      schema: () => ({
        name: "Bash",
        description: "Run a command",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
        },
      }),
      execute,
    });
    const parent = new ConversationManager();
    parent.addUserMessage("PRIVATE_PARENT_CONTEXT");
    const checker = new PermissionChecker(cwd, "bypassPermissions");
    let turns = 0;
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream(conversation) {
        await Promise.resolve();
        expect(conversation).not.toBe(parent);
        const text = conversation
          .getMessages()
          .map((message) => contentToText(message.content))
          .join("\n");
        expect(text).not.toContain("PRIVATE_PARENT_CONTEXT");
        expect(text).toContain("gh pr diff");
        if (turns++ === 0) {
          yield {
            type: "tool_call_complete",
            toolId: "pr-diff",
            toolName: "Bash",
            arguments: { command: "gh pr diff 42" },
          };
        } else {
          yield {
            type: "text_delta",
            text: "Finding: src/auth.ts:12 allows an expired token.",
          };
        }
        yield {
          type: "stream_end",
          stopReason: turns === 1 ? "tool_use" : "end_turn",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        };
      },
    };
    registry.register(
      new AgentTool(
        cwd,
        registry,
        (definition, prompt, background, model, _cwd, context) =>
          spawnSubagent(
            definition,
            prompt,
            client,
            registry,
            {
              name: "test",
              protocol: "openai",
              model: "test",
              base_url: "http://unused.invalid",
            },
            cwd,
            undefined,
            undefined,
            model,
            context?.permissionChecker,
            { background, abortSignal: context?.abortSignal },
          ),
      ),
    );
    const { command, agentName } = reviewCommand();
    const events: AgentEvent[] = [];
    await runSubagentCommand(
      agentName,
      command.handler({ cwd, args: "42" }),
      "/review 42",
      {
        cwd,
        sessionId: "isolated-review",
        registry,
        conversation: parent,
        permissionChecker: checker,
        onEvent: (event) => events.push(event),
      },
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "gh pr diff 42" }),
      ]),
    );
    expect(parent.getMessages().at(-1)?.content).toContain("expired token");
    expect(events.at(-1)).toEqual({
      type: "loop_complete",
      stopReason: "end_turn",
    });
  });

  it("propagates cancellation and reports interrupted runs", async () => {
    const registry = new ToolRegistry();
    const controller = new AbortController();
    registry.register(
      new AgentTool(
        cwd,
        registry,
        (_definition, _prompt, _background, _model, _cwd, context) =>
          new Promise((_resolve, reject) =>
            context?.abortSignal?.addEventListener(
              "abort",
              () => {
                reject(new Error("Stopped"));
              },
              { once: true },
            ),
          ),
      ),
    );
    const { command, agentName } = reviewCommand();
    const events: AgentEvent[] = [];
    const run = runSubagentCommand(
      agentName,
      command.handler({ cwd, args: "42" }),
      "/review 42",
      {
        cwd,
        sessionId: "cancelled-review",
        registry,
        conversation: new ConversationManager(),
        abortSignal: controller.signal,
        onEvent: (event) => events.push(event),
      },
    );
    controller.abort();
    await run;
    const result = events.find((event) => event.type === "tool_result");
    expect(result?.isError).toBe(true);
    expect(result?.output).toContain("Stopped");
    expect(events.at(-1)).toEqual({
      type: "loop_complete",
      stopReason: "interrupted",
    });
  });
});
