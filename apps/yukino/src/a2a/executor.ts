import { randomUUID } from "node:crypto";

import { TaskState } from "@a2a-js/sdk";
import type { Message } from "@a2a-js/sdk";
import { AgentEvent as A2aEvent } from "@a2a-js/sdk/server";
import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from "@a2a-js/sdk/server";

import {
  agentEventToMessage,
  agentMessage,
  dataPart,
  findPermissionResponse,
  messageText,
  statusUpdate,
  taskSnapshot,
  textPart,
  type PermissionDecision,
  type PermissionRequestData,
  type PermissionResponseData,
} from "./conversion.js";

import type { AgentEvent } from "@/agent/events.js";
import {
  forkEnabled,
  loadConfig,
  memoryEnabled,
  withProjectMcpServers,
} from "@/config/index.js";
import { resolveDefaultProvider } from "@/config/provider-config.js";
import type { Decision } from "@/permissions/index.js";
import { createRemoteAgent } from "@/remote/server.js";
import {
  loadSession,
  rebuildFromSession,
  saveMessage,
} from "@/session/index.js";
import type { PermissionRequestHandler } from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";

/** Minimal agent runtime surface the A2A executor drives. */
export interface A2aRuntime {
  sessionId: string;
  cwd: string;
  run(
    text: string,
    callbacks: { onPermissionRequest: PermissionRequestHandler },
  ): AsyncGenerator<AgentEvent>;
  abort(): void;
  dispose(): Promise<void>;
}

/**
 * Builds a runtime for `cwd`. When `sessionId` is supplied the runtime is
 * a recreation of a previously evicted session and restores that session's
 * transcript so the conversation continues across eviction.
 */
export type A2aRuntimeFactory = (
  cwd: string,
  sessionId?: string,
) => Promise<A2aRuntime>;

/** Default factory: boots the full yukino agent stack for `cwd`. */
export async function createA2aRuntime(
  cwd: string,
  sessionId?: string,
): Promise<A2aRuntime> {
  const config = withProjectMcpServers(loadConfig(), cwd);
  const provider = resolveDefaultProvider(
    config.providers,
    config.default_provider,
  );
  if (!provider) {
    throw new Error("No provider configured.");
  }
  const runtime = await createRemoteAgent({
    interactionMode: "non-interactive",
    provider,
    cwd,
    hooks: config.hooks,
    mcpServers: config.mcp_servers,
    lspServers: config.lsp_servers,
    sandboxConfig: config.sandbox,
    enableCoordinatorMode: config.enable_coordinator_mode ?? false,
    forkDisabled: !forkEnabled(config),
    memoryEnabled: memoryEnabled(config),
    ...(sessionId ? { sessionId } : {}),
  });
  if (sessionId) {
    // Recreation after idle eviction: replay the persisted transcript.
    // createRemoteAgent already injected long-term memory/instructions at the
    // front of the conversation, so appending keeps that ordering intact.
    runtime.conv.appendMessages(
      rebuildFromSession(loadSession(cwd, sessionId)),
    );
  }
  return {
    sessionId: runtime.sessionId,
    cwd: runtime.cwd,
    run: runtime.run.bind(runtime),
    abort: () => {
      runtime.abort();
    },
    dispose: async () => {
      runtime.abort();
      await Promise.allSettled([
        runtime.backgroundTaskManager.stopAll(),
        runtime.teamManager.dispose(),
      ]);
      await Promise.allSettled([
        runtime.mcpManager?.disconnectAll() ?? Promise.resolve(),
        runtime.registry.dispose(),
      ]);
    },
  };
}

/** Idle grace period before an agent runtime is disposed to reclaim resources. */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const NO_ACTIVE_RUN = "No active run is awaiting a permission response.";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface PendingPermission {
  data: PermissionRequestData;
  resolve(decision: PermissionDecision): void;
}

interface ActiveRun {
  taskId: string;
  runtime: A2aRuntime;
  /** Bus the consumer publishes agent events to; swapped per request. */
  bus: ExecutionEventBus;
  /** Resolved whenever the run reaches a quiescent point. */
  settle: Deferred;
  /** Resolved once the consumer loop has exited. */
  done: Deferred;
  canceled: boolean;
  finished: boolean;
  stopReason: string | null;
  permissions: Map<string, PendingPermission>;
}

interface A2aSession {
  contextId: string;
  /** Persisted across eviction so a recreated runtime restores the transcript. */
  sessionId?: string;
  /** Null before first use and after idle eviction; created lazily. */
  runtimePromise: Promise<A2aRuntime> | null;
  run: ActiveRun | null;
  idleTimer: NodeJS.Timeout | null;
}

