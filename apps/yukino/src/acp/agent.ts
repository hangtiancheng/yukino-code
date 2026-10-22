import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentApp,
  AgentRequestContext,
  CancelNotification,
  CloseSessionRequest,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";

import { SESSION_ID_PATTERN } from "@/acp/constants.js";
import {
  addUsage,
  agentEventToUpdate,
  emptyUsage,
  historyNotifications,
  promptToText,
  stopReason,
  toolKind,
  toolLocations,
} from "@/acp/conversion.js";
import type { AgentEvent } from "@/agent/events.js";
import { parse as parseCommand } from "@/commands/commands.js";
import {
  forkEnabled,
  loadConfig,
  memoryEnabled,
  withProjectMcpServers,
} from "@/config/index.js";
import { resolveDefaultProvider } from "@/config/provider-config.js";
import type { ConversationManager } from "@/conversation/index.js";
import { recordInput, type InputEntry } from "@/history/index.js";
import { createRemoteAgent } from "@/remote/server.js";
import {
  getSessionFilePath,
  listSessions,
  loadSessionForResume,
  rebuildFromSession,
} from "@/session/index.js";
import type { PermissionRequestHandler } from "@/tools/types.js";
import { version } from "@/version.js";

export interface AcpRuntime {
  sessionId: string;
  cwd: string;
  contextWindow: number;
  conv: ConversationManager;
  run(
    text: string,
    callbacks: {
      onPermissionRequest: PermissionRequestHandler;
      input?: InputEntry;
      userContent?: string;
    },
  ): AsyncGenerator<AgentEvent>;
  abort(): void;
  dispose(): Promise<void>;
}

export type AcpRuntimeFactory = (
  cwd: string,
  sessionId?: string,
) => Promise<AcpRuntime>;

interface AcpSession {
  runtime: AcpRuntime;
  generation: number;
  tail: Promise<void>;
  turnAbort: AbortController | null;
  closed: boolean;
}

export interface YukinoAcpApp {
  app: AgentApp;
  dispose(): Promise<void>;
}

async function createRuntime(
  cwd: string,
  sessionId?: string,
): Promise<AcpRuntime> {
  const config = withProjectMcpServers(loadConfig(), cwd);
  const provider = resolveDefaultProvider(
    config.providers,
    config.default_provider,
  );
  if (!provider) {
    throw acp.RequestError.internalError(undefined, "No provider configured.");
  }
  const runtime = await createRemoteAgent({
    enableModelPlanMode: false,
    provider,
    cwd,
    hooks: config.hooks,
    mcpServers: config.mcp_servers,
    mcpLoading: config.mcp_loading,
    lspServers: config.lsp_servers,
    sandboxConfig: config.sandbox,
    enableCoordinatorMode: config.enable_coordinator_mode ?? false,
    forkDisabled: !forkEnabled(config),
    memoryEnabled: memoryEnabled(config),
    sessionId,
  });
  return {
    sessionId: runtime.sessionId,
    cwd: runtime.cwd,
    contextWindow: runtime.contextWindow,
    conv: runtime.conv,
    run: runtime.run.bind(runtime),
    abort: () => {
      runtime.abort();
    },
    dispose: () => runtime.dispose(),
  };
}

function validateCwd(cwd: string): void {
  if (!isAbsolute(cwd)) {
    throw acp.RequestError.invalidParams(
      undefined,
      "Session cwd must be absolute.",
    );
  }
}

function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw acp.RequestError.invalidParams(undefined, "Invalid session ID.");
  }
}

function validateWorkspaceInputs(params: {
  cwd: string;
  mcpServers?: unknown[];
  additionalDirectories?: string[];
}): void {
  validateCwd(params.cwd);
  if ((params.mcpServers?.length ?? 0) > 0) {
    throw acp.RequestError.invalidParams(
      undefined,
      "Client-provided MCP servers are not supported.",
    );
  }
  if ((params.additionalDirectories?.length ?? 0) > 0) {
    throw acp.RequestError.invalidParams(
      undefined,
      "Additional workspace directories are not supported.",
    );
  }
}

export class YukinoAcpAgent {
  private readonly sessions = new Map<string, AcpSession>();

  constructor(
    private readonly runtimeFactory: AcpRuntimeFactory = createRuntime,
  ) {}

