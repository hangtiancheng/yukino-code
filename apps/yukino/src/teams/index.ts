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

import { detectBackend, spawnTeammate as spawnTeammateProcess } from "./backend.js";
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
  MSG_PLAN_APPROVAL_RESPONSE,
  MSG_SHUTDOWN_REQUEST,
  approved,
  isShutdownRequest,
  planApprovalRequest,
  shutdownRequest,
  shutdownResponse,
} from "./protocol.js";
import { getNameRegistry } from "./registry.js";
import { SharedTaskStore } from "./shared-task.js";
import { listTeamNames, readTeamFile, teamDir, writeTeamFile, type TeamFile } from "./team-file.js";
import { saveTranscript } from "./transcript.js";

import type { ConversationManager } from "@/conversation/index.js";
import { createChildLogger } from "@/logger/index.js";
import type { PermissionChecker } from "@/permissions/index.js";
import { getOrCreatePlanPath } from "@/plan-file/index.js";
import { buildTeammatePrompt } from "@/prompt/delegation.js";
import type { SubagentProgressEvent } from "@/subagent/spawn.js";
import { asErrorString } from "@/utils/index.js";
import { randomVerb } from "@/utils/verbs.js";

// Submodule namespaces for library consumers (Teams.<Sub>.*).
export * as Backend from "./backend.js";
export * as Coordinator from "./coordinator.js";
export * as FileMailbox from "./file-mailbox.js";
export * as Progress from "./progress.js";
export * as Protocol from "./protocol.js";
export * as Registry from "./registry.js";
export * as SharedTask from "./shared-task.js";
export * as TaskStop from "./task-stop.js";
export * as TaskTools from "./task-tools.js";
export * as TeamFile from "./team-file.js";
export * as Tools from "./tools.js";
export * as Transcript from "./transcript.js";

const log = createChildLogger({ module: "teams" });
export type TeamMode = "in-process" | "tmux" | "iterm";

// Callback that receives agent events during execution. The team layer uses
// this to update TeammateUIState without depending on the agent/LLM layer.
export type AgentEventCallback = (event: SubagentProgressEvent) => void;

export interface Member {
  name: string;
  active: boolean;
  cancel?: () => void;
  /** Resolves when the in-process teammate's current loop has fully stopped. */
  done?: Promise<void>;
  mailbox: FileMailbox;
  uiState?: TeammateUIState;
  /** Optional: Conversation manager for the teammate; when set, the transcript is persisted on exit. */
  conversation?: ConversationManager;
  /** Optional: pane / session identifier for the teammate under the tmux/iTerm backend, used to locate it on stop. */
  paneId?: string;
  /** Whether this is an external-process teammate (tmux/iTerm); determines whether shutdown is delivered via the mailbox. */
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
// (tool_use, usage) without coupling to the Agent/LLM types directly.
export type RunAgent = (
  task: string,
  onEvent?: AgentEventCallback,
  abortSignal?: AbortSignal,
) => Promise<string>;

export class Team {
  name: string;
  mode: TeamMode;
  members = new Map<string, Member>();
  leadMailbox: FileMailbox;
  private mailboxDir: string;
  private workDir: string;

  // Team-level metadata for persistence
  leadAgentId = "";
  description?: string;
  createdAt = Math.floor(Date.now() / 1000);

  constructor(name: string, mode: TeamMode, workDir: string) {
    this.name = name;
    this.mode = mode;
    this.workDir = workDir;
    // Mailboxes live in a dedicated inboxes/ subdirectory, separate from
    // config.json and tasks.json at the team root, keeping the layout clean
    // as membership grows.
    this.mailboxDir = join(teamDir(name), "inboxes");
    mkdirSync(this.mailboxDir, { recursive: true });
    this.leadMailbox = new FileMailbox(this.mailboxDir, "lead");
  }

