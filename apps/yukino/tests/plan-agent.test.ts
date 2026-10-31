import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import { Agent } from "@/agent/index.js";
import { createToolRegistry } from "@/bootstrap/tool-registry.js";
import { createDefaultRegistry } from "@/commands/commands.js";
import { runSubagentCommand } from "@/commands/subagent.js";
import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import type { StreamEvent } from "@/llm/events.js";
import { PermissionChecker } from "@/permissions/index.js";
import { loadPlan } from "@/plan-file/index.js";
import { newSessionId } from "@/session/index.js";
import { yukinoPath } from "@/storage/index.js";
import { AgentTool } from "@/subagent/agent-tool.js";
import { BUILTIN_AGENTS } from "@/subagent/constants.js";
import { spawnSubagent } from "@/subagent/spawn.js";
import { TaskList } from "@/todo/index.js";

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
const provider = {
  name: "test",
  protocol: "openai",
  base_url: "http://unused.example",
  model: "test",
} as const;

function fixture(client: LLMClient) {
  const cwd = process.cwd();
  const conversation = new ConversationManager();
  conversation.addUserMessage("Plan a fix for the request cancellation bug.");
  conversation.addAssistantFull("I found the relevant lifecycle code.", [], []);
  const checker = new PermissionChecker(cwd, "acceptEdits");
  const registry = createToolRegistry(new TaskList());
  const spawn = vi.fn<ConstructorParameters<typeof AgentTool>[2]>(
    (
      definition,
      prompt,
      background,
      model,
      childCwd,
      context,
      contextSnapshot,
    ) =>
      spawnSubagent(
        definition,
        prompt,
        client,
        registry,
        provider,
        childCwd ?? cwd,
        undefined,
        undefined,
        model,
        context?.permissionChecker,
        {
          contextSnapshot,
          background,
          abortSignal: context?.abortSignal,
          sessionId: context?.subagentSessionId,
        },
      ),
  );
  const agentTool = new AgentTool(cwd, registry, spawn, conversation);
  agentTool.defaultFork = false;
  registry.register(agentTool);
  return { cwd, conversation, checker, registry, spawn };
}

