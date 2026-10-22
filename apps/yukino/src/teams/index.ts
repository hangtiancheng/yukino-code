import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { createChildLogger } from "@/logger/index.js";
import type { PermissionChecker } from "@/permissions/index.js";
import { createPlanPath } from "@/plan-file/index.js";
import { buildTeammatePrompt } from "@/prompt/prompts.js";
import {
  mkdirPrivateSync as mkdirSync,
  readPrivateFileSync as readFileSync,
} from "@/storage/private.js";
import type { SubagentProgressEvent } from "@/subagent/spawn.js";
import {
  EMPTY_TEAMMATE_PLAN_MESSAGE,
  IDLE_POLL_INTERVAL_MS,
  LEADER_NAME,
  MAX_RETAINED_TERMINATED_MEMBERS,
  MSG_PLAN_APPROVAL_RESPONSE,
  MSG_TEXT,
} from "@/teams/constants.js";
import { FileMailbox, type FileMailMessage } from "@/teams/file-mailbox.js";
import type { TeammateUIState } from "@/teams/progress.js";
import {
  clearActiveTools,
  createProgress,
  recordTokens,
  recordToolResult,
  recordToolStart,
  recordTurnComplete,
} from "@/teams/progress.js";
import {
  buildNewMessagesPrompt,
  buildPlanApprovedMessage,
  buildPlanRejectedMessage,
  buildPlanReviewResumePrompt,
  buildTasksReleasedMessage,
  PLAN_AUTO_APPROVED_MESSAGE,
} from "@/teams/prompts.js";
import {
  isValidTeammateName,
  isShutdownRequest,
  planApprovalRequest,
  planApprovalResponse,
  shutdownRequest,
  shutdownResponse,
} from "@/teams/protocol.js";
import { getNameRegistry } from "@/teams/registry.js";
import { SharedTaskStore } from "@/teams/shared-task.js";
import {
  listTeamNames,
  readTeamFile,
  sanitizeTeamName,
  teamDir,
  writeTeamFile,
  type TeamFile,
  type TeamMemberEntry,
} from "@/teams/team-file.js";
import { TASKS_FILENAME } from "@/todo/constants.js";
import { asErrorString } from "@/utils/index.js";
import { canonicalPath } from "@/utils/paths.js";
import { escapeXml } from "@/utils/xml.js";

// Submodule namespaces for library consumers (Teams.<Sub>.*).
export * as Constants from "@/teams/constants.js";
export * as Coordinator from "@/teams/coordinator.js";
export * as FileLock from "@/teams/file-lock.js";
export * as FileMailbox from "@/teams/file-mailbox.js";
export * as Progress from "@/teams/progress.js";
export * as Prompts from "@/teams/prompts.js";
export * as Protocol from "@/teams/protocol.js";
export * as Registry from "@/teams/registry.js";
export * as SharedTask from "@/teams/shared-task.js";
export * as TaskStop from "@/teams/task-stop.js";
export * as TaskTools from "@/teams/task-tools.js";
export * as TeamFile from "@/teams/team-file.js";
export * as Tools from "@/teams/tools.js";

const log = createChildLogger({ module: "teams" });

// Callback that receives agent events during execution. The team layer uses
// this to update TeammateUIState while staying decoupled from the agent
// runtime (the event type is a type-only import from the subagent layer).
export type AgentEventCallback = (event: SubagentProgressEvent) => void;

export interface Member {
  name: string;
  active: boolean;
  cancel?: () => void;
  /** Resolves when the in-process teammate's current loop has fully stopped. */
  done?: Promise<void>;
  signal?: AbortSignal;
  stopping?: Promise<void>;
  mailbox: FileMailbox;
  uiState?: TeammateUIState;
  checker?: PermissionChecker;
  planApprovalRequired?: boolean;
  pendingPlanApproval?: { request: FileMailMessage; responded: boolean };

  // The following fields are metadata for persistence; they do not participate in
  // runtime scheduling and are only used when writing config.json or restoring
  // the team from disk.
  agentId?: string;
  agentType?: string;
  model?: string;
  worktreePath?: string;
  joinedAt?: number;
}

