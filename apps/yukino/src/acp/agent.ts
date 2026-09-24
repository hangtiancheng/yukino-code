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
  Usage,
} from "@agentclientprotocol/sdk";

import {
  addUsage,
  agentEventToUpdate,
  emptyUsage,
  historyNotifications,
  promptToText,
  stopReason,
  toolKind,
  toolLocations,
} from "./conversion.js";

import type { AgentEvent } from "@/agent/events.js";
import {
  forkEnabled,
  loadConfig,
  withProjectMcpServers,
} from "@/config/index.js";
import type { ConversationManager } from "@/conversation/index.js";
import { createRemoteAgent } from "@/remote/server.js";
import {
  getSessionFilePath,
  listSessions,
  loadSession,
  rebuildFromSession,
  saveCompactBoundary,
  saveMessage,
} from "@/session/index.js";
import type { PermissionRequestHandler } from "@/tools/types.js";
import { version } from "@/version.js";

const SESSION_ID_PATTERN = /^[a-z0-9]+-[a-f0-9]{8}$/u;

export interface AcpRuntime {
  sessionId: string;
  workDir: string;
  contextWindow: number;
  conv: ConversationManager;
  run(
    text: string,
    callbacks: { onPermissionRequest: PermissionRequestHandler },
  ): AsyncGenerator<AgentEvent>;
  abort(): void;
  dispose(): Promise<void>;
}

export type AcpRuntimeFactory = (
  workDir: string,
  sessionId?: string,
) => Promise<AcpRuntime>;

interface AcpSession {
  runtime: AcpRuntime;
  generation: number;
  tail: Promise<void>;
  turnAbort: AbortController | null;
  closed: boolean;
  usage: Usage;
}

export interface YukinoAcpApp {
  app: AgentApp;
  dispose(): Promise<void>;
}

async function createRuntime(
  workDir: string,
  sessionId?: string,
): Promise<AcpRuntime> {
  const config = withProjectMcpServers(loadConfig(), workDir);
  const provider = config.providers[0];
  if (!provider) {
    throw acp.RequestError.internalError(undefined, "No provider configured.");
  }
  const runtime = await createRemoteAgent({
    provider,
    workDir,
    hooks: config.hooks,
    mcpServers: config.mcp_servers,
    enableCoordinatorMode: config.enable_coordinator_mode ?? false,
    forkDisabled: !forkEnabled(config),
    sessionId,
  });
  return {
    sessionId: runtime.sessionId,
    workDir: runtime.workDir,
    contextWindow: runtime.contextWindow,
    conv: runtime.conv,
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

function validateWorkDir(cwd: string): void {
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
  validateWorkDir(params.cwd);
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
      usage: emptyUsage(),
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
    if (session && session.runtime.workDir !== params.cwd) {
      throw acp.RequestError.invalidParams(
        undefined,
        "Session cwd does not match.",
      );
    }
    if (session && !replay) {
      return {};
    }

    const saved = loadSession(params.cwd, params.sessionId);
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
    validateWorkDir(cwd);
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
    saveMessage(session.runtime.workDir, sessionId, {
      role: "user",
      content: text,
      timestamp: Math.floor(Date.now() / 1000),
    });

    let reason: PromptResponse["stopReason"] = "end_turn";
    let sawUsage = false;

    for await (const event of session.runtime.run(text, {
      onPermissionRequest: async (toolName, args, decision, toolCallId) => {
        const permission = context.client.request(
          acp.methods.client.session.requestPermission,
          {
            sessionId,
            toolCall: {
              toolCallId,
              title: `${toolName}: ${decision.reason}`,
              kind: toolKind(toolName),
              status: "pending",
              rawInput: args,
              locations: toolLocations(args, session.runtime.workDir),
            },
            options: [
              { optionId: "allow", name: "Allow once", kind: "allow_once" },
              {
                optionId: "allowAlways",
                name: "Always allow",
                kind: "allow_always",
              },
              { optionId: "deny", name: "Reject", kind: "reject_once" },
            ],
          },
        );
        let cancelPermission = (): void => undefined;
        const cancelled = new Promise<null>((resolve) => {
          cancelPermission = (): void => {
            resolve(null);
          };
          if (signal.aborted) {
            cancelPermission();
          } else {
            signal.addEventListener("abort", cancelPermission, { once: true });
          }
        });
        const response = await Promise.race([permission, cancelled]);
        signal.removeEventListener("abort", cancelPermission);
        if (!response || response.outcome.outcome === "cancelled") {
          session.runtime.abort();
          return "deny";
        }
        if (response.outcome.optionId === "allowAlways") {
          return "allowAlways";
        }
        return response.outcome.optionId === "allow" ? "allow" : "deny";
      },
    })) {
      if (event.type === "compact" && event.boundary) {
        saveCompactBoundary(session.runtime.workDir, sessionId, event.boundary);
      }
      if (event.type === "error") {
        throw acp.RequestError.internalError(undefined, event.error.message);
      }
      if (event.type === "loop_complete") {
        reason = stopReason(event.stopReason);
      }
      if (event.type === "usage") {
        session.usage = addUsage(session.usage, event);
        sawUsage = true;
      }
      const update = agentEventToUpdate(
        event,
        session.runtime.workDir,
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
      ...(sawUsage ? { usage: session.usage } : {}),
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