describe("foreground planning", () => {
  it("runs the built-in general-purpose role synchronously with a snapshot even when a user definition overrides it", async () => {
    const context = fixture({
      setSystemPrompt: vi.fn(),
      async *stream() {
        await Promise.resolve();
        yield end;
      },
    });
    const directory = yukinoPath("agents");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "general-purpose.md"),
      "---\nname: general-purpose\nbackground: true\n---\nUser-defined role.",
    );
    let release!: (output: string) => void;
    const spawn = vi.fn<ConstructorParameters<typeof AgentTool>[2]>(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const agent = new AgentTool(
      context.cwd,
      context.registry,
      spawn,
      context.conversation,
    );
    agent.defaultFork = false;
    const controller = new AbortController();
    const pending = agent.runBuiltin(
      "general-purpose",
      {
        cwd: context.cwd,
        abortSignal: controller.signal,
        permissionChecker: context.checker,
      },
      "Analyze feedback",
    );
    const [definition, , background, , , execution, snapshot] =
      spawn.mock.calls[0];
    expect(definition).toBe(
      BUILTIN_AGENTS.find((entry) => entry.name === "general-purpose"),
    );
    expect(background).toBe(false);
    expect(execution?.abortSignal).toBe(controller.signal);
    expect(snapshot).not.toBe(context.conversation);
    expect(snapshot?.getMessages()).toEqual(context.conversation.getMessages());
    snapshot?.addUserMessage("CHILD_ONLY");
    expect(JSON.stringify(context.conversation.getMessages())).not.toContain(
      "CHILD_ONLY",
    );
    release("Feedback findings");
    await expect(pending).resolves.toEqual({
      output: "Feedback findings",
      isError: false,
    });
    expect(context.checker.mode).toBe("acceptEdits");
    await context.registry.dispose();
  });
  it.each(["command", "tool"])(
    "runs the built-in plan with isolated inherited context through the %s entry",
    async (entry) => {
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const plan =
        "Inspect cancellation ownership, fix propagation, and verify interrupted runs.";
      const events: AgentEvent[] = [];
      const stream = vi.fn<LLMClient["stream"]>(async function* (conversation) {
        if (conversation === context.conversation) {
          yield {
            type: "tool_call_start",
            toolId: "enter-plan",
            toolName: "EnterPlanMode",
          };
          yield {
            type: "tool_call_complete",
            toolId: "enter-plan",
            toolName: "EnterPlanMode",
            arguments: {},
          };
          yield { ...end, stopReason: "tool_use" };
        } else {
          await waiting;
          yield { type: "text_delta", text: plan };
          yield end;
        }
      });
      const context = fixture({ stream, setSystemPrompt: vi.fn() });
      const userAgents = yukinoPath("agents");
      mkdirSync(userAgents, { recursive: true });
      writeFileSync(
        join(userAgents, "plan.md"),
        "---\nname: plan\nbackground: true\n---\nIgnore the builtin role.",
      );
      const replacement = new AgentTool(
        context.cwd,
        context.registry,
        context.spawn,
        context.conversation,
      );
      replacement.defaultFork = false;
      context.registry.register(replacement);
      const controller = new AbortController();
      let settled = false;
      const run = async () => {
        if (entry === "command") {
          const commands = createDefaultRegistry();
          const command = commands.find("plan");
          if (!command) {
            throw new Error("Missing plan command");
          }
          expect(command).toMatchObject({ type: "prompt", agent: "plan" });
          await runSubagentCommand(
            "plan",
            command.handler({ cwd: context.cwd, args: "Fix cancellation" }),
            "/plan Fix cancellation",
            {
              ...context,
              permissionChecker: context.checker,
              sessionId: newSessionId(),
              abortSignal: controller.signal,
              onEvent: (event) => {
                events.push(event);
              },
            },
          );
        } else {
          const agent = new Agent({
            ...context,
            client: { stream, setSystemPrompt: vi.fn() },
            abortSignal: controller.signal,
          });
          for await (const event of agent.run()) {
            events.push(event);
          }
        }
        settled = true;
      };
      const running = run();
      await vi.waitFor(() => {
        expect(context.spawn).toHaveBeenCalledOnce();
      });
      await vi.waitFor(() => {
        expect(stream).toHaveBeenCalledTimes(entry === "tool" ? 2 : 1);
      });
      expect(settled).toBe(false);
      const [definition, prompt, background, , , execution, snapshot] =
        context.spawn.mock.calls[0];
      expect(definition).toBe(
        BUILTIN_AGENTS.find((agent) => agent.name === "plan"),
      );
      expect(background).toBe(false);
      expect(execution?.abortSignal).toBe(controller.signal);
      expect(execution?.subagentSessionId).toBeTruthy();
      expect(snapshot).not.toBe(context.conversation);
      expect(JSON.stringify(snapshot?.getMessages())).toContain(
        "request cancellation bug",
      );
      expect(prompt).toContain("implementation plan");
      const childCall = stream.mock.calls.at(-1);
      if (!childCall) {
        throw new Error("Missing plan agent request");
      }
      const schemas = JSON.stringify(childCall[1]);
      for (const tool of [
        "Agent",
        "EnterPlanMode",
        "ExitPlanMode",
        "EditFile",
        "WriteFile",
      ]) {
        expect(schemas).not.toContain(`"name":"${tool}"`);
      }
      expect(JSON.stringify(childCall[0].getMessages())).toContain(
        "permanently read-only",
      );
      if (entry === "tool") {
        expect(childCall[0].getMessages()).toContainEqual(
          expect.objectContaining({
            toolResults: [
              expect.objectContaining({
                toolUseId: "enter-plan",
                isError: false,
              }),
            ],
          }),
        );
        expect(
          context.conversation.getMessages().at(-1)?.toolResults,
        ).toBeUndefined();
      }
      release();
      await running;
      expect(loadPlan(context.checker)).toBe(plan);
      expect(context.checker.mode).toBe("plan");
      expect(events.at(-1)).toMatchObject({
        type: "loop_complete",
        stopReason: "end_turn",
      });
      expect(stream).toHaveBeenCalledTimes(entry === "tool" ? 2 : 1);
      expect(JSON.stringify(context.conversation.getMessages())).not.toContain(
        "permanently read-only",
      );
      await context.registry.dispose();
    },
  );

  it.each(["cancel", "fail", "empty"])(
    "does not submit a plan when the child ends with %s",
    async (outcome) => {
      const controller = new AbortController();
      const context = fixture({
        setSystemPrompt: vi.fn(),
        async *stream() {
          await Promise.resolve();
          if (outcome === "fail") {
            throw new Error("Planning failed");
          }
          if (outcome === "cancel") {
            controller.abort();
          }
          yield end;
        },
      });
      const tool = context.registry.get("EnterPlanMode");
      if (!tool) {
        throw new Error("Missing EnterPlanMode tool");
      }
      const result = await tool.execute(
        {
          cwd: context.cwd,
          permissionChecker: context.checker,
          abortSignal: controller.signal,
        },
        {},
      );
      expect(result.isError).toBe(true);
      expect(loadPlan(context.checker)).toBeNull();
      await context.registry.dispose();
    },
  );
});
