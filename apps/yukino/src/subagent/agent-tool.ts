import { randomBytes } from "node:crypto";

import z from "zod";

import type { ConversationManager } from "@/conversation/index.js";
import { sanitizeNameSegment } from "@/logger/index.js";
import { PermissionChecker } from "@/permissions/index.js";
import { newSessionId } from "@/session/index.js";
import { sessionPath } from "@/storage/index.js";
import {
  BUILTIN_AGENTS,
  GENERAL_PURPOSE_AGENT_TYPE,
  FORK_CONTEXT_REQUIRED_ERROR,
} from "@/subagent/constants.js";
import type { AgentDefinition } from "@/subagent/definition.js";
import { loadAgentDefinitions } from "@/subagent/loader.js";
import {
  AGENT_TOOL_DESCRIPTION,
  buildAgentToolDescription,
  FORK_PARAMETER_DESCRIPTION,
  SUBAGENT_TYPE_DESCRIPTION,
  INHERITED_TOOL_RESULT,
} from "@/subagent/prompts.js";
import { TaskFailure, TaskManager } from "@/subagent/task-manager.js";
import {
  cloneRegistryForTeammate,
  filterToolsForAgent,
} from "@/subagent/tool-filter.js";
import { LEADER_NAME } from "@/teams/constants.js";
import type { TeamManager, RunAgent } from "@/teams/index.js";
import { isValidTeammateName } from "@/teams/protocol.js";
import {
  TeamTaskCreateTool,
  TeamTaskGetTool,
  TeamTaskListTool,
  TeamTaskUpdateTool,
} from "@/teams/task-tools.js";
import { SendMessageTool } from "@/teams/tools.js";
import { ExitPlanModeTool } from "@/tools/exit-plan-mode.js";
import type { ToolRegistry } from "@/tools/registry.js";
import type {
  Tool,
  ToolResult,
  ToolContext,
  ToolSchema,
} from "@/tools/types.js";
import { asErrorString, boolArg, strArg } from "@/utils/index.js";
import { createAgentWorktree } from "@/worktree/index.js";
import { buildWorktreeNotice } from "@/worktree/prompts.js";

/** Worktree directory name. Uses a random string instead of the task description — spaces and non-ASCII characters in descriptions cannot be used directly as branch names. */
function newAgentSlug(): string {
  return `agent-a${randomBytes(4).toString("hex").slice(0, 7)}`;
}

export interface TeammateRunOptions {
  agentName: string;
  definition: AgentDefinition;
  modelOverride?: string;
  onPermissionRequest?: ToolContext["onPermissionRequest"];
  contextSnapshot?: ConversationManager;
}

interface AgentRunOptions {
  description: string;
  fork: boolean;
  background: boolean;
  modelOverride?: string;
  isolate?: boolean;
}

export class AgentTool implements Tool {
  name = "Agent";
  description = AGENT_TOOL_DESCRIPTION;
  category = "command" as const;

  isConcurrencySafe(): boolean {
    return true;
  }

  private definitions: AgentDefinition[];
  private registry: ToolRegistry;
  private conversation?: ConversationManager;
  private taskManager: TaskManager;