// Runs a teammate's task and returns its final output. Injected so the team
// layer stays decoupled from the LLM/agent layer (and is unit-testable).
// The optional onEvent callback lets the team layer observe agent events
// (tool_use, tool_result, usage, turn_complete).
export type RunAgent = (
  task: string,
  onEvent?: AgentEventCallback,
  abortSignal?: AbortSignal,
) => Promise<string>;

export class Team {
  name: string;
  members = new Map<string, Member>();
  leaderMailbox: FileMailbox;
  private mailboxDir: string;
  private cwd: string;

  leaderAgentId = "";
  permissionMode: PermissionChecker["mode"] = "default";
  description?: string;
  createdAt = Math.floor(Date.now() / 1000);
  constructor(
    name: string,
    cwd: string,
    readonly requiresLeaderPlanApproval = false,
  ) {
    this.name = name;
    this.cwd = cwd;
    // Mailboxes live in a dedicated inboxes/ subdirectory, separate from
    // config.json and tasks.json at the team root, keeping the layout clean
    // as membership grows.
    this.mailboxDir = join(teamDir(cwd, name), "inboxes");
    mkdirSync(this.mailboxDir, { recursive: true });
    this.leaderMailbox = new FileMailbox(this.mailboxDir, LEADER_NAME);
  }

  private createMember(name: string): Member {
    return {
      name,
      active: false,
      mailbox: new FileMailbox(this.mailboxDir, name),
      agentId: name,
      joinedAt: Math.floor(Date.now() / 1000),
    };
  }

  addMember(name: string): Member {
    if (!isValidTeammateName(name)) {
      throw new Error(`Invalid teammate name '${name}'`);
    }
    if (this.members.has(name)) {
      throw new Error(`Teammate '${name}' already exists`);
    }
    const member = this.createMember(name);
    this.members.set(name, member);
    this.persist();
    return member;
  }

  removeMember(name: string): void {
    if (this.members.get(name)?.active) {
      throw new Error(`Stop teammate '${name}' before removing it`);
    }
    if (this.members.delete(name)) {
      getNameRegistry().unregister(name);
      writeTeamFile(this.cwd, this.name, this.snapshot(), [name]);
    }
  }

  /** Reconstructs a persisted member without writing a partial team snapshot. */
  hydrateMember(entry: TeamMemberEntry): Member {
    const member = this.createMember(entry.name);
    member.agentId = entry.agentId;
    member.agentType = entry.agentType;
    member.model = entry.model;
    member.worktreePath = entry.worktreePath;
    member.joinedAt = entry.joinedAt;
    member.active = false;

    this.members.set(member.name, member);
    return member;
  }

  /**
   * Backfills member metadata (agent type, model, worktree path) and persists.
   * The spawn flow obtains this information later than addMember, hence the two-step write.
   */
  setMemberMeta(
    name: string,
    meta: { agentType?: string; model?: string; worktreePath?: string },
  ): void {
    const member = this.members.get(name);
    if (!member) {
      return;
    }
    member.agentType = meta.agentType;
    member.model = meta.model;
    member.worktreePath = meta.worktreePath;
    this.persist();
  }

  snapshot(): TeamFile {
    return {
      name: this.name,
      description: this.description,
      createdAt: this.createdAt,
      leaderAgentId: this.leaderAgentId,
      permissionMode: this.permissionMode,
      members: [...this.members.values()].map((m) => ({
        agentId: m.agentId ?? m.name,
        name: m.name,
        agentType: m.agentType,
        model: m.model,
        joinedAt: m.joinedAt ?? 0,
        worktreePath: m.worktreePath,
        isActive: m.active,
      })),
    };
  }

  /**
   * Writes the current state back to disk. A write failure does not affect the
   * in-memory team's operation — persistence serves cross-process and cross-restart
   * continuity, not runtime correctness.
   */
  persist(): void {
    writeTeamFile(this.cwd, this.name, this.snapshot());
  }

