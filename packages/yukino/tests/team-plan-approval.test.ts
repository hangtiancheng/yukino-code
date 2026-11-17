import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import { PermissionChecker } from "@/permissions/index.js";
import { createPlanPath } from "@/plan-file/index.js";
import { AgentTool } from "@/subagent/agent-tool.js";
import { BUILTIN_AGENTS } from "@/subagent/constants.js";
import { spawnSubagent } from "@/subagent/spawn.js";
import { LEADER_NAME, MSG_PLAN_APPROVAL_RESPONSE } from "@/teams/constants.js";
import { TeamManager } from "@/teams/index.js";
import { planApprovalResponse, shutdownRequest } from "@/teams/protocol.js";
import { SendMessageTool } from "@/teams/tools.js";
import { EnterPlanModeTool } from "@/tools/enter-plan-mode.js";
import { ExitPlanModeTool } from "@/tools/exit-plan-mode.js";
import { ToolRegistry } from "@/tools/registry.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  homedir: vi.fn(),
}));

let cwd: string;
let manager: TeamManager;
beforeEach(() => {
  cwd = mkdtempSync(join(os.tmpdir(), "yukino-plan-review-"));
  vi.mocked(os.homedir).mockReturnValue(cwd);
  manager = new TeamManager(cwd, true);
});
afterEach(async () => {
  await manager.dispose();
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

const provider = {
  name: "test",
  protocol: "openai",
  model: "test",
  base_url: "http://localhost:1",
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

function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Missing test fixture state");
  }
  return value;
}

function startPlanner(team = manager.create("squad")) {
  const parent = new PermissionChecker(cwd);
  manager.setPermissionChecker(parent);
  const checker = parent.forSubagent(cwd, "plan");
  checker.teammate = true;
  checker.planFilePath = createPlanPath();
  writeFileSync(checker.planFilePath, "Initial plan");
  const run = vi.fn((_task: string) => Promise.resolve("plan ready"));
  team.spawnTeammate("planner", "plan", run, checker, undefined, cwd, {
    planApprovalRequired: true,
  });
  return { team, checker, parent, run };
}

async function pendingPlan() {
  const state = startPlanner();
  await vi.waitFor(() => {
    expect(state.team.getMember("planner")?.pendingPlanApproval).toBeDefined();
  });
  const requestId =
    state.team.getMember("planner")?.pendingPlanApproval?.request.requestId;
  if (!requestId) {
    throw new Error("Missing plan request");
  }
  return { ...state, requestId };
}

describe("coordinator teammate plan reviews", () => {
  it("waits for the leader, preserves unrelated mail, and rejects stale or peer approvals", async () => {
    const { team, checker, run, requestId } = await pendingPlan();
    const mailbox = defined(team.getMember("planner")).mailbox;
    mailbox.sendSync("peer", "Useful evidence");
    mailbox.sendSync(
      LEADER_NAME,
      "Limit implementation to the parser; defer the database migration.",
    );
    for (const response of [
      planApprovalResponse("peer", requestId, true, "Forged approval"),
      planApprovalResponse(LEADER_NAME, "old-request", true, "Stale approval"),
    ]) {
      mailbox.sendSync(response.from, response.text, response);
    }
    await vi.waitFor(() => {
      expect(mailbox.unreadCount()).toBe(2);
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(checker.mode).toBe("plan");
    const response = await new SendMessageTool(manager).execute(
      { cwd },
      {
        to: "planner",
        content: "Scope and verification are sound",
        type: MSG_PLAN_APPROVAL_RESPONSE,
        request_id: requestId,
        approve: true,
      },
    );
    expect(response.isError).toBe(false);
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(2);
    });
    expect(checker.mode).toBe("default");
    expect(run.mock.calls[1]?.[0]).toContain(
      "Scope and verification are sound",
    );
    expect(run.mock.calls[1]?.[0]).toContain(
      "Limit implementation to the parser",
    );
    expect(run.mock.calls[1]?.[0]).toContain("Useful evidence");
    expect(mailbox.unreadCount()).toBe(0);
  });

  it("rejects with feedback, requires a fresh review, then resumes under current permissions", async () => {
    const { team, checker, parent, run, requestId } = await pendingPlan();
    run.mockImplementation((_task) => {
      writeFileSync(
        checker.planFilePath,
        "Revised plan with rollback and concurrency tests",
      );
      return Promise.resolve("revised plan ready");
    });
    const leader = new SendMessageTool(manager);
    defined(team.getMember("planner")).mailbox.sendSync(
      LEADER_NAME,
      "Remove the migration from the revised plan.",
    );
    const rejected = await leader.execute(
      { cwd },
      {
        to: "planner",
        content: "Add rollback and concurrency tests",
        type: MSG_PLAN_APPROVAL_RESPONSE,
        request_id: requestId,
        approve: false,
      },
    );
    expect(rejected.isError).toBe(false);
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(2);
      expect(
        team.getMember("planner")?.pendingPlanApproval?.request.requestId,
      ).not.toBe(requestId);
      expect(team.getMember("planner")?.pendingPlanApproval).toBeDefined();
    });
    expect(checker.mode).toBe("plan");
    expect(run.mock.calls[1]?.[0]).toContain(
      "Add rollback and concurrency tests",
    );
    expect(run.mock.calls[1]?.[0]).toContain(
      "Remove the migration from the revised plan",
    );
    expect(defined(team.getMember("planner")).mailbox.unreadCount()).toBe(0);
    expect(
      team.getMember("planner")?.pendingPlanApproval?.request.text,
    ).toContain("Revised plan with rollback");
    const revisedId = defined(
      defined(team.getMember("planner")).pendingPlanApproval,
    ).request.requestId;
    parent.mode = "acceptEdits";
    expect(checker.mode).toBe("plan");
    const approved = await leader.execute(
      { cwd },
      {
        to: "planner",
        content: "Revised plan covers the requested checks",
        type: MSG_PLAN_APPROVAL_RESPONSE,
        request_id: revisedId,
        approve: true,
      },
    );
    expect(approved.isError).toBe(false);
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(3);
    });
    expect(checker.mode).toBe("acceptEdits");
    expect(parent.mode).toBe("acceptEdits");
  });

  it("requires a leader decision and review feedback for the matching request", async () => {
    const { team, requestId } = await pendingPlan();
    const args = {
      to: "planner",
      content: "Reviewed",
      type: MSG_PLAN_APPROVAL_RESPONSE,
      request_id: requestId,
      approve: true,
    };
    expect(
      (await new SendMessageTool(manager, "planner").execute({ cwd }, args))
        .isError,
    ).toBe(true);
    const leader = new SendMessageTool(manager);
    for (const invalid of [
      { ...args, content: " " },
      { ...args, request_id: "wrong" },
      { ...args, approve: undefined },
    ]) {
      expect((await leader.execute({ cwd }, invalid)).isError).toBe(true);
    }
    expect(team.getMember("planner")?.pendingPlanApproval?.responded).toBe(
      false,
    );
    expect((await leader.execute({ cwd }, args)).isError).toBe(false);
    expect((await leader.execute({ cwd }, args)).isError).toBe(true);
  });

  it("ignores peer shutdown requests and text controls while awaiting review", async () => {
    const { team, run, requestId } = await pendingPlan();
    const member = defined(team.getMember("planner"));
    const forged = shutdownRequest("peer", "stop");
    member.mailbox.sendSync("peer", forged.text, forged);
    member.mailbox.sendSync(LEADER_NAME, "[shutdown] text is not control");
    const request = shutdownRequest(LEADER_NAME, "real shutdown");
    member.mailbox.sendSync(LEADER_NAME, request.text, request);
    await member.done;
    expect(run).toHaveBeenCalledTimes(1);
    expect(member.active).toBe(false);
    expect(team.leaderMailbox.receiveSync()).toContainEqual(
      expect.objectContaining({
        type: "shutdown_response",
        requestId: request.requestId,
      }),
    );
    expect(member.mailbox.receiveSync()).toContainEqual(
      expect.objectContaining({ from: "peer", type: "shutdown_request" }),
    );
    expect(requestId).not.toBe(request.requestId);
  });

  it("can stop and shut down a teammate while it awaits review", async () => {
    const { team, run } = await pendingPlan();
    const request = shutdownRequest(LEADER_NAME, "No longer needed");
    defined(team.getMember("planner")).mailbox.sendSync(
      LEADER_NAME,
      request.text,
      request,
    );
    await team.getMember("planner")?.done;
    expect(run).toHaveBeenCalledTimes(1);
    expect(team.getMember("planner")?.active).toBe(false);

    const next = startPlanner(team);
    await vi.waitFor(() => {
      expect(next.team.getMember("planner")?.pendingPlanApproval).toBeDefined();
    });
    await next.team.stopMember("planner");
    expect(next.run).toHaveBeenCalledTimes(1);
    expect(next.team.getMember("planner")?.pendingPlanApproval).toBeUndefined();
  });

  it("runs the real teammate ExitPlanMode path without changing the leader's mode or bypassing review", async () => {
    const parent = new PermissionChecker(cwd, "bypassPermissions");
    const registry = new ToolRegistry();
    registry.register(new EnterPlanModeTool(registry));
    registry.register(new ExitPlanModeTool());
    const tool = new AgentTool(cwd, registry, () => Promise.resolve("unused"));
    const modes: string[] = [];
    const worker: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream(_conversation, schemas) {
        await Promise.resolve();
        const checker = defined(
          defined(defined(manager.list()[0]).getMember("planner")).checker,
        );
        modes.push(checker.mode);
        const names = schemas.map((schema) =>
          "function" in schema ? schema.function.name : schema.name,
        );
        expect(names).not.toContain("EnterPlanMode");
        if (modes.length === 1) {
          expect(names).toContain("ExitPlanMode");
          expect(
            checker.check("WriteFile", "write", { file_path: "project.ts" })
              .effect,
          ).toBe("deny");
          writeFileSync(checker.planFilePath, "Plan from the real tool path");
          yield {
            type: "tool_call_complete",
            toolId: "plan",
            toolName: "ExitPlanMode",
            arguments: {},
          };
        } else {
          yield { type: "text_delta", text: "executed" };
        }
        yield end;
      },
    };
    tool.setTeamManager(manager, (tools, checker, memberCwd, options) => {
      const conversation = new ConversationManager();
      const definition = defined(options).definition;
      const directory = defined(memberCwd);
      return (prompt, onEvent, abortSignal) =>
        spawnSubagent(
          definition,
          prompt,
          worker,
          tools,
          provider,
          directory,
          undefined,
          onEvent,
          undefined,
          checker,
          { conversation, abortSignal, backgroundTasks: false },
        );
    });
    expect(
      (
        await tool.execute(
          { cwd, permissionChecker: parent },
          {
            kind: "teammate",
            fork: false,
            prompt: "Plan then execute",
            description: "planner",
            subagent_type: "plan",
          },
        )
      ).isError,
    ).toBe(false);
    await vi.waitFor(() => {
      expect(
        manager.list()[0]?.getMember("planner")?.pendingPlanApproval,
      ).toBeDefined();
    });
    expect(modes).toEqual(["plan"]);
    const requests = defined(manager.list()[0]).leaderMailbox.receiveSync();
    expect(requests).toHaveLength(1);
    expect(requests[0].text).toBe("Plan from the real tool path");
    expect(parent.mode).toBe("bypassPermissions");
    expect(
      (
        await new SendMessageTool(manager).execute(
          { cwd },
          {
            to: "planner",
            type: MSG_PLAN_APPROVAL_RESPONSE,
            request_id: requests[0].requestId,
            approve: true,
            content: "The plan matches the requested scope",
          },
        )
      ).isError,
    ).toBe(false);
    await vi.waitFor(() => {
      expect(modes).toHaveLength(2);
    });
    expect(modes).toEqual(["plan", "bypassPermissions"]);
    const checker = defined(
      defined(defined(manager.list()[0]).getMember("planner")).checker,
    );
    for (const mode of ["default", "acceptEdits", "plan"] as const) {
      parent.mode = mode;
      expect(checker.mode).toBe("bypassPermissions");
      expect(
        checker.check("WriteFile", "write", { file_path: "project.ts" }).effect,
      ).toBe("allow");
    }
  });
});