  initialize(_params: InitializeRequest): InitializeResponse {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      authMethods: [],
      agentInfo: {
        name: "yukino",
        title: "Yukino",
        version,
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true },
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {},
        },
      },
    };
  }

  authenticate(): Record<string, never> {
    return {};
  }

  private addSession(runtime: AcpRuntime): AcpSession {
    const session: AcpSession = {
      runtime,
      generation: 0,
      tail: Promise.resolve(),
      turnAbort: null,
      closed: false,
    };
    this.sessions.set(runtime.sessionId, session);
    return session;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    validateWorkspaceInputs(params);
    const runtime = await this.runtimeFactory(params.cwd);
    this.addSession(runtime);
    return { sessionId: runtime.sessionId };
  }

  async loadSession(
    params: LoadSessionRequest | ResumeSessionRequest,
    client: acp.AgentContext,
    replay: boolean,
  ): Promise<Record<string, never>> {
    validateWorkspaceInputs(params);
    validateSessionId(params.sessionId);

    let session = this.sessions.get(params.sessionId);
    if (session && session.runtime.cwd !== params.cwd) {
      throw acp.RequestError.invalidParams(
        undefined,
        "Session cwd does not match.",
      );
    }
    if (session && !replay) {
      return {};
    }

    const saved = loadSessionForResume(params.cwd, params.sessionId);
    if (
      !session &&
      !existsSync(getSessionFilePath(params.cwd, params.sessionId))
    ) {
      throw acp.RequestError.resourceNotFound(params.sessionId);
    }
    if (!session) {
      const runtime = await this.runtimeFactory(params.cwd, params.sessionId);
      runtime.conv.reset();
      runtime.conv.appendMessages(rebuildFromSession(saved));
      session = this.addSession(runtime);
    }

    if (replay) {
      for (const notification of historyNotifications(
        params.sessionId,
        saved,
        params.cwd,
      )) {
        await client.notify(acp.methods.client.session.update, notification);
      }
    }
    return {};
  }

  listSessions(params: ListSessionsRequest): ListSessionsResponse {
    if (params.cursor) {
      throw acp.RequestError.invalidParams(
        undefined,
        "Session pagination is not supported.",
      );
    }
    const cwd = params.cwd ?? process.cwd();
    validateCwd(cwd);
    return {
      sessions: listSessions(cwd).map((session) => ({
        sessionId: session.id,
        cwd,
        title: session.firstMessage || undefined,
        updatedAt: session.modTime.toISOString(),
      })),
    };
  }

  prompt(
    params: PromptRequest,
    context: AgentRequestContext<PromptRequest>,
  ): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId);
    const text = promptToText(params.prompt);
    const generation = session.generation;
    const run: Promise<PromptResponse> = session.tail
      .catch(() => undefined)
      .then(async () => {
        if (
          session.closed ||
          generation !== session.generation ||
          context.signal.aborted
        ) {
          return { stopReason: "cancelled" };
        }

        const turnAbort = new AbortController();
        session.turnAbort = turnAbort;
        const signal = AbortSignal.any([context.signal, turnAbort.signal]);
        const abort = (): void => {
          session.runtime.abort();
        };
        if (signal.aborted) {
          abort();
        } else {
          signal.addEventListener("abort", abort, { once: true });
        }
        try {
          return await this.runPrompt(
            session,
            params.sessionId,
            text,
            context,
            signal,
          );
        } finally {
          signal.removeEventListener("abort", abort);
          if (session.turnAbort === turnAbort) {
            session.turnAbort = null;
          }
        }
      });
    session.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  cancel(params: CancelNotification): void {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      return;
    }
    session.generation += 1;
    session.turnAbort?.abort();
    session.runtime.abort();
  }

  async closeSession(
    params: CloseSessionRequest,
  ): Promise<Record<string, never>> {
    validateSessionId(params.sessionId);
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      return {};
    }
    session.closed = true;
    session.generation += 1;
    session.turnAbort?.abort();
    session.runtime.abort();
    await session.tail.catch(() => undefined);
    await session.runtime.dispose();
    this.sessions.delete(params.sessionId);
    return {};
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      session.closed = true;
      session.generation += 1;
      session.turnAbort?.abort();
      session.runtime.abort();
    }
    await Promise.all(
      sessions.map(async (session) => {
        await session.tail.catch(() => undefined);
        await session.runtime.dispose();
      }),
    );
  }

  private requireSession(sessionId: string): AcpSession {
    validateSessionId(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      throw acp.RequestError.resourceNotFound(sessionId);
    }
    return session;
  }

  private async runPrompt(
    session: AcpSession,
    sessionId: string,
    text: string,
    context: AgentRequestContext<PromptRequest>,
    signal: AbortSignal,
  ): Promise<PromptResponse> {
    const input = recordInput({
      cwd: session.runtime.cwd,
      sessionId,
      source: "acp",
      text,
      commandName: parseCommand(text)?.name === "goal" ? "goal" : null,
    });

    let reason: PromptResponse["stopReason"] = "end_turn";
    let sawUsage = false;
    let usage = emptyUsage();

    for await (const event of session.runtime.run(text, {
      input,
      userContent: text,
      onPermissionRequest: async (
        toolName,
        args,
        decision,
        toolCallId,
        requestSignal,
        source,
      ) => {
        const permissionSignal = requestSignal ?? signal;
        const permission = context.client.request(
          acp.methods.client.session.requestPermission,
          {
            sessionId,
            toolCall: {
              toolCallId,
              title: `${source ? `${source.agentName} · ${source.cwd} · ` : ""}${toolName}: ${decision.reason}`,
              kind: toolKind(toolName),
              status: "pending",
              rawInput: args,
              locations: toolLocations(
                args,
                source?.cwd ?? session.runtime.cwd,
              ),
            },
            options: [
              { optionId: "allow", name: "Allow once", kind: "allow_once" },
              ...(decision.rememberPatterns?.length
                ? [
                    {
                      optionId: "allowAlways",
                      name: `Remember for all project agents: ${decision.rememberPatterns.join(", ")}`,
                      kind: "allow_always" as const,
                    },
                  ]
                : []),
              { optionId: "deny", name: "Reject", kind: "reject_once" },
            ],
          },
        );
        let cancelPermission = (): void => undefined;
        const cancelled = new Promise<null>((resolve) => {
          cancelPermission = (): void => {
            resolve(null);
          };
          if (permissionSignal.aborted) {
            cancelPermission();
          } else {
            permissionSignal.addEventListener("abort", cancelPermission, {
              once: true,
            });
          }
        });
        const response = await Promise.race([permission, cancelled]);
        permissionSignal.removeEventListener("abort", cancelPermission);
        if (!response || response.outcome.outcome === "cancelled") {
          if (signal.aborted || !permissionSignal.aborted) {
            session.runtime.abort();
          }
          return "deny";
        }
        if (response.outcome.optionId === "allowAlways") {
          return decision.rememberPatterns?.length ? "allowAlways" : "allow";
        }
        return response.outcome.optionId === "allow" ? "allow" : "deny";
      },
    })) {
      if (event.type === "error") {
        throw acp.RequestError.internalError(undefined, event.error.message);
      }
      if (event.type === "loop_complete") {
        reason = stopReason(event.stopReason);
      }
      if (event.type === "usage") {
        usage = addUsage(usage, event);
        sawUsage = true;
      }
      const update = agentEventToUpdate(
        event,
        session.runtime.cwd,
        session.runtime.contextWindow,
      );
      if (update) {
        const notification: SessionNotification = { sessionId, update };
        await context.client.notify(
          acp.methods.client.session.update,
          notification,
        );
      }
    }

    return {
      stopReason: reason,
      ...(sawUsage ? { usage } : {}),
    };
  }
}