  spawnTeammate(
    name: string,
    task: string,
    runAgent: RunAgent,
    checker?: PermissionChecker,
    originToolCallId?: string,
    memberCwd = this.cwd,
    role: {
      agentType?: string;
      model?: string;
      planApprovalRequired?: boolean;
      cleanup?: () => Promise<void>;
    } = {},
  ): void {
    const member = this.getMember(name) ?? this.addMember(name);
    if (member.active) {
      throw new Error(`Teammate '${name}' is already running`);
    }
    this.setMemberMeta(name, role);
    member.planApprovalRequired =
      !checker?.readOnly && (role.planApprovalRequired ?? false);
    member.pendingPlanApproval = undefined;
    if (checker?.teammate) {
      checker.requiresLeaderPlanApproval = this.requiresLeaderPlanApproval;
    }
    if (checker?.mode === "plan" && !checker.planFilePath) {
      checker.planFilePath = createPlanPath();
    }
    member.active = true;
    member.worktreePath = memberCwd === this.cwd ? undefined : memberCwd;
    this.persist();
    member.checker = checker;
    const abortController = new AbortController();
    member.stopping = undefined;
    member.signal = abortController.signal;
    member.cancel = () => {
      abortController.abort();
    };

    // Register the member name in the global name registry so SendMessage can resolve and deliver by name
    getNameRegistry().register(name, name);

    const uiState: TeammateUIState = {
      name,
      teamName: this.name,
      status: "running",
      progress: createProgress(),
      ...(originToolCallId ? { originToolCallId } : {}),
      startTime: Date.now(),
      spinnerVerb: "Working",
    };
    member.uiState = uiState;

    const onEvent: AgentEventCallback = (event) => {
      switch (event.type) {
        case "tool_use":
          recordToolStart(
            uiState.progress,
            event.toolId,
            event.toolName,
            event.args,
          );
          break;
        case "tool_result":
          recordToolResult(uiState.progress, event.toolId);
          break;
        case "usage":
          recordTokens(
            uiState.progress,
            event.usage.inputTokens,
            event.usage.outputTokens,
          );
          break;
        case "turn_complete":
          recordTurnComplete(uiState.progress);
          break;
      }
    };

    // Main loop: execute task → idle notification → poll mailbox → resume execution upon receiving new message
    const done = (async () => {
      let nextPrompt = task;
      let terminalMessage: string | undefined;
      try {
        while (member.active) {
          uiState.status = "running";
          const result = await runAgent(
            buildTeammatePrompt(this.name, name, nextPrompt),
            onEvent,
            abortController.signal,
          );
          clearActiveTools(uiState.progress);
          uiState.lastMessage =
            result.length > 200 ? result.slice(0, 200) + "..." : result;
          if (abortController.signal.aborted || !member.active) {
            uiState.status = "stopped";
            terminalMessage = `[idle] ${name} (reason: stopped)`;
            break;
          }
          if (
            member.checker?.mode === "plan" &&
            !member.checker.readOnly &&
            (member.planApprovalRequired || member.pendingPlanApproval)
          ) {
            uiState.status = "idle";
            const next = await this.runPlanApproval(
              member,
              this.readPlan(member, result),
            );
            if (next === null) {
              break;
            }
            nextPrompt = next;
            continue;
          }

          uiState.status = "idle";
          await this.leaderMailbox.send(
            name,
            `[idle] ${name} (reason: available)`,
          );

          const pollResult = await this.waitForNextPromptOrShutdown(member);
          if (pollResult.shutdown || !member.active) {
            // When the shutdown request is typed, send the Leader an explicit
            // acknowledgment before exiting so it knows the teammate has
            // stopped. The teammate always approves here: it is already in the
            // idle poll loop with no work in progress.
            const req = pollResult.shutdown;
            if (req) {
              const resp = shutdownResponse(
                member.name,
                req.requestId ?? "",
                true,
                "acknowledged, shutting down",
              );
              await this.leaderMailbox.send(member.name, resp.text, resp);
            }
            break;
          }
          nextPrompt = pollResult.prompt;
        }

        if (uiState.status !== "stopped") {
          uiState.status = "completed";
        }
      } catch (err) {
        if (abortController.signal.aborted || !member.active) {
          uiState.status = "stopped";
          uiState.lastMessage = "Stopped";
          terminalMessage = `[idle] ${name} (reason: stopped)`;
        } else {
          log.error({ err }, "teams operation failed");
          uiState.status = "failed";
          uiState.lastMessage = asErrorString(err);
          terminalMessage = `[idle] ${name} (reason: failed): ${asErrorString(err)}`;
        }
      } finally {
        member.active = false;
        member.pendingPlanApproval = undefined;
        getNameRegistry().unregister(name);
        clearActiveTools(uiState.progress);
        if (uiState.status === "running") {
          uiState.status = "idle";
        }
        try {
          await role.cleanup?.();
        } catch (error) {
          log.error({ error, name }, "teammate resource cleanup failed");
        } finally {
          try {
            this.releaseMemberTasks(member);
            this.leaderMailbox.sendSync(
              name,
              terminalMessage ?? `[idle] ${name} (reason: stopped)`,
            );
          } finally {
            member.checker = undefined;
            member.cancel = undefined;
            member.signal = undefined;
            member.done = undefined;
            uiState.progress.lastActivity = undefined;
            uiState.progress.recentActivities = [];
            this.persist();
            this.pruneTerminatedMembers();
          }
        }
      }
    })().catch((error: unknown) => {
      log.error(
        { error, name },
        "teammate loop failed while reporting termination",
      );
    });
    member.done = done;
  }

