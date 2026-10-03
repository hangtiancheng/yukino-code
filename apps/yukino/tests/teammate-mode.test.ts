import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

import type { AgentEvent } from "@/agent/events.js";
import { Agent } from "@/agent/index.js";
import * as config from "@/config/index.js";
import * as clients from "@/llm/client.js";
import { OpenAIClient } from "@/llm/openai.js";
import * as logger from "@/logger/index.js";
import { MCPManager } from "@/mcp/manager.js";
import { PermissionChecker } from "@/permissions/index.js";
import { runTeammate } from "@/teammate.js";
import { FileMailbox } from "@/teams/file-mailbox.js";
import { TeamManager } from "@/teams/index.js";
import { teamDir } from "@/teams/team-file.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  homedir: vi.fn(),
}));

let workDir: string;
let requests: string[];
let args: Parameters<typeof runTeammate>[0];
let exitListeners: number;
let disconnect: MockInstance<MCPManager["disconnectAll"]>;
let connect: MockInstance<MCPManager["connectAll"]>;

beforeEach(() => {
  workDir = mkdtempSync(join(os.tmpdir(), "yukino-teammate-mode-"));
  args = {
    teamDir: join(workDir, "inboxes"),
    teamName: "test",
    memberName: "ann",
    initialTask: "Review the project",
    permissionMode: "default",
  };
  vi.spyOn(process, "cwd").mockReturnValue(workDir);
  vi.mocked(os.homedir).mockReturnValue(workDir);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(console, "log").mockImplementation(() => {
    /** noop */
  });
  vi.spyOn(logger, "initLogger").mockReturnValue(
    logger.createChildLogger({ module: "test" }),
  );
  vi.spyOn(logger, "closeLogger").mockImplementation(() => {
    /** noop */
  });
  exitListeners = process.listenerCount("exit");
  vi.spyOn(config, "loadConfig").mockReturnValue({
    default_provider: 0,
    providers: [
      {
        name: "test",
        protocol: "openai",
        model: "test",
        base_url: "https://test.invalid",
        context_window: 16_000,
        max_output_tokens: 2_000,
      },
    ],
    hooks: [],
    mcp_servers: [{ name: "test", command: "unused" }],
  });
  connect = vi.spyOn(MCPManager.prototype, "connectAll").mockResolvedValue({
    tools: [],
    servers: [],
    errors: [],
    instructions: [],
  });
  disconnect = vi
    .spyOn(MCPManager.prototype, "disconnectAll")
    .mockResolvedValue();
  requests = [];
  const client = new OpenAIClient(
    {
      name: "test",
      protocol: "openai",
      model: "test",
      base_url: "https://test.invalid",
      api_key: "test",
    },
    "system",
  );
  vi.spyOn(client, "stream").mockImplementation(async function* (conversation) {
    await Promise.resolve();
    requests.push(JSON.stringify(conversation.getMessages()));
    yield { type: "text_delta", text: "answer" };
    yield {
      type: "stream_end",
      stopReason: "end_turn",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    };
  });
  vi.spyOn(clients, "createClient").mockResolvedValue(client);
});

afterEach(() => {
  expect(process.listenerCount("exit")).toBe(exitListeners);
  vi.restoreAllMocks();
  rmSync(workDir, { recursive: true, force: true });
});

async function queue(...messages: string[]): Promise<void> {
  const mailbox = new FileMailbox(args.teamDir, args.memberName);
  for (const message of messages) {
    await mailbox.send("leader", message);
  }
}

async function* events(...items: AgentEvent[]): AsyncGenerator<AgentEvent> {
  await Promise.resolve();
  yield* items;
}

