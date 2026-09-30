/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  detectBackend,
  restoreTeammateCancel,
  spawnTeammate as spawnTeammateProcess,
} from "./backend.js";
import type { SpawnConfig } from "./backend.js";
import { FileMailbox, type FileMailMessage } from "./file-mailbox.js";
import type { TeammateUIState } from "./progress.js";
import {
  clearActiveTools,
  createProgress,
  recordTokens,
  recordToolResult,
  recordToolStart,
  recordTurnComplete,
} from "./progress.js";
import {
  LEADER_NAME,
  MSG_PLAN_APPROVAL_RESPONSE,
  MSG_SHUTDOWN_REQUEST,
  SHUTDOWN_PREFIX,
  approved,
  isShutdownRequest,
  planApprovalRequest,
  shutdownRequest,
  shutdownResponse,
} from "./protocol.js";
import { getNameRegistry } from "./registry.js";
import { SharedTaskStore } from "./shared-task.js";
import {
  listTeamNames,
  readTeamFile,
  sanitizeTeamName,
  teamDir,
  writeTeamFile,
  type TeamFile,
  type TeamMemberEntry,
} from "./team-file.js";

import { createChildLogger } from "@/logger/index.js";
import type { PermissionChecker } from "@/permissions/index.js";
import { getOrCreatePlanPath } from "@/plan-file/index.js";
import { buildTeammatePrompt } from "@/prompt/delegation.js";
import type { SubagentProgressEvent } from "@/subagent/spawn.js";
import { asErrorString } from "@/utils/index.js";
import { canonicalPath } from "@/utils/paths.js";

// Submodule namespaces for library consumers (Teams.<Sub>.*).
export * as Backend from "./backend.js";
export * as Coordinator from "./coordinator.js";
export * as FileLock from "./file-lock.js";
export * as FileMailbox from "./file-mailbox.js";
export * as Progress from "./progress.js";
export * as Protocol from "./protocol.js";
export * as Registry from "./registry.js";
export * as SharedTask from "./shared-task.js";
export * as TaskStop from "./task-stop.js";
export * as TaskTools from "./task-tools.js";
export * as TeamFile from "./team-file.js";
export * as Tools from "./tools.js";

