import { randomUUID } from "node:crypto";

import { TaskState } from "@a2a-js/sdk";
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
import { saveCompactBoundary, saveMessage } from "@/session/index.js";
import type { PermissionRequestHandler } from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";

/** Minimal agent runtime surface the A2A executor drives. */
export interface A2aRuntime {
  sessionId: string;
  workDir: string;
  run(
    text: string,
    callbacks: { onPermissionRequest: PermissionRequestHandler },
  ): AsyncGenerator<AgentEvent>;
  abort(): void;
  dispose(): Promise<void>;
}

export type A2aRuntimeFactory = (workDir: string) => Promise<A2aRuntime>;

/** Default factory: boots the full yukino agent stack for `workDir`. */
export async function createA2aRuntime(workDir: string): Promise<A2aRuntime> {
  const config = withProjectMcpServers(loadConfig(), workDir);
  const provider = resolveDefaultProvider(
    config.providers,
    config.default_provider,
  );
  if (!provider) {
    throw new Error("No provider configured.");
  }
  const runtime = await createRemoteAgent({
    provider,
    workDir,
    hooks: config.hooks,
    mcpServers: config.mcp_servers,
    enableCoordinatorMode: config.enable_coordinator_mode ?? false,
    forkDisabled: !forkEnabled(config),
    memoryEnabled: memoryEnabled(config),
  });
  return {
    sessionId: runtime.sessionId,
    workDir: runtime.workDir,
    run: runtime.run.bind(runtime),
    abort: () => {
      runtime.abort();
    },
    dispose: async () => {
      runtime.abort();
      await Promise.all([
        runtime.backgroundTaskManager.stopAll(),
        runtime.teamManager.stopAll(),
        runtime.mcpManager?.disconnectAll() ?? Promise.resolve(),
      ]);
    },
  };
}

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
  runtimePromise: Promise<A2aRuntime>;
  run: ActiveRun | null;
}

/**
 * Bridges the A2A protocol to the yukino agent loop. One runtime session is
 * kept per A2A `contextId`; each `message/send` turn runs the agent until it
 * completes, fails, or needs a tool permission decision. Permission requests
 * surface as `INPUT_REQUIRED` status updates carrying a yukino
 * `permission-request` data part; the client answers by sending a
 * `permission-response` data part back on the same task.
 */
export class YukinoA2aExecutor implements AgentExecutor {
  private readonly sessions = new Map<string, A2aSession>();
  private permissionCounter = 0;

  constructor(
    private readonly runtimeFactory: A2aRuntimeFactory = createA2aRuntime,
    private readonly workDir: string = process.cwd(),
  ) {}

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const taskId = requestContext.taskId;
    const contextId = requestContext.contextId;
    const message = requestContext.userMessage;
    const session = this.requireSession(contextId);

    let runtime: A2aRuntime;
    try {
      runtime = await session.runtimePromise;
    } catch (error) {
      this.sessions.delete(contextId);
      this.reject(session, eventBus, taskId, contextId, asErrorString(error));
      return;
    }

    const response = findPermissionResponse(message);
    if (response) {
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
      this.reject(
        session,
        eventBus,
        taskId,
        contextId,
        "Message must contain text or a yukino permission-response data part.",
      );
      return;
    }

    const run = session.run;
    if (run && !run.finished) {
      this.reject(
        session,
        eventBus,
        taskId,
        contextId,
        `Context ${contextId} is busy with task ${run.taskId}. ` +
          "Cancel it or wait for it to finish before sending a new message.",
      );
      return;
    }

    const started = this.startRun(
      session,
      runtime,
      taskId,
      contextId,
      text,
      eventBus,
    );
    this.consume(session, started.run, text);
    await started.run.settle.promise;
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const session = this.findSessionByTask(taskId);
    const run = session?.run;
    if (!session || !run || run.finished) {
      // No live run (e.g. the bus outlived its consumer): emit the terminal
      // state directly so the cancellation request still settles.
      eventBus.publish(
        A2aEvent.statusUpdate(
          statusUpdate(
            taskId,
            session?.contextId ?? "",
            TaskState.TASK_STATE_CANCELED,
            agentMessage(taskId, session?.contextId ?? "", [
              textPart("Task canceled by user request."),
            ]),
          ),
        ),
      );
      return;
    }

    run.canceled = true;
    run.bus = eventBus;
    for (const pending of run.permissions.values()) {
      pending.resolve("deny");
    }
    run.permissions.clear();
    run.runtime.abort();
    await run.done.promise;
  }

  /** Aborts every session and disposes the underlying runtimes. */
  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(
      sessions.map(async (session) => {
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

  private requireSession(contextId: string): A2aSession {
    const existing = this.sessions.get(contextId);
    if (existing) {
      return existing;
    }
    const session: A2aSession = {
      contextId,
      runtimePromise: this.runtimeFactory(this.workDir),
      run: null,
    };
    this.sessions.set(contextId, session);
    return session;
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
      this.reject(
        session,
        eventBus,
        taskId,
        contextId,
        "No active run is awaiting a permission response.",
      );
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
  ): { run: ActiveRun } {
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
    saveMessage(runtime.workDir, runtime.sessionId, {
      role: "user",
      content: text,
      timestamp: Math.floor(Date.now() / 1000),
    });
    eventBus.publish(
      A2aEvent.task(
        taskSnapshot(taskId, contextId, TaskState.TASK_STATE_SUBMITTED),
      ),
    );
    return { run };
  }

  private consume(session: A2aSession, run: ActiveRun, text: string): void {
    const taskId = run.taskId;
    const contextId = session.contextId;
    const events = run.runtime.run(text, {
      onPermissionRequest: (toolName, args, decision, toolCallId) =>
        this.requestPermission(
          run,
          taskId,
          contextId,
          toolName,
          args,
          decision,
          toolCallId,
        ),
    });
    void (async () => {
      let failure: string | null = null;
      try {
        for await (const event of events) {
          if (event.type === "compact" && event.boundary) {
            saveCompactBoundary(
              run.runtime.workDir,
              run.runtime.sessionId,
              event.boundary,
            );
          }
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
  ): Promise<PermissionDecision> {
    this.permissionCounter += 1;
    const permissionId = `perm-${String(this.permissionCounter)}-${randomUUID().slice(0, 8)}`;
    const data: PermissionRequestData = {
      yukino: "permission-request",
      permissionId,
      toolCallId,
      toolName,
      reason: decision.reason,
      args,
    };
    return new Promise<PermissionDecision>((resolve) => {
      run.permissions.set(permissionId, { data, resolve });
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
    session: A2aSession,
    eventBus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    reason: string,
  ): void {
    const message = agentMessage(taskId, contextId, [textPart(reason)]);
    if (session.run && !session.run.finished) {
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
