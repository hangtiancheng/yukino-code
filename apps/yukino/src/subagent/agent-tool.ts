import { randomBytes } from "node:crypto";

import z from "zod";

import type { AgentDefinition } from "./definition.js";
import { loadAgentDefinitions } from "./loader.js";
import { TaskFailure, TaskManager } from "./task-manager.js";
import {
  cloneRegistryForTeammate,
  filterToolsForAgent,
  FORK_QUERY_SOURCE,
} from "./tool-filter.js";

import type { ConversationManager } from "@/conversation/index.js";
import { createChildLogger, sanitizeNameSegment } from "@/logger/index.js";
import { PermissionChecker } from "@/permissions/index.js";
import { newSessionId } from "@/session/index.js";
import { sessionPath } from "@/storage/paths.js";
import type { TeamManager, RunAgent } from "@/teams/index.js";
import { isValidTeammateName, LEADER_NAME } from "@/teams/protocol.js";
import {
  TeamTaskCreateTool,
  TeamTaskGetTool,
  TeamTaskListTool,
  TeamTaskUpdateTool,
} from "@/teams/task-tools.js";
import { SendMessageTool } from "@/teams/tools.js";
import type { ToolRegistry } from "@/tools/registry.js";
import type {
  Tool,
  ToolResult,
  ToolContext,
  ToolSchema,
} from "@/tools/types.js";
import { asErrorString, boolArg, strArg } from "@/utils/index.js";
import { buildWorktreeNotice, createAgentWorktree } from "@/worktree/index.js";

const log = createChildLogger({ module: "subagent" });
/** Fallback target when subagent_type is omitted and fork is disabled */
const GENERAL_PURPOSE_AGENT_TYPE = "general-purpose";

/** Worktree directory name. Uses a random string instead of the task description — spaces and non-ASCII characters in descriptions cannot be used directly as branch names. */
function newAgentSlug(): string {
  return `agent-a${randomBytes(4).toString("hex").slice(0, 7)}`;
}

// Leading marker for forked child Agents — used for nested fork detection
const FORK_BOILERPLATE_TAG = "<fork_boilerplate>";
// System instructions injected into forked child Agents
const FORK_BOILERPLATE = `${FORK_BOILERPLATE_TAG}
You are a forked Yukino worker, not the parent agent. The inherited conversation is background context; work only on the assignment that follows.
Do not fork again or ask the user for confirmation. Respect current permissions and report blockers to the parent. Return a concise account of findings or changes, relevant paths, checks actually run, and remaining work.
</fork_boilerplate>`;

export interface TeammateRunOptions {
  agentName: string;
  definition: AgentDefinition;
  modelOverride?: string;
  onPermissionRequest?: ToolContext["onPermissionRequest"];
}

export class AgentTool implements Tool {
  name = "Agent";
  description = "Launch a subagent to handle complex, multi-step tasks.";
  category = "command" as const;

  isConcurrencySafe(): boolean {
    return true;
  }

  private definitions: AgentDefinition[];
  private registry: ToolRegistry;
  private conversation?: ConversationManager;
  private taskManager: TaskManager;

  // Identifies the derived context of the current AgentTool instance;
  // re-forking is prohibited when non-empty and equal to FORK_QUERY_SOURCE
  querySource = "";

  /** Optional: Team manager, enables the team_name parameter. */
  private teamManager?: TeamManager;
  private cwd: string;
  /**
   * When fork is disabled, omitting subagent_type no longer forks but falls back to the
   * general-purpose agent. The "disabled" semantics (rather than "enabled") are used so
   * that the default value represents the default behavior (fork available), and each
   * construction site does not need to explicitly assign it.
   */
  forkDisabled = false;
  /**
   * Optional: factory that produces a per-teammate RunAgent. Receives a
   * teammate-scoped tool registry (with shared task-board tools injected)
   * and returns the callback that runs the teammate agent's main loop.
   */
  private teamRunAgentFactory?: (
    registry: ToolRegistry,
    checker?: PermissionChecker,
    cwd?: string,
    options?: TeammateRunOptions,
  ) => RunAgent;