/**
 * Bridges the A2A protocol to the yukino agent loop. One runtime session is
 * kept per A2A `contextId`; each `message/send` turn runs the agent until it
 * completes, fails, or needs a tool permission decision. Permission requests
 * surface as `INPUT_REQUIRED` status updates carrying a yukino
 * `permission-request` data part; the client answers by sending a
 * `permission-response` data part back on the same task.
 *
 * Runtimes are created lazily (only for a valid, non-busy turn) and disposed
 * after `idleTimeoutMs` without activity; the next message recreates the
 * runtime and restores the persisted transcript, so eviction is transparent to
 * the conversation while reclaiming MCP connections and background managers.
 */
export class YukinoA2aExecutor implements AgentExecutor {
  private readonly sessions = new Map<string, A2aSession>();
  private permissionCounter = 0;

  constructor(
    private readonly runtimeFactory: A2aRuntimeFactory = createA2aRuntime,
    private readonly cwd: string = process.cwd(),
    private readonly idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
  ) {}

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const taskId = requestContext.taskId;
    const contextId = requestContext.contextId;
    const message = requestContext.userMessage;

    // Disarm eviction for the duration of this turn so the runtime cannot be
    // disposed mid-processing; the finally block re-arms it once idle.
    this.disarmIdleTimer(this.sessions.get(contextId));
    try {
      await this.dispatch(taskId, contextId, message, eventBus);
    } finally {
      const session = this.sessions.get(contextId);
      if (session) {
        this.armIdleTimer(session);
      }
    }
  }

  private async dispatch(
    taskId: string,
    contextId: string,
    message: Message,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const response = findPermissionResponse(message);
    if (response) {
      const session = this.sessions.get(contextId);
      if (!session) {
        this.reject(null, eventBus, taskId, contextId, NO_ACTIVE_RUN);
        return;
      }
      await this.handlePermissionResponse(
        session,
        taskId,
        contextId,
        response,
        eventBus,
      );
      return;
    }

    const text = messageText(message);
    if (!text) {
      // Reject without touching the session map: an invalid message must not
      // create a session or spin up a runtime for a fresh contextId.
      this.reject(
        this.sessions.get(contextId) ?? null,
        eventBus,
        taskId,
        contextId,
        "Message must contain text or a yukino permission-response data part.",
      );
      return;
    }

    const existing = this.sessions.get(contextId);
    if (existing?.run && !existing.run.finished) {
      this.reject(
        existing,
        eventBus,
        taskId,
        contextId,
        `Context ${contextId} is busy with task ${existing.run.taskId}. ` +
          "Cancel it or wait for it to finish before sending a new message.",
      );
      return;
    }

    const session = existing ?? this.createSession(contextId);
    let runtime: A2aRuntime;
    try {
      runtime = await this.ensureRuntime(session);
    } catch (error) {
      this.reject(session, eventBus, taskId, contextId, asErrorString(error));
      return;
    }

    const run = this.startRun(
      session,
      runtime,
      taskId,
      contextId,
      text,
      eventBus,
    );
    this.consume(session, run, text);
    await run.settle.promise;
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const session = this.findSessionByTask(taskId);
    const run = session?.run;
    if (!session || !run || run.finished) {
      // No live run (e.g. the bus outlived its consumer): emit the terminal
      // state directly so the cancellation request still settles.
      const contextId = session?.contextId ?? "";
      eventBus.publish(
        A2aEvent.statusUpdate(
          statusUpdate(
            taskId,
            contextId,
            TaskState.TASK_STATE_CANCELED,
            agentMessage(taskId, contextId, [
              textPart("Task canceled by user request."),
            ]),
          ),
        ),
      );
      return;
    }

    this.disarmIdleTimer(session);
    run.canceled = true;
    run.bus = eventBus;
    for (const pending of run.permissions.values()) {
      pending.resolve("deny");
    }
    run.permissions.clear();
    run.runtime.abort();
    await run.done.promise;
  }

  /** Aborts every session, clears idle timers, and disposes the runtimes. */
  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map(async (session) => {
        this.disarmIdleTimer(session);
        if (!session.runtimePromise) {
          return;
        }
        let runtime: A2aRuntime;
        try {
          runtime = await session.runtimePromise;
        } catch {
          return;
        }
        const run = session.run;
        if (run && !run.finished) {
          run.canceled = true;
          for (const pending of run.permissions.values()) {
            pending.resolve("deny");
          }
          run.permissions.clear();
          runtime.abort();
        }
        await runtime.dispose();
      }),
    );
  }

  private createSession(contextId: string): A2aSession {
    const session: A2aSession = {
      contextId,
      sessionId: undefined,
      runtimePromise: null,
      run: null,
      idleTimer: null,
    };
    this.sessions.set(contextId, session);
    return session;
  }

  /**
   * Returns the session's runtime, creating (or recreating after eviction) it
   * lazily. A recreation passes the persisted sessionId so the factory restores
   * the transcript. On failure the slot is cleared so a later message retries.
   */
  private async ensureRuntime(session: A2aSession): Promise<A2aRuntime> {
    session.runtimePromise ??= this.runtimeFactory(
      this.cwd,
      session.sessionId,
    ).then((runtime) => {
      session.sessionId = runtime.sessionId;
      return runtime;
    });
    try {
      return await session.runtimePromise;
    } catch (error) {
      session.runtimePromise = null;
      throw error;
    }
  }

  private armIdleTimer(session: A2aSession): void {
    this.disarmIdleTimer(session);
    if (this.idleTimeoutMs <= 0 || !session.runtimePromise) {
      return;
    }
    if (session.run && !session.run.finished) {
      return;
    }
    const timer = setTimeout(() => {
      session.idleTimer = null;
      this.evictSession(session);
    }, this.idleTimeoutMs);
    timer.unref();
    session.idleTimer = timer;
  }

  private disarmIdleTimer(session: A2aSession | undefined): void {
    if (session?.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }

  /**
   * Disposes an idle session's runtime to reclaim resources, keeping the
   * contextId→sessionId mapping so the next message restores the transcript.
   * Never evicts a session with an in-flight or permission-pending run.
   */
  private evictSession(session: A2aSession): void {
    if (session.run && !session.run.finished) {
      return;
    }
    const runtimePromise = session.runtimePromise;
    session.runtimePromise = null;
    if (runtimePromise) {
      void runtimePromise
        .then((runtime) => runtime.dispose())
        .catch(() => undefined);
    }
  }

  private findSessionByTask(taskId: string): A2aSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.run?.taskId === taskId) {
        return session;
      }
    }
    return undefined;
  }

  private async handlePermissionResponse(
    session: A2aSession,
    taskId: string,
    contextId: string,
    response: PermissionResponseData,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const run = session.run;
    if (!run || run.finished) {
      this.reject(session, eventBus, taskId, contextId, NO_ACTIVE_RUN);
      return;
    }
    if (run.taskId !== taskId) {
      this.reject(
        session,
        eventBus,
        taskId,
        contextId,
        `Permission responses must be sent with taskId "${run.taskId}".`,
      );
      return;
    }
    const pending = run.permissions.get(response.permissionId);
    if (!pending) {
      this.reject(
        session,
        eventBus,
        taskId,
        contextId,
        `Unknown or already resolved permission id "${response.permissionId}".`,
      );
      return;
    }

    run.bus = eventBus;
    run.permissions.delete(response.permissionId);
    run.settle = deferred();
    eventBus.publish(
      A2aEvent.task(
        taskSnapshot(taskId, contextId, TaskState.TASK_STATE_WORKING),
      ),
    );
    pending.resolve(response.decision);
    if (run.permissions.size > 0) {
      this.publishPendingPermissions(run, taskId, contextId);
      run.settle.resolve();
    }
    await run.settle.promise;
  }

  private startRun(
    session: A2aSession,
    runtime: A2aRuntime,
    taskId: string,
    contextId: string,
    text: string,
    eventBus: ExecutionEventBus,
  ): ActiveRun {
    this.disarmIdleTimer(session);
    const run: ActiveRun = {
      taskId,
      runtime,
      bus: eventBus,
      settle: deferred(),
      done: deferred(),
      canceled: false,
      finished: false,
      stopReason: null,
      permissions: new Map(),
    };
    session.run = run;
    saveMessage(runtime.cwd, runtime.sessionId, {
      role: "user",
      content: text,
      timestamp: Math.floor(Date.now() / 1000),
    });
    eventBus.publish(
      A2aEvent.task(
        taskSnapshot(taskId, contextId, TaskState.TASK_STATE_SUBMITTED),
      ),
    );
    return run;
  }

  private consume(session: A2aSession, run: ActiveRun, text: string): void {
    const taskId = run.taskId;
    const contextId = session.contextId;
    const events = run.runtime.run(text, {
      onPermissionRequest: (
        toolName,
        args,
        decision,
        toolCallId,
        signal,
        source,
      ) =>
        this.requestPermission(
          run,
          taskId,
          contextId,
          toolName,
          args,
          decision,
          toolCallId,
          signal,
          source,
        ),
    });
    void (async () => {
      let failure: string | null = null;
      try {
        for await (const event of events) {
          if (event.type === "loop_complete") {
            run.stopReason = event.stopReason;
          }
          if (event.type === "error") {
            failure = event.error.message;
          }
          this.publishAgentEvent(run, taskId, contextId, event);
        }
      } catch (error) {
        failure = asErrorString(error);
      }
      this.finishRun(session, run, taskId, contextId, failure);
    })();
  }

  private requestPermission(
    run: ActiveRun,
    taskId: string,
    contextId: string,
    toolName: string,
    args: Record<string, unknown>,
    decision: Decision,
    toolCallId: string,
    signal?: AbortSignal,
    source?: { agentName: string; cwd: string },
  ): Promise<PermissionDecision> {
    if (signal?.aborted || run.canceled || run.finished) {
      return Promise.resolve("deny");
    }
    this.permissionCounter += 1;
    const permissionId = `perm-${String(this.permissionCounter)}-${randomUUID().slice(0, 8)}`;
    const data: PermissionRequestData = {
      yukino: "permission-request",
      permissionId,
      toolCallId,
      toolName,
      reason: [
        source ? `${source.agentName} · ${source.cwd}` : "",
        decision.reason,
      ]
        .filter(Boolean)
        .join("\n"),
      args,
    };
    return new Promise<PermissionDecision>((resolve) => {
      const complete = (decision: PermissionDecision) => {
        signal?.removeEventListener("abort", cancel);
        resolve(decision);
      };
      const cancel = () => {
        if (!run.permissions.delete(permissionId)) {
          return;
        }
        complete("deny");
        if (!run.canceled && !run.finished) {
          if (run.permissions.size > 0) {
            this.publishPendingPermissions(run, taskId, contextId);
          } else {
            run.bus.publish(
              A2aEvent.statusUpdate(
                statusUpdate(taskId, contextId, TaskState.TASK_STATE_WORKING),
              ),
            );
          }
        }
      };
      run.permissions.set(permissionId, { data, resolve: complete });
      signal?.addEventListener("abort", cancel, { once: true });
      this.publishPendingPermissions(run, taskId, contextId);
      run.settle.resolve();
    });
  }

  private publishPendingPermissions(
    run: ActiveRun,
    taskId: string,
    contextId: string,
  ): void {
    const parts = [...run.permissions.values()].map((pending) =>
      dataPart(pending.data),
    );
    run.bus.publish(
      A2aEvent.statusUpdate(
        statusUpdate(
          taskId,
          contextId,
          TaskState.TASK_STATE_INPUT_REQUIRED,
          agentMessage(taskId, contextId, parts),
        ),
      ),
    );
  }

  private publishAgentEvent(
    run: ActiveRun,
    taskId: string,
    contextId: string,
    event: AgentEvent,
  ): void {
    const message = agentEventToMessage(event, taskId, contextId);
    if (!message) {
      return;
    }
    run.bus.publish(
      A2aEvent.statusUpdate(
        statusUpdate(taskId, contextId, TaskState.TASK_STATE_WORKING, message),
      ),
    );
  }

  private finishRun(
    session: A2aSession,
    run: ActiveRun,
    taskId: string,
    contextId: string,
    failure: string | null,
  ): void {
    if (run.finished) {
      return;
    }
    run.finished = true;
    for (const pending of run.permissions.values()) {
      pending.resolve("deny");
    }
    run.permissions.clear();

    const state = this.finalState(run, failure);
    const message = failure
      ? agentMessage(taskId, contextId, [textPart(failure)])
      : undefined;
    run.bus.publish(
      A2aEvent.statusUpdate(statusUpdate(taskId, contextId, state, message)),
    );
    if (session.run === run) {
      session.run = null;
    }
    run.settle.resolve();
    run.done.resolve();
    // The run reached a terminal state, so the session is now idle.
    this.armIdleTimer(session);
  }

  private finalState(run: ActiveRun, failure: string | null): TaskState {
    if (
      run.canceled ||
      run.stopReason === "cancelled" ||
      run.stopReason === "interrupted"
    ) {
      return TaskState.TASK_STATE_CANCELED;
    }
    if (failure) {
      return TaskState.TASK_STATE_FAILED;
    }
    return TaskState.TASK_STATE_COMPLETED;
  }

  /**
   * Rejects a request. While a run is active the rejection is published as a
   * standalone Message so the in-flight task's persisted state is untouched;
   * otherwise the request's own task fails.
   */
  private reject(
    session: A2aSession | null,
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    reason: string,
  ): void {
    const message = agentMessage(taskId, contextId, [textPart(reason)]);
    if (session?.run && !session.run.finished) {
      eventBus.publish(A2aEvent.message(message));
      return;
    }
    eventBus.publish(
      A2aEvent.task(
        taskSnapshot(taskId, contextId, TaskState.TASK_STATE_FAILED),
      ),
    );
    eventBus.publish(
      A2aEvent.statusUpdate(
        statusUpdate(taskId, contextId, TaskState.TASK_STATE_FAILED, message),
      ),
    );
  }
}