  /**
   * Polls the teammate's mailbox until a new message arrives.
   * Returns the concatenated prompt, or the shutdown message itself in the
   * shutdown field. If the member is deactivated while waiting, a synthetic
   * shutdown message from the leader is returned instead.
   */
  private async waitForNextPromptOrShutdown(
    member: Member,
  ): Promise<{ prompt: string; shutdown?: FileMailMessage }> {
    while (member.active) {
      await this.waitForMember(member);
      if (!member.active || member.signal?.aborted) {
        break;
      }
      const msgs = member.mailbox.receiveSync();
      if (msgs.length === 0) {
        continue;
      }

      // Return the shutdown message itself (not a boolean) so the caller can use its requestId to send a response
      const shutdown = msgs.find((m) => isShutdownRequest(m));
      if (shutdown) {
        member.mailbox.requeue(msgs.filter((message) => message !== shutdown));
        return { prompt: "", shutdown };
      }

      return { prompt: buildNewMessagesPrompt(msgs) };
    }
    return {
      prompt: "",
      shutdown: shutdownRequest(LEADER_NAME, "member deactivated"),
    };
  }

  /** Reads the submitted plan, falling back to the final response. */
  private readPlan(member: Member, result: string): string {
    try {
      const text = readFileSync(member.checker?.planFilePath ?? "", "utf-8");
      if (text.trim()) {
        return text;
      }
    } catch {
      // Falls through to the fallback message below
    }
    return result || EMPTY_TEAMMATE_PLAN_MESSAGE;
  }

  private async runPlanApproval(
    member: Member,
    plan: string,
  ): Promise<string | null> {
    if (!member.pendingPlanApproval) {
      this.submitPlan(member.name, plan);
    }
    const requestId = member.pendingPlanApproval?.request.requestId;
    if (
      !requestId ||
      !member.active ||
      member.signal?.aborted ||
      !member.checker
    ) {
      return null;
    }
    if (!this.requiresLeaderPlanApproval) {
      const response = planApprovalResponse(
        LEADER_NAME,
        requestId,
        true,
        "Plan automatically approved; tool permissions remain active.",
      );
      await this.leaderMailbox.send(LEADER_NAME, response.text, response);
      if (!member.active || member.signal?.aborted) {
        return null;
      }
      member.pendingPlanApproval = undefined;
      member.checker.exitPlanMode(
        this.permissionMode === "plan" ? "default" : this.permissionMode,
      );
      member.planApprovalRequired = false;
      return this.resumeAfterPlanReview(member, PLAN_AUTO_APPROVED_MESSAGE);
    }

    while (member.active && !member.signal?.aborted) {
      await this.waitForMember(member);
      if (!member.active || member.signal?.aborted) {
        return null;
      }
      const messages = member.mailbox.receiveMatchingSync(
        (message) =>
          isShutdownRequest(message) ||
          message.type === MSG_PLAN_APPROVAL_RESPONSE,
      );
      const shutdown = messages.find(
        (message) => message.from === LEADER_NAME && isShutdownRequest(message),
      );
      if (shutdown) {
        const response = shutdownResponse(
          member.name,
          shutdown.requestId ?? "",
          true,
          "Stopped while awaiting plan review",
        );
        await this.leaderMailbox.send(member.name, response.text, response);
        return null;
      }
      const response = messages.find(
        (message) =>
          message.from === LEADER_NAME &&
          message.requestId === requestId &&
          typeof message.approve === "boolean" &&
          !!message.text.trim(),
      );
      if (!response) {
        continue;
      }
      member.pendingPlanApproval = undefined;
      if (!response.approve) {
        return this.resumeAfterPlanReview(
          member,
          buildPlanRejectedMessage(response.text),
        );
      }
      member.checker.exitPlanMode(
        this.permissionMode === "plan" ? "default" : this.permissionMode,
      );
      member.planApprovalRequired = false;
      return this.resumeAfterPlanReview(
        member,
        buildPlanApprovedMessage(response.text),
      );
    }
    return null;
  }

