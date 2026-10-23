import { randomBytes } from "node:crypto";

import type { ConversationManager } from "@yukino.js/conversation";
import { sanitizeNameSegment } from "@yukino.js/logger";
import { PermissionChecker } from "@yukino.js/permissions";
import { newSessionId } from "@yukino.js/session";
import { sessionPath } from "@yukino.js/storage";
import type { TeamManager, RunAgent } from "@yukino.js/teams";
import { LEADER_NAME } from "@yukino.js/teams/constants.js";
import { TeamTodoWriteTool } from "@yukino.js/teams/task-tools.js";
import { SendMessageTool } from "@yukino.js/teams/tools.js";
import { OPERATION_INTERRUPTED_ERROR } from "@yukino.js/tools/constants.js";
import { ExitPlanModeTool } from "@yukino.js/tools/exit-plan-mode.js";
import type { ToolRegistry } from "@yukino.js/tools/registry.js";
import type {
  Tool,
  ToolResult,
  ToolContext,
  ToolSchema,
} from "@yukino.js/tools/types.js";
import { asErrorString, strArg } from "@yukino.js/utils";
import { createAgentWorktree } from "@yukino.js/worktree";
import { buildWorktreeNotice } from "@yukino.js/worktree/prompts.js";
import z from "zod";

import {
  AGENT_KINDS,
  DEFAULT_AGENT_KIND,
  BUILTIN_AGENTS,
  PLAN_TEAMMATE_AGENT,
  GENERAL_PURPOSE_AGENT_TYPE,
  FORK_CONTEXT_REQUIRED_ERROR,
  AGENT_ARGS_REQUIRED_ERROR,
  AGENT_BACKGROUND_INVALID_ERROR,
  AGENT_FORK_INVALID_ERROR,
  AGENT_KIND_INVALID_ERROR,
  AGENT_WORKTREE_INVALID_ERROR,
  MAX_TEAMMATE_NAME_CHARS,
  PLAN_AGENT_NAME,
  TEAMMATE_NO_TEAM_ERROR,
  TEAMMATE_RUNNER_UNAVAILABLE_ERROR,
  TEAMMATE_UNAVAILABLE_ERROR,
  TRANSCRIPT_FILENAME,
} from "./constants.js";
import type { AgentDefinition } from "./definition.js";
import { loadAgentDefinitions } from "./loader.js";
import {
  AGENT_TOOL_DESCRIPTION,
  AGENT_BACKGROUND_DESCRIPTION,
  AGENT_KIND_DESCRIPTION,
  AGENT_MODEL_DESCRIPTION,
  AGENT_WORKTREE_DESCRIPTION,
  buildAgentToolDescription,
  DESCRIPTION_PARAMETER_DESCRIPTION,
  FORK_PARAMETER_DESCRIPTION,
  PROMPT_PARAMETER_DESCRIPTION,
  SUBAGENT_TYPE_DESCRIPTION,
  INHERITED_TOOL_RESULT,
} from "./prompts.js";
import { TaskFailure, TaskManager } from "./task-manager.js";
import {
  cloneRegistryForTeammate,
  filterToolsForAgent,
} from "./tool-filter.js";

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
  worktree?: boolean;
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
   * Sets the team manager and teammate run callback.
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
            description: DESCRIPTION_PARAMETER_DESCRIPTION,
          },
          kind: {
            type: "string",
            enum: [...AGENT_KINDS],
            description: AGENT_KIND_DESCRIPTION,
            default: DEFAULT_AGENT_KIND,
          },
          prompt: {
            type: "string",
            description: PROMPT_PARAMETER_DESCRIPTION,
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
            description: AGENT_MODEL_DESCRIPTION,
          },
          run_in_background: {
            type: "boolean",
            description: AGENT_BACKGROUND_DESCRIPTION,
            default: false,
          },
          worktree: {
            type: "boolean",
            description: AGENT_WORKTREE_DESCRIPTION,
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
      return { output: OPERATION_INTERRUPTED_ERROR, isError: true };
    }
    const description = strArg(args, "description");
    const prompt = strArg(args, "prompt");
    if (!description || !prompt) {
      return {
        output: AGENT_ARGS_REQUIRED_ERROR,
        isError: true,
      };
    }

    const kindArg = z.enum(AGENT_KINDS).optional().safeParse(args.kind);
    if (!kindArg.success) {
      return {
        output: AGENT_KIND_INVALID_ERROR,
        isError: true,
      };
    }
    const kind = kindArg.data ?? DEFAULT_AGENT_KIND;
    const worktreeArg = z.boolean().optional().safeParse(args.worktree);
    if (!worktreeArg.success) {
      return { output: AGENT_WORKTREE_INVALID_ERROR, isError: true };
    }
    const subagentType =
      strArg(args, "subagent_type") || GENERAL_PURPOSE_AGENT_TYPE;
    const forkArg = z.boolean().optional().safeParse(args.fork);
    if (!forkArg.success) {
      return { output: AGENT_FORK_INVALID_ERROR, isError: true };
    }
    const fork = forkArg.data ?? this.defaultFork;
    let definition = this.definitions.find(
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
        output: AGENT_BACKGROUND_INVALID_ERROR,
        isError: true,
      };
    }
    ctx = { ...ctx, subagentSessionId: newSessionId() };
    if (kind === "teammate") {
      if (!this.teamManager || !this.teamRunAgentFactory) {
        return {
          output: TEAMMATE_NO_TEAM_ERROR,
          isError: true,
        };
      }
      if (
        definition.name === PLAN_AGENT_NAME &&
        BUILTIN_AGENTS.includes(definition)
      ) {
        definition = PLAN_TEAMMATE_AGENT;
      }
      let contextSnapshot: ConversationManager | undefined;
      try {
        contextSnapshot = fork ? this.forkConversation() : undefined;
      } catch (error) {
        return { output: asErrorString(error), isError: true };
      }
      return await this.runAsTeammate(
        description,
        prompt,
        worktreeArg.data ?? definition.worktree ?? false,
        ctx,
        definition,
        modelOverride,
        contextSnapshot,
      );
    }

    return this.runDefinition(ctx, definition, prompt, {
      description,
      fork,
      background: backgroundArg.data ?? definition.background ?? false,
      modelOverride,
      worktree: worktreeArg.data ?? definition.worktree,
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
    if (options.worktree ?? definition.worktree) {
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
          ? sessionPath(ctx.subagentSessionId, TRANSCRIPT_FILENAME)
          : undefined,
      },
    );
    return {
      output: `Background agent '${description}' started (task_id: ${task.id}). Its result will arrive as a task notification.`,
      isError: false,
    };
  }

  private async runAsTeammate(
    description: string,
    prompt: string,
    worktreeIsolation: boolean,
    ctx: ToolContext,
    definition: AgentDefinition,
    modelOverride?: string,
    contextSnapshot?: ConversationManager,
  ): Promise<ToolResult> {
    if (!this.teamManager) {
      return {
        output: TEAMMATE_UNAVAILABLE_ERROR,
        isError: true,
      };
    }
    const team =
      this.teamManager.list()[0] ??
      this.teamManager.create(undefined, {
        leaderAgentId: LEADER_NAME,
        description,
      });
    const teamName = team.name;
    const planModeRequired = definition.name === PLAN_AGENT_NAME;

    let memberName = sanitizeNameSegment(
      description.replace(/\s+/g, "-").toLowerCase(),
    ).slice(0, MAX_TEAMMATE_NAME_CHARS);
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
    teammateRegistry.register(
      new TeamTodoWriteTool(this.teamManager, teamName, memberName),
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
        output: TEAMMATE_RUNNER_UNAVAILABLE_ERROR,
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