  addMember(name: string): Member {
    const mailbox = new FileMailbox(this.mailboxDir, name);
    const member: Member = {
      name,
      active: false,
      mailbox,
      agentId: name,
      joinedAt: Math.floor(Date.now() / 1000),
    };
    this.members.set(name, member);
    this.persist();
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

  /** Exports the current state into a persistable structure. */
  snapshot(): TeamFile {
    return {
      name: this.name,
      description: this.description,
      createdAt: this.createdAt,
      leadAgentId: this.leadAgentId,
      members: [...this.members.values()].map((m) => ({
        agentId: m.agentId ?? m.name,
        name: m.name,
        agentType: m.agentType,
        model: m.model,
        joinedAt: m.joinedAt ?? 0,
        worktreePath: m.worktreePath,
        backendType: this.mode,
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
    writeTeamFile(this.name, this.snapshot());
  }

  // Idle polling interval (in milliseconds). Polls the mailbox for new messages after a teammate completes a turn.
  static readonly IDLE_POLL_INTERVAL_MS = 500;
  // Shutdown prefix: the lead writes a message with this prefix to notify teammates to exit.
  static readonly SHUTDOWN_PREFIX = "[shutdown]";

  /**
   * Spawns a teammate, dispatching by team backend mode.
   *   - in-process: runs the agent main loop in a background task within this process (idle-poll-continue).
   *   - tmux / iterm: assembles the teammate startup command and delegates to the backend to launch
   *     an independent worker process in a new pane / tab, communicating bidirectionally with the
   *     lead via the shared file-based mailbox.
   * Falls back to in-process when the external backend is unavailable (tmux not installed,
   * non-iTerm environment, etc.) to avoid crashes.
   */
  spawnTeammate(
    name: string,
    task: string,
    runAgent: RunAgent,
    checker?: PermissionChecker,
    providerBaseUrl?: string,
    originToolCallId?: string,
  ): void {
    if (this.mode === "in-process") {
      this.spawnInProcess(name, task, runAgent, checker, originToolCallId);
      return;
    }
    try {
      this.spawnExternal(name, task, providerBaseUrl, originToolCallId);
    } catch {
      // Fall back to in-process mode when the external backend fails to launch (missing dependency / unsupported platform)
      this.spawnInProcess(name, task, runAgent, checker, originToolCallId);
    }
  }

  /**
   * tmux / iTerm backend: launches the teammate as an independent process in a new pane / tab.
   * The teammate process connects back to the team via the same mailbox directory pointed to
   * by `--team-dir`; task assignments from the lead and idle/result notifications from the
   * worker all land in this directory, keeping both sides in sync.
   */
  private spawnExternal(
    name: string,
    task: string,
    providerBaseUrl?: string,
    originToolCallId?: string,
  ): void {
    const member = this.addMember(name);
    member.active = true;

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
      spinnerVerb: randomVerb(),
    };

    // Teammate entry point mirrors main.tsx: node runs this repo's entry script with --teammate flags.
    // Flag names align with parseTeammateFlags in teammate.ts. The team name is
    // passed explicitly so the shared task board resolves to the same tasks.json.
    const entry = process.argv[1] ?? "src/main.tsx";
    const config: SpawnConfig = {
      mode: this.mode,
      command: "node",
      args: [
        "run",
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
        ...(providerBaseUrl ? ["--provider-base-url", providerBaseUrl] : []),
        "--input-type=module",
      ],
      cwd: this.workDir,
    };

    // Launch the external process and record cancel/paneId on the member for later stop
    const { cancel, paneId } = spawnTeammateProcess(config);
    member.cancel = cancel;
    member.paneId = paneId;
    member.external = true;
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
    member.checker = checker;
    const abortController = new AbortController();
    member.cancel = () => {
      abortController.abort();
    };

    // Register the member name in the global name registry so SendMessage can resolve and deliver by name
    getNameRegistry().register(name, name);

    // Create UI state for progress tracking
    const uiState: TeammateUIState = {
      name,
      teamName: this.name,
      status: "running",
      progress: createProgress(),
      ...(originToolCallId ? { originToolCallId } : {}),
      startTime: Date.now(),
      spinnerVerb: randomVerb(),
    };
    member.uiState = uiState;

    // Agent event callback: update progress
    const onEvent: AgentEventCallback = (event) => {
      switch (event.type) {
        case "tool_use":
          recordToolStart(uiState.progress, event.toolId, event.toolName, event.args);
          break;
        case "tool_result":
          recordToolResult(uiState.progress, event.toolId);
          break;
        case "usage":
          recordTokens(uiState.progress, event.usage.inputTokens, event.usage.outputTokens);
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
          // Execute one turn of the agent
          uiState.status = "running";
          const result = await runAgent(
            buildTeammatePrompt(this.name, name, nextPrompt),
            onEvent,
            abortController.signal,
          );
          clearActiveTools(uiState.progress);
          uiState.lastMessage = result.length > 200 ? result.slice(0, 200) + "..." : result;
          if (abortController.signal.aborted || !member.active) {
            uiState.status = "stopped";
            await this.leadMailbox.send(name, `[idle] ${name} (reason: stopped)`);
            break;
          }
          // Plan-mode teammate: a completed turn means it called ExitPlanMode and the plan
          // has been written to disk. Submit the plan to the Lead for approval; only after
          // approval is the read-only restriction lifted and execution begins.
          if (member.checker?.mode === "plan") {
            uiState.status = "idle";
            const next = await this.runPlanApproval(member, this.readPlanForReview());
            if (next === null) {
              break;
            }
            nextPrompt = next;
            continue;
          }

          // Send idle notification to the lead
          uiState.status = "idle";
          await this.leadMailbox.send(name, `[idle] ${name} (reason: ${idleReason})`);
          idleReason = "available";

          // Poll mailbox for new messages or shutdown
          const pollResult = await this.waitForNextPromptOrShutdown(member);
          if (pollResult.shutdown || !member.active) {
            // Before exiting, send the Lead an explicit acknowledgment so it knows the pane
            // can be reclaimed. The teammate always approves here: it is already in the idle
            // poll loop with no work in progress.
            const req = pollResult.shutdown;
            if (req?.type === MSG_SHUTDOWN_REQUEST) {
              const resp = shutdownResponse(
                member.name,
                req.requestId ?? "",
                true,
                "acknowledged, shutting down",
              );
              await this.leadMailbox.send(member.name, resp.text, resp);
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
          await this.leadMailbox.send(name, `[idle] ${name} (reason: stopped)`);
        } else {
          log.error({ err }, "teams operation failed");
          uiState.status = "failed";
          uiState.lastMessage = asErrorString(err);
          await this.leadMailbox.send(name, `[idle] ${name} (reason: failed)`);
        }
      } finally {
        member.active = false;
        clearActiveTools(uiState.progress);
        if (uiState.status === "running") {
          uiState.status = "idle";
        }
        // Persist conversation transcript on teammate exit for debugging
        if (member.conversation) {
          try {
            saveTranscript(this.workDir, this.name, name, member.conversation);
          } catch (err) {
            log.error({ err }, "teams operation failed");
            // Best-effort: persistence failure should not block normal exit
          }
        }
      }
    })();
    member.done = done;
  }

  /**
   * Blocks until there is a new message in the teammate's mailbox.
   * Returns the concatenated prompt or a shutdown flag.
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

      // Concatenate all messages as the user prompt for the next turn
      const prompt = msgs.map((m) => `From ${m.from}: ${m.text}`).join("\n\n");
      return { prompt: `You have new messages from your team:\n\n${prompt}` };
    }
    return {
      prompt: "",
      shutdown: shutdownRequest("lead", "member deactivated"),
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
   * Sends the teammate's completed plan to the Lead, blocks until approval is received,
   * and returns the prompt to feed the model on the next turn.
   *
   * The teammate holds read-only permissions at this point, so no matter how long the
   * wait, no damage can occur — hence no timeout is set here. Rather than timing out and
   * autonomously modifying files, it is better to wait indefinitely and let the user
   * drive progress from the Lead side. Returns null when the teammate has been
   * deactivated; the caller should exit the main loop.
   */
  private async runPlanApproval(member: Member, plan: string): Promise<string | null> {
    const req = planApprovalRequest(member.name, plan);
    await this.leadMailbox.send(member.name, req.text, req);

    while (member.active) {
      await new Promise((r) => setTimeout(r, Team.IDLE_POLL_INTERVAL_MS));
      for (const m of member.mailbox.receiveSync()) {
        // Only accept the approval response matching this request; other messages are deferred to the next turn
        if (m.type === MSG_PLAN_APPROVAL_RESPONSE && m.requestId === req.requestId) {
          // On approval, switch back to normal permissions so the teammate can modify files; on rejection, stay in plan mode to revise
          if (approved(m) && member.checker) {
            member.checker.mode = "default";
          }
          return approved(m)
            ? "The Lead has approved your plan. Begin execution now."
            : `The Lead rejected your plan. Feedback: ${m.text}\nPlease revise the plan accordingly and resubmit.`;
        }
      }
    }
    return null;
  }

  getMember(name: string): Member | undefined {
    return this.members.get(name);
  }

  async sendMessage(from: string, to: string, content: string): Promise<void> {
    const member = this.members.get(to);
    if (!member) {
      throw new Error(`Member '${to}' not found in team '${this.name}'`);
    }
    if (member.active && member.uiState) {
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
    await Promise.allSettled([...this.members.values()].map((member) => this.stopOne(member)));
  }

  /**
   * Stops a single teammate: marks it inactive and updates UI state.
   * For external teammates (tmux/iTerm), a shutdown notification is written to their mailbox
   * first to allow graceful exit, followed by cancel as a force-kill fallback;
   * in-process teammates only need cancel.
   */
  private async stopOne(member: Member): Promise<void> {
    member.active = false;
    if (member.uiState?.status === "running" || member.uiState?.status === "idle") {
      member.uiState.status = "stopped";
    }
    if (member.external) {
      try {
        await member.mailbox.send("lead", `${Team.SHUTDOWN_PREFIX} stop`);
      } catch {
        // best-effort: proceed to cancel fallback even if the shutdown write fails
      }
    }
    member.cancel?.();
    await member.done;
  }

  listMembers(): Member[] {
    return [...this.members.values()];
  }

  getTeammateStates(): TeammateUIState[] {
    return this.listMembers().flatMap((member) => (member.uiState ? [member.uiState] : []));
  }
}

export class TeamManager {
  private teams = new Map<string, Team>();
  private workDir: string;
  // One shared task store per team, persisted at <team-dir>/tasks.json
  private taskStores = new Map<string, SharedTaskStore>();

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  private teamDir(name: string): string {
    return teamDir(name);
  }

  create(
    name: string,
    mode: TeamMode = detectBackend(),
    opts: { leadAgentId?: string; description?: string } = {},
  ): Team {
    const team = new Team(name, mode, this.workDir);
    team.leadAgentId = opts.leadAgentId ?? "";
    team.description = opts.description;
    this.teams.set(name, team);
    // Initialize an empty shared task store when creating a new team
    const store = new SharedTaskStore(join(this.teamDir(name), "tasks.json"));
    store.initEmpty();
    this.taskStores.set(name, store);
    team.persist();
    return team;
  }

  /**
   * Checks the in-memory cache first; on miss, looks for config.json on disk.
   *
   * A Team reconstructed from disk carries only metadata — members have no running
   * agents. This is sufficient for SendMessage to deliver by name and for UI display;
   * to actually run a member again, it must be re-spawned.
   */
  get(name: string): Team | undefined {
    const cached = this.teams.get(name);
    if (cached) {
      return cached;
    }

    const tf = readTeamFile(name);
    if (!tf) {
      return undefined;
    }

    const mode = tf.members.find((m) => m.backendType)?.backendType;
    const team = new Team(tf.name, isTeamMode(mode) ? mode : "in-process", this.workDir);
    team.leadAgentId = tf.leadAgentId;
    team.description = tf.description;
    team.createdAt = tf.createdAt;
    for (const m of tf.members) {
      const member = team.addMember(m.name);
      member.agentId = m.agentId;
      member.agentType = m.agentType;
      member.model = m.model;
      member.worktreePath = m.worktreePath;
      member.joinedAt = m.joinedAt;
      member.active = m.isActive === true;
    }
    this.teams.set(name, team);
    return team;
  }

  /** Retrieves the team's shared task store; loads from disk (tasks.json) when not cached in memory (e.g. in a teammate process). */
  getTaskStore(teamName: string): SharedTaskStore {
    const cached = this.taskStores.get(teamName);
    if (cached) {
      return cached;
    }
    const store = new SharedTaskStore(join(this.teamDir(teamName), "tasks.json"));
    this.taskStores.set(teamName, store);
    return store;
  }

  list(): Team[] {
    return [...this.teams.values()];
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(this.list().map((team) => team.stopAll()));
  }

  async delete(name: string): Promise<void> {
    const team = this.teams.get(name);
    if (team) {
      // Unregister this team's members from the global name registry
      const registry = getNameRegistry();
      for (const member of team.listMembers()) {
        registry.unregister(member.name);
      }
      await team.stopAll();
      this.teams.delete(name);
    }
    this.taskStores.delete(name);
    // The team directory contains config.json, tasks.json, and mailboxes. When the team
    // is deleted, remove everything to prevent a future same-named team from picking up stale data.
    rmSync(teamDir(name), { recursive: true, force: true });
  }

  /**
   * Deletes every team: in-memory teams are stopped and unregistered, then any
   * residual team directories on disk (e.g. leftovers from previous sessions,
   * which never appear in list()) are removed too. Enforces the single-team
   * invariant before a new team is created.
   */
  async deleteAll(): Promise<void> {
    for (const team of this.list()) {
      await this.delete(team.name);
    }
    // Directory names are already sanitized; delete() re-sanitizes to the same value.
    for (const name of listTeamNames()) {
      await this.delete(name);
    }
  }

  getAllTeammateStates(): TeammateUIState[] {
    return this.list().flatMap((t) => t.getTeammateStates());
  }

  /**
   * Reads all unread messages from the team lead's mailbox and returns them in XML tag format.
   * This allows the model to parse team notifications in a structured manner.
   */
  drainLeads(): string[] {
    const out: string[] = [];
    for (const team of this.teams.values()) {
      const msgs = team.leadMailbox.receiveSync();
      if (msgs.length === 0) {
        continue;
      }
      const lines: string[] = [];
      lines.push(`<task-notification team="${team.name}">`);
      for (const msg of msgs) {
        const member = team.getMember(msg.from);
        if (member?.active && member.uiState && msg.text.startsWith("[idle]")) {
          member.uiState.status = "idle";
          clearActiveTools(member.uiState.progress);
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