const log = createChildLogger({ module: "teams" });
export type TeamMode = "in-process" | "tmux" | "iterm";

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
  mailbox: FileMailbox;
  uiState?: TeammateUIState;
  /** Stable tmux session name, persisted so cancellation survives leader restart. */
  paneId?: string;
  /** Actual backend used by this member (which can differ after fallback). */
  backendType?: TeamMode;
  /** Whether this is an external-process teammate (tmux/iTerm); stopOne writes the mailbox shutdown notice only for external members. */
  external?: boolean;

  /** Optional: permission checker for the teammate. Plan mode uses it to determine the current state; permissions are elevated in place once approval is granted. */
  checker?: PermissionChecker;

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
  mode: TeamMode;
  members = new Map<string, Member>();
  leaderMailbox: FileMailbox;
  private mailboxDir: string;
  private workDir: string;

  // Team-level metadata for persistence
  leaderAgentId = "";
  description?: string;
  createdAt = Math.floor(Date.now() / 1000);
  /**
   * PID of the leader process. Written to config.json so external teammates
   * can detect a dead leader (they exit instead of polling forever); a
   * restarted leader re-claims it when the team is restored from disk.
   */
  leaderPid = 0;

  constructor(name: string, mode: TeamMode, workDir: string) {
    this.name = name;
    this.mode = mode;
    this.workDir = workDir;
    // Mailboxes live in a dedicated inboxes/ subdirectory, separate from
    // config.json and tasks.json at the team root, keeping the layout clean
    // as membership grows.
    this.mailboxDir = join(teamDir(workDir, name), "inboxes");
    mkdirSync(this.mailboxDir, { recursive: true });
    this.leaderMailbox = new FileMailbox(this.mailboxDir, LEADER_NAME);
  }

  private createMember(name: string): Member {
    return {
      name,
      active: false,
      mailbox: new FileMailbox(this.mailboxDir, name),
      agentId: name,
      backendType: this.mode,
      joinedAt: Math.floor(Date.now() / 1000),
    };
  }

  addMember(name: string): Member {
    const member = this.createMember(name);
    this.members.set(name, member);
    this.persist();
    return member;
  }

  /** Reconstructs a persisted member without writing a partial team snapshot. */
  hydrateMember(entry: TeamMemberEntry): Member {
    const member = this.createMember(entry.name);
    member.agentId = entry.agentId;
    member.agentType = entry.agentType;
    member.model = entry.model;
    member.worktreePath = entry.worktreePath;
    member.joinedAt = entry.joinedAt;
    member.backendType = isTeamMode(entry.backendType)
      ? entry.backendType
      : this.mode;
    member.paneId = entry.paneId;
    member.external =
      member.backendType === "tmux" || member.backendType === "iterm";
    member.active = entry.isActive === true && member.external;

    if (member.active) {
      getNameRegistry().register(member.name, member.agentId);
      member.uiState = {
        name: member.name,
        teamName: this.name,
        status: "running",
        progress: createProgress(),
        startTime: entry.joinedAt > 0 ? entry.joinedAt * 1000 : Date.now(),
        spinnerVerb: "Working",
      };
      member.cancel = restoreTeammateCancel(member.backendType, member.paneId);
    }

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
      ...(this.leaderPid > 0 ? { leaderPid: this.leaderPid } : {}),
      members: [...this.members.values()].map((m) => ({
        agentId: m.agentId ?? m.name,
        name: m.name,
        agentType: m.agentType,
        model: m.model,
        joinedAt: m.joinedAt ?? 0,
        worktreePath: m.worktreePath,
        backendType: m.backendType ?? this.mode,
        paneId: m.paneId,
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
    writeTeamFile(this.workDir, this.name, this.snapshot());
  }

  // Idle polling interval (in milliseconds). Polls the mailbox for new messages after a teammate completes a turn.
  static readonly IDLE_POLL_INTERVAL_MS = 500;
  // Grace period after the shutdown notice before force-killing an external
  // teammate: one mailbox poll interval (~2 s) plus exit time.
  static readonly STOP_GRACE_MS = 2_500;
  // Shutdown prefix (single source: protocol.ts); the leader writes a
  // message with this prefix to notify teammates to exit.
  static readonly SHUTDOWN_PREFIX = SHUTDOWN_PREFIX;

  /**
   * Spawns a teammate, dispatching by team backend mode.
   *   - in-process: runs the agent main loop in a background task within this process (idle-poll-continue).
   *   - tmux / iterm: assembles the teammate startup command and delegates to the backend to launch
   *     an independent worker process in a new pane / tab, communicating bidirectionally with the
   *     leader via the shared file-based mailbox.
   * Falls back to in-process when the external backend is unavailable (tmux not installed,
   * non-iTerm environment, etc.) to avoid crashes.
   */
  spawnTeammate(
    name: string,
    task: string,
    runAgent: RunAgent,
    checker?: PermissionChecker,
    providerIndex?: number,
    originToolCallId?: string,
  ): void {
    const mode = this.mode;
    if (mode === "in-process") {
      this.spawnInProcess(name, task, runAgent, checker, originToolCallId);
      return;
    }
    try {
      this.spawnExternal(mode, name, task, providerIndex, originToolCallId);
    } catch {
      // Fall back to in-process mode when the external backend fails to launch (missing dependency / unsupported platform)
      this.spawnInProcess(name, task, runAgent, checker, originToolCallId);
    }
  }

  /**
   * tmux / iTerm backend: launches the teammate as an independent process in a new pane / tab.
   * The teammate process connects back to the team via the same mailbox directory pointed to
   * by `--team-dir`; task assignments from the leader and idle/result notifications from the
   * worker all land in this directory, keeping both sides in sync.
   */
  private spawnExternal(
    mode: Exclude<TeamMode, "in-process">,
    name: string,
    task: string,
    providerIndex?: number,
    originToolCallId?: string,
  ): void {
    const member = this.addMember(name);
    member.active = true;
    member.backendType = mode;
    // Persist the activation: the on-disk isActive otherwise stays false
    // until some later persist, and a restart would restore the member as
    // inactive even though the process is running.
    this.persist();

    // Register the name so SendMessage can deliver by name
    getNameRegistry().register(name, name);

    // Progress events for external teammates are not in this process; the UI only reflects their liveness
    member.uiState = {
      name,
      teamName: this.name,
      status: "running",
      progress: createProgress(),
      ...(originToolCallId ? { originToolCallId } : {}),
      startTime: Date.now(),
      spinnerVerb: "Working",
    };

    // Teammate entry point mirrors main.tsx: node runs this repo's entry script with --teammate flags.
    // Flag names align with parseTeammateFlags in teammate.ts. The team name is
    // passed explicitly so the shared task board resolves to the same tasks.json.
    const entry = process.argv[1] ?? "src/main.tsx";
    const config: SpawnConfig = {
      mode,
      command: "node",
      args: [
        entry,
        "--teammate",
        "--team-dir",
        this.mailboxDir,
        "--team-name",
        this.name,
        "--member-name",
        name,
        "--task",
        task,
        ...(providerIndex !== undefined
          ? ["--provider-index", String(providerIndex)]
          : []),
      ],
      cwd: this.workDir,
    };

    const { cancel, paneId } = spawnTeammateProcess(config);
    member.cancel = cancel;
    member.paneId = paneId;
    member.external = true;
    // Persist only after spawn so the stable external handle is included.
    this.persist();
  }

  /**
   * Starts an in-process teammate: runs the agent's main loop in the background,
   * sends an idle notification upon completion, and then polls the mailbox for new tasks.
   * Exits the loop upon receiving a shutdown message or being canceled.
   * Uses the idle-poll-continue pattern: after each turn completes, reports idle and waits for the next task.
   */
  private spawnInProcess(
    name: string,
    task: string,
    runAgent: RunAgent,
    checker?: PermissionChecker,
    originToolCallId?: string,
  ): void {
    const member = this.addMember(name);
    member.active = true;
    member.backendType = "in-process";
    // Persist the activation (see spawnExternal for the rationale).
    this.persist();
    member.checker = checker;
    const abortController = new AbortController();
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
      let idleReason = "available";
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
            await this.leaderMailbox.send(
              name,
              `[idle] ${name} (reason: stopped)`,
            );
            break;
          }
          // Plan-mode teammate: teammates have no ExitPlanMode tool — ending the turn is
          // the submission signal, by which time the plan should have been written to the
          // plan file. Submit it to the Leader for approval; only after approval is the
          // read-only restriction lifted and execution begins.
          if (member.checker?.mode === "plan") {
            uiState.status = "idle";
            const next = await this.runPlanApproval(
              member,
              this.readPlanForReview(),
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
            `[idle] ${name} (reason: ${idleReason})`,
          );
          idleReason = "available";

          const pollResult = await this.waitForNextPromptOrShutdown(member);
          if (pollResult.shutdown || !member.active) {
            // When the shutdown request is typed, send the Leader an explicit
            // acknowledgment before exiting so it knows the teammate has
            // stopped. The teammate always approves here: it is already in the
            // idle poll loop with no work in progress.
            const req = pollResult.shutdown;
            if (req?.type === MSG_SHUTDOWN_REQUEST) {
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
          await this.leaderMailbox.send(
            name,
            `[idle] ${name} (reason: stopped)`,
          );
        } else {
          log.error({ err }, "teams operation failed");
          uiState.status = "failed";
          uiState.lastMessage = asErrorString(err);
          await this.leaderMailbox.send(
            name,
            `[idle] ${name} (reason: failed)`,
          );
        }
      } finally {
        member.active = false;
        clearActiveTools(uiState.progress);
        if (uiState.status === "running") {
          uiState.status = "idle";
        }
        this.persist();
      }
    })();
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
      await new Promise((r) => setTimeout(r, Team.IDLE_POLL_INTERVAL_MS));
      const msgs = member.mailbox.receiveSync();
      if (msgs.length === 0) {
        continue;
      }

      // Return the shutdown message itself (not a boolean) so the caller can use its requestId to send a response
      const shutdown = msgs.find((m) => isShutdownRequest(m));
      if (shutdown) {
        return { prompt: "", shutdown };
      }

      const prompt = msgs.map((m) => `From ${m.from}: ${m.text}`).join("\n\n");
      return { prompt: `You have new messages from your team:\n\n${prompt}` };
    }
    return {
      prompt: "",
      shutdown: shutdownRequest(LEADER_NAME, "member deactivated"),
    };
  }

  /** Reads the teammate's plan file for review; returns a fallback note when empty or unreadable. */
  private readPlanForReview(): string {
    try {
      const text = readFileSync(getOrCreatePlanPath(this.workDir), "utf-8");
      if (text.trim()) {
        return text;
      }
    } catch {
      // Falls through to the fallback message below
    }
    return "(Plan file is empty — the teammate may not have written the plan as expected)";
  }

  /**
   * Sends the teammate's completed plan to the Leader, blocks until approval is received,
   * and returns the prompt to feed the model on the next turn.
   *
   * The teammate holds read-only permissions at this point, so no matter how long the
   * wait, no damage can occur — hence no timeout is set here. Rather than timing out and
   * autonomously modifying files, it is better to wait indefinitely and let the user
   * drive progress from the Leader side. Returns null when the teammate has been
   * deactivated; the caller should exit the main loop.
   */
  private async runPlanApproval(
    member: Member,
    plan: string,
  ): Promise<string | null> {
    const req = planApprovalRequest(member.name, plan);
    await this.leaderMailbox.send(member.name, req.text, req);

    // Messages that arrive while we wait for the approval response are held
    // here and requeued once the wait ends — receiveSync consumes them, and
    // dropping a shutdown notice or a new task would lose it forever.
    const held: FileMailMessage[] = [];
    let response: FileMailMessage | undefined;
    while (member.active && response === undefined) {
      await new Promise((r) => setTimeout(r, Team.IDLE_POLL_INTERVAL_MS));
      for (const m of member.mailbox.receiveSync()) {
        if (
          m.type === MSG_PLAN_APPROVAL_RESPONSE &&
          m.requestId === req.requestId
        ) {
          response = m;
        } else {
          held.push(m);
        }
      }
    }
    member.mailbox.requeue(held);
    if (!response) {
      return null;
    }
    // On approval, switch back to normal permissions so the teammate can modify files; on rejection, stay in plan mode to revise
    if (approved(response) && member.checker) {
      member.checker.mode = "default";
    }
    return approved(response)
      ? "The Leader has approved your plan. Begin execution now."
      : `The Leader rejected your plan. Feedback: ${response.text}\nPlease revise the plan accordingly and resubmit.`;
  }

  getMember(name: string): Member | undefined {
    return this.members.get(name);
  }

  async sendMessage(from: string, to: string, content: string): Promise<void> {
    const member = this.members.get(to);
    if (!member) {
      throw new Error(`Member '${to}' not found in team '${this.name}'`);
    }
    // A shutdown notice means the recipient is on its way out; showing it as
    // "running" would misrepresent the state the UI settles on moments later.
    if (
      member.active &&
      member.uiState &&
      !content.startsWith(Team.SHUTDOWN_PREFIX)
    ) {
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

  /**
   * Stops a single teammate: marks it inactive, updates UI state, and
   * unregisters the name so SendMessage can no longer resolve it.
   * External teammates get a grace window after the shutdown notice — they
   * poll their mailbox every ~2 s, so waiting one poll interval lets the
   * common (idle) case exit gracefully before the pane is force-killed.
   * In-process teammates are stopped via cancel (abort) alone; `done` is then
   * awaited so the loop has fully exited (external members have no promise).
   */
  private async stopOne(member: Member): Promise<void> {
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
    if (member.external) {
      try {
        await member.mailbox.send(LEADER_NAME, `${Team.SHUTDOWN_PREFIX} stop`);
        await new Promise((r) => setTimeout(r, Team.STOP_GRACE_MS));
      } catch {
        // best-effort: cancel below runs whether or not this write succeeds; a
        // failed write only deprives the iTerm path of its shutdown signal
      }
    }
    member.cancel?.();
    await member.done;
  }

  listMembers(): Member[] {
    return [...this.members.values()];
  }

  getTeammateStates(): TeammateUIState[] {
    return this.listMembers().flatMap((member) =>
      member.uiState ? [member.uiState] : [],
    );
  }
}

export interface TeamManagerOptions {
  /**
   * Whether this manager acts as the team leader: leaders claim leaderPid on
   * create/restore (persisted for teammate liveness checks), while teammate
   * processes must leave it untouched. Defaults to true.
   */
  claimLeadership?: boolean;
}

export class TeamManager {
  /** Teams keyed by their canonical disk slug; Team.name remains the display name. */
  private teams = new Map<string, Team>();
  private workDir: string;
  private claimLeadership: boolean;
  // One shared task store per canonical team identity.
  private taskStores = new Map<string, SharedTaskStore>();

  constructor(workDir: string, opts: TeamManagerOptions = {}) {
    this.workDir = canonicalPath(workDir);
    this.claimLeadership = opts.claimLeadership ?? true;
  }

  private teamKey(name: string): string {
    return sanitizeTeamName(name);
  }

  private teamDir(name: string): string {
    return teamDir(this.workDir, name);
  }

  create(
    name: string,
    mode: TeamMode = detectBackend(),
    opts: { leaderAgentId?: string; description?: string } = {},
  ): Team {
    const existing = this.get(name);
    if (existing) {
      return existing;
    }

    const key = this.teamKey(name);
    const team = new Team(name, mode, this.workDir);
    team.leaderAgentId = opts.leaderAgentId ?? "";
    team.description = opts.description;
    if (this.claimLeadership) {
      team.leaderPid = process.pid;
    }
    this.teams.set(key, team);
    const store = new SharedTaskStore(join(this.teamDir(name), "tasks.json"));
    store.initEmpty();
    this.taskStores.set(key, store);
    team.persist();
    return team;
  }

  /**
   * Checks the in-memory cache first; on miss, hydrates config.json without
   * incremental member writes. Active members regain their runtime-facing UI,
   * registry, and external cancellation metadata. A leader claims leadership
   * with one final snapshot; teammate processes leave the file byte-identical.
   */
  get(name: string): Team | undefined {
    const key = this.teamKey(name);
    const cached = this.teams.get(key);
    if (cached) {
      return cached;
    }

    const tf = readTeamFile(this.workDir, name);
    if (!tf) {
      return undefined;
    }

    const mode = tf.members.find((m) => m.backendType)?.backendType;
    const team = new Team(
      tf.name,
      isTeamMode(mode) ? mode : "in-process",
      this.workDir,
    );
    team.leaderAgentId = tf.leaderAgentId;
    team.description = tf.description;
    team.createdAt = tf.createdAt;
    team.leaderPid = tf.leaderPid ?? 0;
    for (const member of tf.members) {
      team.hydrateMember(member);
    }
    if (this.claimLeadership) {
      team.leaderPid = process.pid;
      team.persist();
    }
    this.teams.set(key, team);
    return team;
  }

  /**
   * Loads every team found on disk into the manager. Called on leader startup
   * so teams (and their leader mailboxes) survive a leader restart: external
   * teammates keep running, and their notifications are drained again.
   */
  restoreFromDisk(): void {
    for (const name of listTeamNames(this.workDir)) {
      this.get(name);
    }
  }

  /** Retrieves the team's shared task store; loads from disk (tasks.json) when not cached in memory (e.g. in a teammate process). */
  getTaskStore(teamName: string): SharedTaskStore {
    const key = this.teamKey(teamName);
    const cached = this.taskStores.get(key);
    if (cached) {
      return cached;
    }
    const store = new SharedTaskStore(
      join(this.teamDir(teamName), "tasks.json"),
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

  async delete(name: string): Promise<void> {
    const key = this.teamKey(name);
    const team = this.teams.get(key);
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
    for (const name of listTeamNames(this.workDir)) {
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
      lines.push(`<task-notification team="${team.name}">`);
      for (const msg of msgs) {
        const member = team.getMember(msg.from);
        if (member?.uiState && msg.text.startsWith("[idle]")) {
          const failed = msg.text.includes(" failed:");
          const stopped = msg.text.includes("reason: stopped");
          member.uiState.status = failed
            ? "failed"
            : stopped
              ? "stopped"
              : "idle";
          clearActiveTools(member.uiState.progress);
          if (failed || stopped) {
            member.active = false;
            getNameRegistry().unregister(member.name);
            team.persist();
          }
        }
        lines.push(`from=${msg.from}: ${msg.text}`);
      }
      lines.push("</task-notification>");
      out.push(lines.join("\n"));
    }
    return out;
  }
}

function isTeamMode(mode?: string): mode is TeamMode {
  return mode === "in-process" || mode === "tmux" || mode === "iterm";
}