  private resumeAfterPlanReview(member: Member, review: string): string {
    const messages = member.mailbox.receiveMatchingSync(
      (message) =>
        (!message.type || message.type === MSG_TEXT) &&
        !isShutdownRequest(message),
    );
    return buildPlanReviewResumePrompt(review, messages);
  }

  submitPlan(name: string, plan: string): string {
    const member = this.getMember(name);
    if (
      !member?.active ||
      member.signal?.aborted ||
      member.checker?.readOnly ||
      member.checker?.mode !== "plan"
    ) {
      throw new Error(
        "Only an active teammate in plan mode can submit a plan.",
      );
    }
    if (!plan.trim()) {
      throw new Error("A non-empty plan is required for review.");
    }
    if (member.pendingPlanApproval) {
      throw new Error("This teammate already has a plan awaiting review.");
    }
    const request = planApprovalRequest(name, plan);
    this.leaderMailbox.sendSync(name, request.text, request);
    member.pendingPlanApproval = { request, responded: false };
    if (this.requiresLeaderPlanApproval) {
      member.planApprovalRequired = true;
    }
    return request.requestId ?? "";
  }

  respondToPlan(
    name: string,
    requestId: string,
    approve: boolean,
    feedback: string,
  ): void {
    if (!this.requiresLeaderPlanApproval) {
      throw new Error(
        "Teammate plans are automatically approved outside coordinator mode.",
      );
    }
    const member = this.getMember(name);
    const pending = member?.pendingPlanApproval;
    if (
      !member?.active ||
      member.signal?.aborted ||
      pending?.request.requestId !== requestId
    ) {
      throw new Error(
        "No matching pending plan approval request for this teammate.",
      );
    }
    if (pending.responded) {
      throw new Error(
        "This plan approval request already has a leader response.",
      );
    }
    if (!feedback.trim()) {
      throw new Error(
        "Plan approval responses require the leader's review feedback.",
      );
    }
    const response = planApprovalResponse(
      LEADER_NAME,
      requestId,
      approve,
      feedback,
    );
    member.mailbox.sendSync(LEADER_NAME, response.text, response);
    pending.responded = true;
  }

  getMember(name: string): Member | undefined {
    return this.members.get(name);
  }