  private spawnHandler: (
    definition: AgentDefinition,
    prompt: string,
    background: boolean,
    modelOverride?: string,
    cwdOverride?: string,
    context?: ToolContext,
  ) => Promise<string>;

  private forkHandler?: (
    prompt: string,
    conversation: ConversationManager,
    registry: ToolRegistry,
    modelOverride?: string,
    context?: ToolContext,
  ) => Promise<string>;

  constructor(
    cwd: string,
    registry: ToolRegistry,
    spawnHandler: (
      def: AgentDefinition,
      prompt: string,
      bg: boolean,
      modelOverride?: string,
      cwdOverride?: string,
      context?: ToolContext,
    ) => Promise<string>,
    conversation?: ConversationManager,
    forkHandler?: (
      prompt: string,
      conversation: ConversationManager,
      registry: ToolRegistry,
      modelOverride?: string,
      context?: ToolContext,
    ) => Promise<string>,
    taskManager = new TaskManager(),
  ) {
    this.definitions = loadAgentDefinitions();
    this.cwd = cwd;
    this.registry = registry;
    this.spawnHandler = spawnHandler;
    this.conversation = conversation;
    this.forkHandler = forkHandler;
    this.taskManager = taskManager;
  }

  /**
   * Sets the team manager and teammate run callback, enabling the team_name parameter
   * so teammates can be spawned directly through the Agent tool.
   */
  setTeamManager(
    mgr: TeamManager,
    runAgentFactory: (
      registry: ToolRegistry,
      checker?: PermissionChecker,
      cwd?: string,
      options?: TeammateRunOptions,
    ) => RunAgent,
  ): void {
    this.teamManager = mgr;
    this.teamRunAgentFactory = runAgentFactory;
  }

  forFork(registry: ToolRegistry): AgentTool {
    const agent = new AgentTool(
      this.cwd,
      registry,
      this.spawnHandler,
      this.conversation,
      this.forkHandler,
    );
    agent.querySource = FORK_QUERY_SOURCE;
    agent.forkDisabled = this.forkDisabled;
    return agent;
  }

