import { describe, expect, it, vi } from "vitest";

import { createToolRegistry } from "@yukino.js/bootstrap/tool-registry.js";
import { ConversationManager } from "@yukino.js/conversation";
import type { LLMClient } from "@yukino.js/llm/client.js";
import { PermissionChecker } from "@yukino.js/permissions";
import { AgentTool } from "@yukino.js/subagent/agent-tool.js";
import { BUILTIN_AGENTS } from "@yukino.js/subagent/constants.js";
import { spawnSubagent } from "@yukino.js/subagent/spawn.js";
import { TaskManager } from "@yukino.js/subagent/task-manager.js";
import { TeamManager } from "@yukino.js/teams";
import { TaskList } from "@yukino.js/todo";
import { ToolRegistry } from "@yukino.js/tools/registry.js";
import { contentToText } from "@yukino.js/utils";

const cwd = process.cwd();
const provider = {
  name: "test",
  protocol: "openai",
  base_url: "http://unused.example",
  model: "test",
} as const;
const end = {
  type: "stream_end",
  stopReason: "end_turn",
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
} as const;

function parentConversation(): ConversationManager {
  const conversation = new ConversationManager();
  conversation.addUserMessage("PARENT_CONTEXT");
  conversation.addAssistantFull("Parent investigation", [], []);
  return conversation;
}