  private waitForMember(member: Member): Promise<void> {
    if (member.signal?.aborted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        member.signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, IDLE_POLL_INTERVAL_MS);
      member.signal?.addEventListener("abort", finish, { once: true });
    });
  }

  releaseMemberTasks(member: Member): void {
    try {
      const store = new SharedTaskStore(
        join(teamDir(this.cwd, this.name), TASKS_FILENAME),
      );
      const tasks = store.releaseOwner(member.name);
      if (tasks.length) {
        this.leaderMailbox.sendSync(
          member.name,
          buildTasksReleasedMessage(member.name, tasks),
        );
      }
    } catch (error) {
      log.error(
        { error, member: member.name },
        "failed to release teammate tasks",
      );
    }
  }

  async sendMessage(from: string, to: string, content: string): Promise<void> {
    const member = this.members.get(to);
    if (!member) {
      throw new Error(`Member '${to}' not found in team '${this.name}'`);
    }
    if (!member.active && member.uiState) {
      throw new Error(
        `Teammate '${to}' is ${member.uiState.status} and cannot receive work`,
      );
    }
    if (member.active && member.uiState && !member.pendingPlanApproval) {
      member.uiState.status = "running";
    }
    await member.mailbox.send(from, content);
  }

  async stopMember(name: string): Promise<void> {
    const member = this.members.get(name);
    if (member) {
      await this.stopOne(member);
      this.persist();
    }
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.members.values()].map((member) => this.stopOne(member)),
    );
    this.persist();
  }

  private stopOne(member: Member): Promise<void> {
    member.stopping ??= this.stopMemberRuntime(member);
    return member.stopping;
  }

  private async stopMemberRuntime(member: Member): Promise<void> {
    member.active = false;
    if (
      member.uiState?.status === "running" ||
      member.uiState?.status === "idle"
    ) {
      member.uiState.status = "stopped";
    }
    // Unregister now, not just on delete: a stopped member's mailbox is never
    // read again, so leaving the name resolvable makes sends vanish silently.
    getNameRegistry().unregister(member.name);
    try {
      member.cancel?.();
    } catch (error) {
      log.error({ error, member: member.name }, "teammate cancellation failed");
    }
    await member.done;
    this.releaseMemberTasks(member);
    member.cancel = undefined;
    member.checker = undefined;
    member.signal = undefined;
    member.done = undefined;
    this.pruneTerminatedMembers();
  }

  listMembers(): Member[] {
    return [...this.members.values()];
  }

  getTeammateStates(): TeammateUIState[] {
    return this.listMembers().flatMap((member) =>
      member.uiState ? [member.uiState] : [],
    );
  }

  pruneTerminatedMembers(): void {
    const terminal = this.listMembers().filter(
      (member) =>
        !member.active &&
        !member.done &&
        !member.cancel &&
        member.uiState &&
        ["completed", "failed", "stopped"].includes(member.uiState.status),
    );
    const removed = terminal.slice(
      0,
      Math.max(0, terminal.length - MAX_RETAINED_TERMINATED_MEMBERS),
    );
    if (!removed.length) {
      return;
    }
    for (const member of removed) {
      this.members.delete(member.name);
    }
    writeTeamFile(
      this.cwd,
      this.name,
      this.snapshot(),
      removed.map((member) => member.name),
    );
  }
}

export class TeamManager {
  /** Teams keyed by their canonical disk slug; Team.name remains the display name. */
  private teams = new Map<string, Team>();
  private cwd: string;
  private permissionChecker?: PermissionChecker;
  private unsubscribePermissions?: () => void;
  // One shared task store per canonical team identity.
  private taskStores = new Map<string, SharedTaskStore>();
  private listeners = new Set<() => void>();