describe("teammate entry point", () => {
  it("follows permission changes persisted by the leader without inheriting its plan mode", async () => {
    const parent = new PermissionChecker(workDir, "acceptEdits");
    const manager = new TeamManager(workDir);
    manager.setPermissionChecker(parent);
    manager.create(args.teamName, "tmux").addMember(args.memberName);
    args.teamDir = join(teamDir(workDir, args.teamName), "inboxes");
    args.permissionMode = "acceptEdits";
    await queue("[shutdown] done");
    vi.spyOn(Agent.prototype, "run").mockImplementation(function (this: Agent) {
      const checker: unknown = Reflect.get(this, "checker");
      if (!(checker instanceof PermissionChecker)) {
        throw new Error("Missing checker");
      }
      return (async function* () {
        await Promise.resolve();
        const outside = {
          file_path: join(
            os.tmpdir(),
            "..",
            "yukino-outside-project",
            "file.ts",
          ),
        };
        expect(checker.mode).toBe("acceptEdits");
        expect(checker.check("ReadFile", "read", outside).effect).toBe("allow");
        expect(checker.check("WriteFile", "write", outside).reason).toContain(
          "outside allowed directories",
        );
        parent.mode = "bypassPermissions";
        expect(checker.check("WriteFile", "write", outside).effect).toBe(
          "allow",
        );
        expect(
          checker.check("Bash", "command", { command: "pnpm test" }).effect,
        ).toBe("allow");
        parent.mode = "plan";
        expect(checker.mode).toBe("bypassPermissions");
        expect(checker.check("WriteFile", "write", outside).effect).toBe(
          "allow",
        );
        parent.mode = "default";
        expect(checker.check("ReadFile", "read", outside).effect).toBe("allow");
        expect(checker.check("WriteFile", "write", outside).reason).toContain(
          "outside allowed directories",
        );
        expect(
          checker.check("WriteFile", "write", { file_path: "a.ts" }).effect,
        ).toBe("ask");
        yield {
          type: "loop_complete" as const,
          stopReason: "completed" as const,
        };
      })();
    });
    await runTeammate(args);
  });

  it("injects project instructions, handles follow-ups and disconnects on mailbox shutdown", async () => {
    writeFileSync(
      join(workDir, "AGENTS.md"),
      "Preserve the project constraint.",
    );
    await queue("Review the follow-up", "[shutdown] done");
    await runTeammate(args);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("Preserve the project constraint.");
    expect(requests[1]).toContain("Review the follow-up");
    expect(disconnect).toHaveBeenCalledOnce();
    expect(logger.closeLogger).toHaveBeenCalledOnce();
    expect(new FileMailbox(args.teamDir, "leader").receiveSync()).toHaveLength(
      2,
    );
  });

  it.each(["initial", "follow-up"])(
    "propagates %s errors, reports the failure to the leader, and never reports completion",
    async (phase) => {
      const run = vi.spyOn(Agent.prototype, "run");
      if (phase === "follow-up") {
        run.mockImplementationOnce(() =>
          events({ type: "loop_complete", stopReason: "end_turn" }),
        );
      }
      run.mockImplementation(() =>
        events({ type: "error", error: new Error("provider failed") }),
      );
      await queue("Follow-up task", "[shutdown] done");

      await expect(runTeammate(args)).rejects.toThrow("provider failed");
      // The leader is told the teammate failed ([idle] … failed: …) instead
      // of its UI status staying "running" forever; an initial failure sends
      // just the failure notice, a follow-up failure also carries the
      // initial task's idle notice.
      const leaderMail = new FileMailbox(args.teamDir, "leader").receiveSync();
      expect(leaderMail).toHaveLength(phase === "initial" ? 1 : 2);
      expect(
        leaderMail.some((m) => m.text.includes("failed: provider failed")),
      ).toBe(true);
      expect(
        leaderMail.some((m) =>
          m.text.includes("has completed their task and is waiting"),
        ),
      ).toBe(phase === "follow-up");
      expect(disconnect).toHaveBeenCalledOnce();
      expect(logger.closeLogger).toHaveBeenCalledOnce();
    },
  );

  it("retains MCP ownership when setup fails and the teammate continues", async () => {
    connect.mockRejectedValue(new Error("setup failed"));
    await queue("[shutdown] done");
    await runTeammate(args);
    expect(requests).toHaveLength(1);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("cleans up a thrown stream error without replacing it with a cleanup error", async () => {
    vi.spyOn(Agent.prototype, "run").mockImplementation(() => {
      throw new Error("stream failed");
    });
    disconnect.mockRejectedValue(new Error("cleanup failed"));
    await expect(runTeammate(args)).rejects.toThrow("stream failed");
    expect(disconnect).toHaveBeenCalledOnce();
    expect(logger.closeLogger).toHaveBeenCalledOnce();
  });

  it("closes logging and removes its exit listener when client initialization fails", async () => {
    vi.mocked(clients.createClient).mockRejectedValue(
      new Error("client failed"),
    );
    await expect(runTeammate(args)).rejects.toThrow("client failed");
    expect(logger.closeLogger).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
  });
});