describe("independent Agent role and context parameters", () => {
  const combinations = [undefined, "general-purpose", "plan"].flatMap((role) =>
    [undefined, false, true].flatMap((fork) =>
      [false, true].flatMap((defaultFork) =>
        [false, true].map((background) => ({
          role,
          fork,
          defaultFork,
          background,
        })),
      ),
    ),
  );

  it.each(combinations)(
    "selects role=$role and fork=$fork independently (default=$defaultFork, background=$background)",
    async ({ role, fork, defaultFork, background }) => {
      const conversation = parentConversation();
      const before = structuredClone(conversation.getMessages());
      const tasks = new TaskManager();
      const spawn = vi.fn<ConstructorParameters<typeof AgentTool>[2]>(() =>
        Promise.resolve("Worker result"),
      );
      const tool = new AgentTool(
        cwd,
        new ToolRegistry(),
        spawn,
        conversation,
        tasks,
      );
      tool.defaultFork = defaultFork;
      const result = await tool.execute(
        { cwd },
        {
          kind: "subagent",
          description: "Independent assignment",
          prompt: "Do the assigned work",
          run_in_background: background,
          ...(role === undefined ? {} : { subagent_type: role }),
          ...(fork === undefined ? {} : { fork }),
        },
      );
      if (background) {
        await tasks.list()[0]?.done;
      }
      expect(result.isError).toBe(false);
      expect(spawn).toHaveBeenCalledOnce();
      const [definition, , actualBackground, , , context, snapshot] =
        spawn.mock.calls[0];
      expect(definition.name).toBe(role ?? "general-purpose");
      expect(actualBackground).toBe(background);
      expect(context?.subagentSessionId).toBeTruthy();
      if (fork ?? defaultFork) {
        expect(snapshot).not.toBe(conversation);
        expect(snapshot?.getMessages()).toEqual(before);
        snapshot?.addUserMessage("CHILD_ONLY");
      } else {
        expect(snapshot).toBeUndefined();
      }
      expect(conversation.getMessages()).toEqual(before);
      await tasks.stopAll();
    },
  );

  it.each([null, "true", "false", 0, 1, {}, []])(
    "rejects a non-boolean fork argument: %j",
    async (fork) => {
      const spawn = vi.fn(() => Promise.resolve("unused"));
      const tool = new AgentTool(
        cwd,
        new ToolRegistry(),
        spawn,
        parentConversation(),
      );
      expect(
        await tool.execute(
          { cwd },
          { kind: "subagent", description: "Work", prompt: "Work", fork },
        ),
      ).toMatchObject({
        isError: true,
        output: "Error: fork must be a boolean",
      });
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("requires parent context only when fork is true", async () => {
    const spawn = vi.fn(() => Promise.resolve("Fresh result"));
    const tool = new AgentTool(cwd, new ToolRegistry(), spawn);
    expect(
      await tool.execute(
        { cwd },
        { kind: "subagent", description: "Work", prompt: "Work", fork: true },
      ),
    ).toMatchObject({ isError: true });
    expect(spawn).not.toHaveBeenCalled();
    expect(
      await tool.execute(
        { cwd },
        { kind: "subagent", description: "Work", prompt: "Work", fork: false },
      ),
    ).toEqual({ output: "Fresh result", isError: false });
  });

  it("captures a background snapshot before the parent continues", async () => {
    const conversation = parentConversation();
    const tasks = new TaskManager();
    const spawn = vi.fn<ConstructorParameters<typeof AgentTool>[2]>(() =>
      Promise.resolve("done"),
    );
    const tool = new AgentTool(
      cwd,
      new ToolRegistry(),
      spawn,
      conversation,
      tasks,
    );
    await tool.execute(
      { cwd },
      {
        kind: "subagent",
        description: "Work",
        prompt: "Work",
        subagent_type: "plan",
        fork: true,
        run_in_background: true,
      },
    );
    conversation.addUserMessage("LATER_PARENT_MESSAGE");
    await tasks.list()[0]?.done;
    expect(JSON.stringify(spawn.mock.calls[0][6]?.getMessages())).not.toContain(
      "LATER_PARENT_MESSAGE",
    );
    await tasks.stopAll();
  });

  it.each([false, true])(
    "applies each role's tool restrictions with fork=%s",
    async (fork) => {
      for (const name of ["general-purpose", "plan", "explore", "review"]) {
        const parent = parentConversation();
        const registry = createToolRegistry(cwd, new TaskList());
        const client: LLMClient = {
          setSystemPrompt: vi.fn(),
          async *stream(conversation, schemas) {
            await Promise.resolve();
            expect(conversation).not.toBe(parent);
            expect(
              JSON.stringify(conversation.getMessages()).includes(
                "PARENT_CONTEXT",
              ),
            ).toBe(fork);
            expect(
              conversation
                .getMessages()
                .some((message) =>
                  contentToText(message.content).includes(`role "${name}"`),
                ),
            ).toBe(true);
            const serialized = JSON.stringify(schemas);
            expect(serialized.includes('"name":"WriteFile"')).toBe(
              name === "general-purpose",
            );
            expect(serialized).not.toContain('"name":"Agent"');
            yield { type: "text_delta", text: "Worker result" };
            yield end;
          },
        };
        const tool = new AgentTool(
          cwd,
          registry,
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
              { contextSnapshot, background },
            ),
          parent,
        );
        registry.register(tool);
        expect(
          await tool.execute(
            {
              cwd,
              permissionChecker: new PermissionChecker(
                cwd,
                "bypassPermissions",
              ),
            },
            {
              kind: "subagent",
              description: "Work",
              prompt: "Work",
              subagent_type: name,
              fork,
            },
          ),
        ).toMatchObject({ isError: false, output: "Worker result" });
        await registry.dispose();
      }
    },
  );

  it.each([false, true])(
    "passes fork=%s into a teammate's initial context",
    async (fork) => {
      const parent = parentConversation();
      const manager = new TeamManager(cwd);
      const tool = new AgentTool(
        cwd,
        new ToolRegistry(),
        () => Promise.resolve("unused"),
        parent,
      );
      const factory = vi.fn<Parameters<AgentTool["setTeamManager"]>[1]>(
        () => () => Promise.resolve("Teammate result"),
      );
      tool.setTeamManager(manager, factory);
      try {
        expect(
          await tool.execute(
            { cwd },
            {
              kind: "teammate",
              description: "worker",
              prompt: "Work",
              subagent_type: "explore",
              fork,
            },
          ),
        ).toMatchObject({ isError: false });
        expect(factory.mock.calls[0][3]?.definition.name).toBe("explore");
        const snapshot = factory.mock.calls[0][3]?.contextSnapshot;
        expect(snapshot?.getMessages()).toEqual(
          fork ? parent.getMessages() : undefined,
        );
        expect(snapshot).not.toBe(parent);
      } finally {
        await manager.stopAll();
      }
    },
  );

  it("seeds persistent conversations once and injects the selected role", async () => {
    const snapshot = parentConversation();
    const persistent = new ConversationManager();
    const registry = new ToolRegistry();
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream(conversation) {
        await Promise.resolve();
        const history = JSON.stringify(conversation.getMessages());
        expect(history.match(/PARENT_CONTEXT/g)).toHaveLength(1);
        expect(
          conversation
            .getMessages()
            .filter((message) =>
              contentToText(message.content).includes('role "general-purpose"'),
            ),
        ).toHaveLength(1);
        yield { type: "text_delta", text: "done" };
        yield end;
      },
    };
    for (const prompt of ["First assignment", "Second assignment"]) {
      await spawnSubagent(
        BUILTIN_AGENTS[0],
        prompt,
        client,
        registry,
        provider,
        cwd,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          conversation: persistent,
          contextSnapshot: snapshot,
          backgroundTasks: false,
        },
      );
    }
    expect(JSON.stringify(snapshot.getMessages())).not.toContain(
      "First assignment",
    );
    await registry.dispose();
  });
});