describe("automatic teammate plan approval", () => {
  it("plans then executes for the plan role outside coordinator mode", async () => {
    await manager.dispose();
    manager = new TeamManager(cwd);
    const parent = new PermissionChecker(cwd);
    const agent = new AgentTool(cwd, new ToolRegistry(), () =>
      Promise.resolve("unused"),
    );
    const modes: string[] = [];
    agent.setTeamManager(manager, (_tools, checker, _cwd, options) => {
      expect(options?.definition.readOnly).not.toBe(true);
      return () => {
        modes.push(defined(checker).mode);
        return Promise.resolve(
          modes.length === 1 ? "Implementation plan" : "Implemented",
        );
      };
    });
    const result = await agent.execute(
      { cwd, permissionChecker: parent },
      {
        description: "planner",
        prompt: "Plan then implement",
        subagent_type: "plan",
        fork: false,
      },
    );
    expect(result.isError).toBe(false);
    await vi.waitFor(() => {
      expect(modes).toEqual(["plan", "default"]);
    });
    expect(
      manager.list()[0]?.getMember("planner")?.pendingPlanApproval,
    ).toBeUndefined();
    expect(parent.mode).toBe("default");
  });
});

describe("permanently read-only teammates", () => {
  it.each([true, false])(
    "keeps explore read-only across follow-ups (coordinator=%s)",
    async (coordinator) => {
      const role = "explore";
      await manager.dispose();
      manager = new TeamManager(cwd, coordinator);
      const parent = new PermissionChecker(cwd, "bypassPermissions");
      const registry = new ToolRegistry();
      registry.register(new ExitPlanModeTool());
      const agent = new AgentTool(cwd, registry, () =>
        Promise.resolve("unused"),
      );
      const modes: string[] = [];
      const run = vi.fn((_prompt: string) => {
        const checker = defined(
          defined(manager.list()[0]).getMember("researcher")?.checker,
        );
        modes.push(checker.mode);
        expect(
          checker.check("Bash", "command", { command: "touch project.ts" })
            .effect,
        ).toBe("deny");
        return Promise.resolve("Research findings only");
      });
      agent.setTeamManager(manager, (tools) => {
        expect(tools.get("ExitPlanMode")).toBeUndefined();
        return run;
      });
      expect(
        (
          await agent.execute(
            { cwd, permissionChecker: parent },
            {
              kind: "teammate",
              fork: false,
              description: "researcher",
              prompt: "Investigate",
              subagent_type: role,
            },
          )
        ).isError,
      ).toBe(false);
      const team = defined(manager.list()[0]);
      await vi.waitFor(() => {
        expect(team.getMember("researcher")?.uiState?.status).toBe("idle");
      });
      const member = defined(team.getMember("researcher"));
      expect(member.planApprovalRequired).toBe(false);
      expect(member.pendingPlanApproval).toBeUndefined();
      expect(manager.drainLeaderMailbox().join("\n")).not.toContain(
        "plan_approval_request",
      );
      for (const mode of [
        "default",
        "acceptEdits",
        "bypassPermissions",
      ] as const) {
        parent.mode = mode;
        expect(member.checker?.mode).toBe("plan");
        expect(member.checker?.forCwd(cwd).mode).toBe("plan");
      }
      expect(
        (
          await new SendMessageTool(manager).execute(
            { cwd },
            {
              to: "researcher",
              type: MSG_PLAN_APPROVAL_RESPONSE,
              request_id: "not-an-execution-request",
              approve: true,
              content: "Begin implementation",
            },
          )
        ).isError,
      ).toBe(true);
      expect(
        (
          await new SendMessageTool(manager).execute(
            { cwd },
            {
              to: "researcher",
              content: "Follow up on the findings; implement if possible",
            },
          )
        ).isError,
      ).toBe(false);
      await vi.waitFor(() => {
        expect(run).toHaveBeenCalledTimes(2);
      });
      expect(modes).toEqual(["plan", "plan"]);
      expect(member.checker?.mode).toBe("plan");
      expect(member.pendingPlanApproval).toBeUndefined();
    },
  );
});