  constructor(
    cwd: string,
    readonly coordinatorMode = false,
  ) {
    this.cwd = canonicalPath(cwd);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        log.error({ error }, "team subscriber failed");
      }
    }
  }

  setPermissionChecker(checker: PermissionChecker): void {
    if (this.permissionChecker === checker) {
      return;
    }
    this.unsubscribePermissions?.();
    this.permissionChecker = checker;
    const sync = () => {
      for (const team of this.teams.values()) {
        team.permissionMode = checker.mode;
        team.persist();
      }
    };
    this.unsubscribePermissions = checker.subscribeMode(sync);
    sync();
  }

  private teamKey(name: string): string {
    return sanitizeTeamName(name);
  }

  private teamDir(name: string): string {
    return teamDir(this.cwd, name);
  }

  create(
    name = `team-${randomUUID()}`,
    opts: { leaderAgentId?: string; description?: string } = {},
  ): Team {
    const existing = this.get(name);
    if (existing) {
      return existing;
    }

    const key = this.teamKey(name);
    const team = new Team(name, this.cwd, this.coordinatorMode);
    team.permissionMode = this.permissionChecker?.mode ?? "default";
    team.leaderAgentId = opts.leaderAgentId ?? "";
    team.description = opts.description;
    this.teams.set(key, team);
    const store = new SharedTaskStore(join(this.teamDir(name), TASKS_FILENAME));
    store.initEmpty();
    this.taskStores.set(key, store);
    team.persist();
    this.emitChange();
    return team;
  }

  get(name: string): Team | undefined {
    const key = this.teamKey(name);
    const cached = this.teams.get(key);
    if (cached) {
      return cached;
    }

    const tf = readTeamFile(this.cwd, name);
    if (!tf) {
      return undefined;
    }

    const team = new Team(tf.name, this.cwd, this.coordinatorMode);
    team.leaderAgentId = tf.leaderAgentId;
    team.permissionMode = this.permissionChecker?.mode ?? tf.permissionMode;
    team.description = tf.description;
    team.createdAt = tf.createdAt;
    for (const member of tf.members) {
      const hydrated = team.hydrateMember(member);
      hydrated.uiState = {
        name: hydrated.name,
        teamName: team.name,
        status: member.isActive ? "failed" : "stopped",
        progress: createProgress(),
        startTime: member.joinedAt * 1000,
        spinnerVerb: "Working",
      };
      team.releaseMemberTasks(hydrated);
    }
    team.persist();
    team.pruneTerminatedMembers();
    this.teams.set(key, team);
    this.emitChange();
    return team;
  }

  restoreFromDisk(): void {
    for (const name of listTeamNames(this.cwd)) {
      this.get(name);
    }
  }

  /** Retrieves the team's shared task store, loading tasks.json after restoration. */
  getTaskStore(teamName: string): SharedTaskStore {
    const key = this.teamKey(teamName);
    const cached = this.taskStores.get(key);
    if (cached) {
      return cached;
    }
    const store = new SharedTaskStore(
      join(this.teamDir(teamName), TASKS_FILENAME),
    );
    this.taskStores.set(key, store);
    return store;
  }

  list(): Team[] {
    return [...this.teams.values()];
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(this.list().map((team) => team.stopAll()));
  }

  async dispose(): Promise<void> {
    try {
      await this.stopAll();
    } finally {
      this.unsubscribePermissions?.();
      this.unsubscribePermissions = undefined;
      this.permissionChecker = undefined;
      this.teams.clear();
      this.taskStores.clear();
      this.listeners.clear();
    }
  }

  async delete(name: string): Promise<void> {
    const key = this.teamKey(name);
    const team = this.get(name);
    if (team) {
      const registry = getNameRegistry();
      for (const member of team.listMembers()) {
        registry.unregister(member.name);
      }
      await team.stopAll();
      this.teams.delete(key);
    }
    this.taskStores.delete(key);
    // The project-scoped team directory contains config.json, tasks.json,
    // mailboxes (inboxes/), and teammate logs (logs/). Remove only this team's
    // namespace so another project with the same team slug stays untouched.
    rmSync(this.teamDir(name), { recursive: true, force: true });
    this.emitChange();
  }

  /**
   * Deletes every team in this project: in-memory teams are stopped and
   * unregistered, then residual team directories from previous sessions are
   * removed. Other project namespaces remain untouched.
   */
  async deleteAll(): Promise<void> {
    for (const team of this.list()) {
      await this.delete(team.name);
    }
    // Directory names are already sanitized; delete() re-sanitizes to the same value.
    for (const name of listTeamNames(this.cwd)) {
      await this.delete(name);
    }
  }

  getAllTeammateStates(): TeammateUIState[] {
    return this.list().flatMap((t) => t.getTeammateStates());
  }

  hasLeaderNotifications(): boolean {
    return this.list().some((team) => team.leaderMailbox.unreadCount() > 0);
  }

  /**
   * Reads all unread messages from each team's leader mailbox and returns them
   * wrapped in <task-notification> XML tags, so the model can parse team
   * notifications in a structured manner.
   */
  drainLeaderMailbox(): string[] {
    const out: string[] = [];
    for (const team of this.teams.values()) {
      const msgs = team.leaderMailbox.receiveSync();
      if (msgs.length === 0) {
        continue;
      }
      const lines: string[] = [];
      lines.push(`<task-notification team="${escapeXml(team.name)}">`);
      for (const msg of msgs) {
        const metadata = [
          `from="${escapeXml(msg.from)}"`,
          msg.type ? `type="${escapeXml(msg.type)}"` : "",
          msg.requestId ? `requestId="${escapeXml(msg.requestId)}"` : "",
          msg.approve === undefined ? "" : `approve="${String(msg.approve)}"`,
        ]
          .filter(Boolean)
          .join(" ");
        lines.push(`<message ${metadata}>${escapeXml(msg.text)}</message>`);
      }
      lines.push("</task-notification>");
      out.push(lines.join("\n"));
    }
    return out;
  }
}