  /** Optional: Team manager, enables the team_name parameter. */
  private teamManager?: TeamManager;
  private cwd: string;
  defaultFork = true;
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
    contextSnapshot?: ConversationManager,
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
      contextSnapshot?: ConversationManager,
    ) => Promise<string>,
    conversation?: ConversationManager,
    taskManager = new TaskManager(),
  ) {
    this.definitions = loadAgentDefinitions();
    this.cwd = cwd;
    this.registry = registry;
    this.spawnHandler = spawnHandler;
    this.conversation = conversation;
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

  private forkConversation(): ConversationManager {
    if (!this.conversation) {
      throw new Error(FORK_CONTEXT_REQUIRED_ERROR);
    }
    const snapshot = this.conversation.fork();
    const pending = new Set<string>();
    for (const message of snapshot.getMessages()) {
      for (const tool of message.toolUses ?? []) {
        pending.add(tool.toolUseId);
      }
      for (const result of message.toolResults ?? []) {
        pending.delete(result.toolUseId);
      }
    }
    if (pending.size > 0) {
      snapshot.addToolResultsMessage(
        [...pending].map((toolUseId) => ({
          toolUseId,
          content: INHERITED_TOOL_RESULT,
          isError: false,
        })),
      );
    }
    return snapshot;
  }

  runBuiltin(
    name: string,
    ctx: ToolContext,
    prompt: string,
  ): Promise<ToolResult> {
    const definition = BUILTIN_AGENTS.find((agent) => agent.name === name);
    if (!definition) {
      return Promise.resolve({
        output: `Unknown built-in agent: ${name}`,
        isError: true,
      });
    }
    return this.runDefinition(ctx, definition, prompt, {
      description: name,
      fork: true,
      background: false,
    });
  }

  schema(): ToolSchema {
    const agentTypes = this.definitions.map((d) => d.name);
    return {
      name: this.name,
      description: buildAgentToolDescription(
        this.definitions,
        this.defaultFork,
      ),
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
            description: SUBAGENT_TYPE_DESCRIPTION,
            default: GENERAL_PURPOSE_AGENT_TYPE,
          },
          fork: {
            type: "boolean",
            description: FORK_PARAMETER_DESCRIPTION,
            default: this.defaultFork,
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
              "Only meaningful together with team_name. Requests a planning phase. " +
              (this.teamManager?.coordinatorMode
                ? "The teammate stays read-only until the leader reviews its submitted plan and responds with approval or revision feedback."
                : "Subject to parent acceptEdits/bypassPermissions overrides. The runtime automatically approves the submitted plan and resumes execution under current tool permissions."),
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

    const subagentType =
      strArg(args, "subagent_type") || GENERAL_PURPOSE_AGENT_TYPE;
    const forkArg = z.boolean().optional().safeParse(args.fork);
    if (!forkArg.success) {
      return { output: "Error: fork must be a boolean", isError: true };
    }
    const fork = forkArg.data ?? this.defaultFork;
    const definition = this.definitions.find(
      (entry) => entry.name === subagentType,
    );
    if (!definition) {
      return {
        output: `Error: unknown agent type '${subagentType}'. Available: ${this.definitions.map((entry) => entry.name).join(", ")}`,
        isError: true,
      };
    }
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
    ctx = { ...ctx, subagentSessionId: newSessionId() };
    const teamName = strArg(args, "team_name");
    const teammateName = strArg(args, "name");
    const isolation = strArg(args, "isolation");

    // Team-member path: team_name runs the selected role as a
    // persistent teammate and notifies the leader via SendMessage / mailbox upon completion.
    if (teamName && this.teamManager && this.teamRunAgentFactory) {
      let contextSnapshot: ConversationManager | undefined;
      try {
        contextSnapshot = fork ? this.forkConversation() : undefined;
      } catch (error) {
        return { output: asErrorString(error), isError: true };
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
        contextSnapshot,
      );
    }
    if (teamName) {
      return {
        output:
          "Error: teammate execution is unavailable; no team was created.",
        isError: true,
      };
    }

    return this.runDefinition(ctx, definition, prompt, {
      description,
      fork,
      background: backgroundArg.data ?? definition.background ?? false,
      modelOverride,
      isolate: isolation === "worktree",
    });
  }

  private async runDefinition(
    ctx: ToolContext,
    definition: AgentDefinition,
    prompt: string,
    options: AgentRunOptions,
  ): Promise<ToolResult> {
    ctx = {
      ...ctx,
      subagentSessionId: ctx.subagentSessionId ?? newSessionId(),
    };
    let contextSnapshot: ConversationManager | undefined;
    try {
      ctx.abortSignal?.throwIfAborted();
      contextSnapshot = options.fork ? this.forkConversation() : undefined;
    } catch (error) {
      return { output: asErrorString(error), isError: true };
    }
    // Worktree isolation: provision a separate working copy for the child agent; its changes
    // land on its own branch and cannot collide with the parent or other parallel child agents.
    let effectivePrompt = prompt;
    let cwdOverride: string | undefined;
    if (options.isolate || definition.isolation === "worktree") {
      try {
        const wt = await createAgentWorktree(
          newAgentSlug(),
          undefined,
          ctx.cwd,
        );
        cwdOverride = wt.path;
        ctx = {
          ...ctx,
          permissionChecker: await (
            ctx.permissionChecker ?? new PermissionChecker(ctx.cwd)
          ).forWorktree(wt),
        };
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
          options.background,
          options.modelOverride,
          cwdOverride ??
            (runContext.cwd !== this.cwd ? runContext.cwd : undefined),
          runContext,
          contextSnapshot,
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

    return options.background
      ? this.startBackground(options.description, ctx, run)
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
    contextSnapshot?: ConversationManager,
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
    const teammatePermissionMode = planModeRequired
      ? "plan"
      : definition.permissionMode;
    const teammateRegistry = filterToolsForAgent(
      cloneRegistryForTeammate(this.registry, teammatePermissionMode),
      definition.tools,
      definition.disallowedTools,
      false,
      teammatePermissionMode,
    );
    if (teammateRegistry.get("ExitPlanMode")) {
      teammateRegistry.register(
        new ExitPlanModeTool(
          (plan) => team.submitPlan(memberName, plan),
          team.requiresLeaderPlanApproval,
        ),
      );
    }
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
    let worktreeChecker: PermissionChecker | undefined;
    if (worktreeIsolation) {
      try {
        const wt = await createAgentWorktree(
          newAgentSlug(),
          undefined,
          ctx.cwd,
        );
        memberCwd = wt.path;
        worktreeChecker = await (
          ctx.permissionChecker ?? new PermissionChecker(ctx.cwd)
        ).forWorktree(wt);
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
    const checker = (worktreeChecker ?? parentChecker).forSubagent(
      memberCwd,
      teammatePermissionMode,
    );
    checker.teammate = true;
    checker.readOnly = definition.readOnly ?? false;
    checker.requiresLeaderPlanApproval = team.requiresLeaderPlanApproval;
    try {
      const runAgent = this.teamRunAgentFactory?.(
        teammateRegistry,
        checker,
        memberCwd,
        {
          agentName: memberName,
          contextSnapshot,
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
            planApprovalRequired:
              !definition.readOnly &&
              (planModeRequired ||
                (team.requiresLeaderPlanApproval &&
                  definition.permissionMode === "plan")),
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
}