describe("one-shot planning subagents", () => {
  it.each(["plan", "explore"])(
    "enforces the built-in %s role under an elevated parent",
    async (role) => {
      const parent = new PermissionChecker(cwd, "bypassPermissions");
      const registry = new ToolRegistry();
      const mutate = vi.fn(() =>
        Promise.resolve({ output: "mutated", isError: false }),
      );
      registry.register({
        name: "Bash",
        category: "command",
        description: "Shell",
        schema: () => ({
          name: "Bash",
          description: "Shell",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
          },
        }),
        execute: mutate,
      });
      let calls = 0;
      const worker: LLMClient = {
        setSystemPrompt: vi.fn(),
        async *stream(conversation) {
          await Promise.resolve();
          if (calls++ === 0) {
            expect(JSON.stringify(conversation.getMessages())).toContain(
              "permanently read-only",
            );
            yield {
              type: "tool_call_complete",
              toolId: "mutate",
              toolName: "Bash",
              arguments: { command: "touch project.ts" },
            };
          } else {
            expect(JSON.stringify(conversation.getMessages())).toContain(
              "Plan mode forbids mutations",
            );
            yield { type: "text_delta", text: "Read-only findings" };
          }
          yield end;
        },
      };
      const definition = defined(
        BUILTIN_AGENTS.find((agent) => agent.name === role),
      );
      expect(
        await spawnSubagent(
          definition,
          "Investigate",
          worker,
          registry,
          provider,
          cwd,
          undefined,
          undefined,
          undefined,
          parent,
        ),
      ).toContain("Read-only findings");
      expect(mutate).not.toHaveBeenCalled();
      expect(parent.mode).toBe("bypassPermissions");
    },
  );

  it("returns the plan through ExitPlanMode without showing main-thread approval or changing parent mode", async () => {
    const parent = new PermissionChecker(cwd);
    parent.enterPlanMode();
    const registry = new ToolRegistry();
    registry.register(new EnterPlanModeTool(registry));
    registry.register(new ExitPlanModeTool());
    const approve = vi.fn(() => Promise.resolve("allow" as const));
    let calls = 0;
    const worker: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream(conversation, schemas) {
        await Promise.resolve();
        calls++;
        const names = schemas.map((schema) =>
          "function" in schema ? schema.function.name : schema.name,
        );
        expect(names).toContain("ExitPlanMode");
        expect(names).not.toContain("EnterPlanMode");
        const path = /Plan file: ([^\\\n"]+)/u.exec(
          JSON.stringify(conversation.getMessages()),
        )?.[1];
        if (!path) {
          throw new Error("Missing subagent plan path");
        }
        writeFileSync(path, "Subagent implementation and verification plan");
        yield {
          type: "tool_call_complete",
          toolId: "exit",
          toolName: "ExitPlanMode",
          arguments: {},
        };
        yield end;
      },
    };
    const result = await spawnSubagent(
      { name: "planner", description: "Plan the task", permissionMode: "plan" },
      "Plan",
      worker,
      registry,
      provider,
      cwd,
      undefined,
      undefined,
      undefined,
      parent,
      { onPermissionRequest: approve },
    );
    expect(result).toContain("Subagent implementation and verification plan");
    expect(calls).toBe(1);
    expect(approve).not.toHaveBeenCalled();
    expect(parent.mode).toBe("plan");
  });

  it("keeps child mode transitions from clearing the parent's saved pre-plan mode", () => {
    const parent = new PermissionChecker(cwd, "acceptEdits");
    parent.enterPlanMode();
    const child = parent.forSubagent(cwd, "plan");
    child.exitPlanMode();
    expect(parent.mode).toBe("plan");
    expect(parent.exitPlanMode()).toBe("acceptEdits");
  });
});