  schema(): ToolSchema {
    const agentTypes = this.definitions.map((d) => d.name);
    return {
      name: this.name,
      description: this.buildDescription(),
      input_schema: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "Short description of what the agent will do",
          },
          name: {
            type: "string",
            description:
              "Optional stable teammate name when team_name is set. Use only letters, digits, underscores, and hyphens.",
          },
          prompt: {
            type: "string",
            description: "The task for the agent to perform",
          },
          subagent_type: {
            type: "string",
            enum: agentTypes,
            description: this.forkDisabled
              ? "Agent role. Defaults to general-purpose."
              : "Agent role. Omit to fork the current conversation snapshot.",
          },
          model: {
            type: "string",
            description: "Override the model for this agent.",
          },
          run_in_background: {
            type: "boolean",
            description:
              "Run this one-shot subagent asynchronously. Returns a task ID immediately and delivers the final result through a task notification.",
            default: false,
          },
          isolation: {
            type: "string",
            enum: ["worktree"],
            description:
              "Set to 'worktree' to run the agent in its own Git worktree, so its edits " +
              "cannot collide with the parent or with other agents working in parallel.",
          },
          plan_mode_required: {
            type: "boolean",
            description:
              "Only meaningful together with team_name. Requests plan mode, subject to parent " +
              "acceptEdits/bypassPermissions overrides. In plan mode, the teammate investigates " +
              "and writes its plan; the runtime automatically approves the submitted plan and " +
              "resumes execution under the current tool permissions.",
          },
          team_name: {
            type: "string",
            description:
              "REQUIRED when creating team members. Spawns the agent as a long-running " +
              "teammate under this team (created via TeamCreate). Unlike regular subagents, " +
              "team members persist after the leader returns and communicate via SendMessage. " +
              "Without team_name the agent runs as a one-shot subagent that blocks and returns inline.",
          },
        },
        required: ["description", "prompt"],
      },
    };
  }

  private buildDescription(): string {
    const context = this.forkDisabled
      ? "Omitting subagent_type selects general-purpose."
      : "Omitting subagent_type forks a snapshot of the current conversation.";
    const roles = this.definitions.map(
      (definition) => `- ${definition.name}: ${definition.description}`,
    );
    return `Delegate a bounded task to a subagent. ${context} A named role receives a fresh conversation, so include the goal, relevant files, constraints, whether edits are allowed, and the expected result.

Available roles (pass a role as subagent_type, not as a tool name):
${roles.join("\n")}

Foreground calls return results inline. With run_in_background=true, the call returns a task ID immediately and the final result arrives through a task notification. Use team_name for persistent teammates and SendMessage for their follow-up assignments. Do not predict results before receiving them.

Launch independent tasks together; avoid concurrent writes to the same files. Review returned evidence and integrate it before reporting completion. Worktree isolation separates edits but does not merge them.`;
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    if (ctx.abortSignal?.aborted) {
      return { output: "Error: operation interrupted", isError: true };
    }
    const description = strArg(args, "description");
    const prompt = strArg(args, "prompt");
    if (!description || !prompt) {
      return {
        output: "Error: description and prompt are required",
        isError: true,
      };
    }

    // The routing when subagent_type is omitted is determined by configuration: if fork is
    // enabled, it inherits the parent conversation; if disabled, it is treated as unspecified
    // and falls back to the general-purpose agent. No error is thrown here — the model simply
    // did not provide an optional parameter, and aborting the call for that is not worthwhile;
    // the general-purpose agent can get the job done just as well.
    const subagentType =
      strArg(args, "subagent_type") ||
      (this.forkDisabled ? GENERAL_PURPOSE_AGENT_TYPE : "");
    const modelOverride = strArg(args, "model") || undefined;
    const backgroundArg = z
      .boolean()
      .optional()
      .safeParse(args.run_in_background);
    if (!backgroundArg.success) {
      return {
        output: "Error: run_in_background must be a boolean",
        isError: true,
      };
    }
    const background = backgroundArg.data ?? false;
    ctx = { ...ctx, subagentSessionId: newSessionId() };
    const teamName = strArg(args, "team_name");
    const teammateName = strArg(args, "name");
    const isolation = strArg(args, "isolation");

    // Team-member path: team_name takes precedence over fork/subagent. Runs the agent as a
    // persistent teammate and notifies the leader via SendMessage / mailbox upon completion.
    if (teamName && this.teamManager && this.teamRunAgentFactory) {
      const definition = this.definitions.find(
        (d) => d.name === (subagentType || GENERAL_PURPOSE_AGENT_TYPE),
      );
      if (!definition) {
        return {
          output: `Error: unknown agent type '${subagentType}'.`,
          isError: true,
        };
      }
      return await this.runAsTeammate(
        teamName,
        teammateName,
        description,
        prompt,
        boolArg(args, "plan_mode_required"),
        isolation === "worktree" || definition.isolation === "worktree",
        ctx,
        definition,
        modelOverride,
      );
    }
    if (teamName) {
      return {
        output:
          "Error: teammate execution is unavailable; no team was created.",
        isError: true,
      };
    }

    if (!subagentType) {
      if (background && this.conversation && this.forkHandler) {
        const snapshot = this.conversation.fork();
        return this.startBackground(description, ctx, (backgroundContext) =>
          this.runFork(
            prompt,
            description,
            modelOverride,
            backgroundContext,
            isolation === "worktree",
            snapshot,
            true,
          ),
        );
      }
      return this.runFork(
        prompt,
        description,
        modelOverride,
        ctx,
        isolation === "worktree",
      );
    }

    const definition = this.definitions.find((d) => d.name === subagentType);
    if (!definition) {
      return {
        output: `Error: unknown agent type '${subagentType}'. Available: ${this.definitions.map((d) => d.name).join(", ")}`,
        isError: true,
      };
    }
    const runInBackground =
      backgroundArg.data ?? definition.background ?? false;

    // Worktree isolation: provision a separate working copy for the child agent; its changes
    // land on its own branch and cannot collide with the parent or other parallel child agents.
    let effectivePrompt = prompt;
    let cwdOverride: string | undefined;
    if (isolation === "worktree" || definition.isolation === "worktree") {
      try {
        const wt = await createAgentWorktree(
          newAgentSlug(),
          undefined,
          ctx.cwd,
        );
        cwdOverride = wt.path;
        effectivePrompt = `${buildWorktreeNotice(this.cwd, wt.path)}

${prompt}`;
      } catch (e) {
        return {
          output: `Error creating agent worktree: ${asErrorString(e)}`,
          isError: true,
        };
      }
    }

    const run = async (runContext: ToolContext): Promise<ToolResult> => {
      try {
        const output = await this.spawnHandler(
          definition,
          effectivePrompt,
          runInBackground,
          modelOverride,
          cwdOverride ??
            (runContext.cwd !== this.cwd ? runContext.cwd : undefined),
          runContext,
        );
        return {
          output: cwdOverride
            ? `${output}\n\nWorktree retained at: ${cwdOverride}`
            : output,
          isError: false,
        };
      } catch (err) {
        return {
          output: `Agent error: ${asErrorString(err)}${cwdOverride ? `\nWorktree retained at: ${cwdOverride}` : ""}`,
          isError: true,
        };
      }
    };

    return runInBackground
      ? this.startBackground(description, ctx, run)
      : run(ctx);
  }

  private startBackground(
    description: string,
    ctx: ToolContext,
    runner: (context: ToolContext) => Promise<ToolResult>,
  ): ToolResult {
    const controller = new AbortController();
    const task = (ctx.taskManager ?? this.taskManager).create(
      description,
      async (backgroundTask) => {
        const result = await runner({
          ...ctx,
          backgroundTaskId: backgroundTask.id,
          abortSignal: controller.signal,
        });
        if (result.isError) {
          if (controller.signal.aborted) {
            throw new Error(result.output);
          }
          throw new TaskFailure(result.output);
        }
        return result.output;
      },
      () => {
        controller.abort();
      },
      {
        originToolCallId: ctx.toolCallId,
        transcriptPath: ctx.subagentSessionId
          ? sessionPath(ctx.subagentSessionId, "transcript.jsonl")
          : undefined,
      },
    );
    return {
      output: `Background agent '${description}' started (task_id: ${task.id}). Its result will arrive as a task notification.`,
      isError: false,
    };
  }

  /**
   * Team-member mode: Spawns a persistent teammate in the specified team.
   * Runs persistently within this process.
   */
  private async runAsTeammate(
    teamName: string,
    requestedName: string,
    description: string,
    prompt: string,
    planModeRequired: boolean,
    worktreeIsolation: boolean,
    ctx: ToolContext,
    definition: AgentDefinition,
    modelOverride?: string,
  ): Promise<ToolResult> {
    if (!this.teamManager) {
      return {
        output: `Error: team manager '${teamName}' not found.`,
        isError: true,
      };
    }
    if (requestedName && !isValidTeammateName(requestedName)) {
      return {
        output:
          `Error: invalid teammate name '${requestedName}'. ` +
          "Use only letters, digits, underscores, and hyphens; 'leader' is reserved.",
        isError: true,
      };
    }
    // Auto-creation must not tear down another team's running workers.
    let team = this.teamManager.get(teamName);
    if (!team) {
      if (this.teamManager.list().length) {
        return {
          output:
            "Error: another team already exists. Use its team_name or explicitly delete it before creating a different team.",
          isError: true,
        };
      }
      team = this.teamManager.create(teamName, {
        leaderAgentId: LEADER_NAME,
        description,
      });
    }

    const previousMember = requestedName
      ? team.getMember(requestedName)
      : undefined;
    if (
      previousMember &&
      !previousMember.active &&
      !previousMember.cancel &&
      !previousMember.done &&
      previousMember.uiState &&
      ["completed", "failed", "stopped"].includes(previousMember.uiState.status)
    ) {
      team.removeMember(requestedName);
    }
    if (requestedName && team.getMember(requestedName)) {
      return {
        output: `Error: teammate '${requestedName}' already exists in team '${teamName}'.`,
        isError: true,
      };
    }

    let memberName =
      requestedName ||
      sanitizeNameSegment(description.replace(/\s+/g, "-").toLowerCase()).slice(
        0,
        30,
      );
    let suffix = 2;
    const base = memberName;
    while (memberName === LEADER_NAME || team.getMember(memberName)) {
      memberName = `${base}-${String(suffix++)}`;
    }
    team.addMember(memberName);

    // Build a teammate-scoped tool registry: clone the parent registry, then
    // inject team-level task tools and a named SendMessage (overriding the
    // inherited leader-named version so the teammate sends under its own name).
    const teammateRegistry = filterToolsForAgent(
      cloneRegistryForTeammate(this.registry),
      definition.tools,
      definition.disallowedTools,
      false,
    );
    teammateRegistry.register(
      new SendMessageTool(this.teamManager, memberName),
    );
    teammateRegistry.unregister("TodoWrite");
    teammateRegistry.register(
      new TeamTaskCreateTool(this.teamManager, teamName, memberName),
    );
    teammateRegistry.register(new TeamTaskGetTool(this.teamManager, teamName));
    teammateRegistry.register(new TeamTaskListTool(this.teamManager, teamName));
    teammateRegistry.register(
      new TeamTaskUpdateTool(this.teamManager, teamName, memberName),
    );
    // Worktree isolation: the teammate works on its own branch; changes are NOT
    // merged automatically — the worktree path is recorded in member metadata
    // (setMemberMeta below) for the Leader/user to merge manually.
    let teammatePrompt = prompt;
    let memberCwd = ctx.cwd;
    if (worktreeIsolation) {
      try {
        const wt = await createAgentWorktree(
          newAgentSlug(),
          undefined,
          ctx.cwd,
        );
        memberCwd = wt.path;
        teammatePrompt = `${buildWorktreeNotice(this.cwd, wt.path)}

${prompt}`;
      } catch (e) {
        team.removeMember(memberName);
        await teammateRegistry.dispose();
        return {
          output: `Error creating teammate worktree: ${asErrorString(e)}`,
          isError: true,
        };
      }
    }

    const parentChecker =
      ctx.permissionChecker ?? new PermissionChecker(this.cwd);
    this.teamManager.setPermissionChecker(parentChecker);
    const checker = parentChecker.forSubagent(
      memberCwd,
      planModeRequired ? "plan" : definition.permissionMode,
    );
    checker.teammate = true;
    try {
      const runAgent = this.teamRunAgentFactory?.(
        teammateRegistry,
        checker,
        memberCwd,
        {
          agentName: memberName,
          definition,
          modelOverride,
          onPermissionRequest: ctx.onPermissionRequest,
        },
      );

      if (runAgent) {
        team.spawnTeammate(
          memberName,
          teammatePrompt,
          runAgent,
          checker,
          ctx.toolCallId,
          memberCwd,
          {
            agentType: definition.name,
            model: modelOverride || definition.model,
            planApprovalRequired: planModeRequired,
            cleanup: () => teammateRegistry.dispose(),
          },
        );
        return {
          output: `Teammate '${memberName}' spawned in team '${teamName}' (in-process)${checker.mode === "plan" ? ", starting in plan mode" : ""}`,
          isError: false,
        };
      }

      team.removeMember(memberName);
      await teammateRegistry.dispose();
      return {
        output: "Error: teammate runner is unavailable.",
        isError: true,
      };
    } catch (error) {
      if (team.getMember(memberName)?.active) {
        await team.stopMember(memberName);
      }
      team.removeMember(memberName);
      await teammateRegistry.dispose();
      return {
        output: `Error spawning teammate: ${asErrorString(error)}${memberCwd !== this.cwd ? `\nWorktree retained at: ${memberCwd}` : ""}`,
        isError: true,
      };
    }
  }

  /**
   * Fork mode: Inherits a snapshot of parent conversation context.
   * Unlike definition mode, the forked subagent can see the full history of the parent conversation,
   * achieving byte alignment for the prompt-cache prefix to improve cache hit rate.
   */
  private async runFork(
    prompt: string,
    description: string,
    modelOverride: string | undefined,
    ctx: ToolContext,
    isolate: boolean,
    conversationSnapshot?: ConversationManager,
    isAsync = false,
  ): Promise<ToolResult> {
    if (!this.conversation || !this.forkHandler) {
      return {
        output: "Error: fork requires parent conversation context",
        isError: true,
      };
    }

    // Nested fork detection — dual-layer protection:
    // (1) Primary check: querySource flag (detectable even if the conversation is compressed)
    // (2) Fallback: scan conversation history for fork markers
    if (this.querySource === FORK_QUERY_SOURCE) {
      return {
        output:
          "Error: cannot fork from a forked agent. Use subagent_type to spawn a definition-based agent instead.",
        isError: true,
      };
    }
    for (const msg of this.conversation.getMessages()) {
      if (
        typeof msg.content === "string" &&
        msg.content.includes(FORK_BOILERPLATE_TAG)
      ) {
        return {
          output:
            "Error: cannot fork from a forked agent. Use subagent_type to spawn a definition-based agent instead.",
          isError: true,
        };
      }
    }

    let worktreePath: string | undefined;
    let forkedRegistry: ToolRegistry | undefined;
    try {
      if (isolate) {
        ctx.abortSignal?.throwIfAborted();
        const worktree = await createAgentWorktree(
          newAgentSlug(),
          undefined,
          ctx.cwd,
        );
        worktreePath = worktree.path;
        prompt = `${buildWorktreeNotice(ctx.cwd, worktree.path)}\n\n${prompt}`;
        ctx = {
          ...ctx,
          cwd: worktree.path,
          permissionChecker: ctx.permissionChecker?.forCwd(worktree.path),
        };
      }
      const { cloneRegistryForFork } = await import("./tool-filter.js");
      const clonedRegistry = cloneRegistryForFork(this.registry);
      forkedRegistry = isAsync
        ? filterToolsForAgent(clonedRegistry, undefined, undefined, true)
        : clonedRegistry;
      const snapshot = conversationSnapshot ?? this.conversation.fork();
      const output = await this.forkHandler(
        `${FORK_BOILERPLATE}\n\nYour task:\n${prompt}`,
        snapshot,
        forkedRegistry,
        modelOverride,
        ctx,
      );
      return {
        output: `Forked agent "${description}":\n${output}${worktreePath ? `\nWorktree retained at: ${worktreePath}` : ""}`,
        isError: false,
      };
    } catch (err) {
      log.error({ err }, "subagent operation failed");
      return {
        output: `Fork error: ${asErrorString(err)}${worktreePath ? `\nWorktree retained at: ${worktreePath}` : ""}`,
        isError: true,
      };
    } finally {
      await forkedRegistry?.dispose();
    }
  }
}