export function createYukinoAcpApp(
  runtimeFactory?: AcpRuntimeFactory,
): YukinoAcpApp {
  const implementation = new YukinoAcpAgent(runtimeFactory);
  const app = acp
    .agent({ name: "yukino" })
    .onRequest(acp.methods.agent.initialize, (context) =>
      implementation.initialize(context.params),
    )
    .onRequest(acp.methods.agent.authenticate, () =>
      implementation.authenticate(),
    )
    .onRequest(acp.methods.agent.session.new, (context) =>
      implementation.newSession(context.params),
    )
    .onRequest(acp.methods.agent.session.prompt, (context) =>
      implementation.prompt(context.params, context),
    )
    .onRequest(acp.methods.agent.session.list, (context) =>
      implementation.listSessions(context.params),
    )
    .onRequest(acp.methods.agent.session.load, (context) =>
      implementation.loadSession(context.params, context.client, true),
    )
    .onRequest(acp.methods.agent.session.resume, (context) =>
      implementation.loadSession(context.params, context.client, false),
    )
    .onRequest(acp.methods.agent.session.close, (context) =>
      implementation.closeSession(context.params),
    )
    .onNotification(acp.methods.agent.session.cancel, (context) => {
      implementation.cancel(context.params);
    })
    .onConnect((connection) => {
      connection.signal.addEventListener(
        "abort",
        () => {
          void implementation.dispose();
        },
        { once: true },
      );
    });

  return {
    app,
    dispose: () => implementation.dispose(),
  };
}
