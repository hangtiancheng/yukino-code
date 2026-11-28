import { z } from "zod";

import { prepareInvocationSession } from "@/bootstrap/headless.js";
import type { InvocationOptions } from "@/cli.js";
import { PreferencesPatchSchema } from "@/config/preferences.js";
import { MCPServerConfigSchema } from "@/mcp/config.js";
import { RpcSessionRestorationArgsSchema } from "@/rpc/protocol.js";
import { RpcServer, type RpcHandler, type RpcHost } from "@/rpc/server.js";
import { RpcTransfers } from "@/rpc/transfers.js";
import {
  createAgentSession,
  type AgentSession,
  type CreateAgentSessionOptions,
  type SessionEvent,
} from "@/sdk/index.js";

export async function runRpcMode(
  options: InvocationOptions = {},
): Promise<void> {
  const invocation = await prepareInvocationSession(options);
  const manager = invocation.sessionManager;
  const controller = new AbortController();
  const listeners = new Set<(event: unknown) => void>();
  let active: AgentSession | undefined;
  let transfers: RpcTransfers | undefined;
  let resolveReady!: (session: AgentSession) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<AgentSession>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);
  const bindHandler =
    (
      handler: (
        session: AgentSession,
        args: Record<string, unknown>,
      ) => unknown,
    ): RpcHandler =>
    async (args) =>
      handler(await ready, args);
  const transferHandler = (
    handler: (store: RpcTransfers, args: Record<string, unknown>) => unknown,
  ): RpcHandler =>
    bindHandler((session, args) => {
      transfers ??= new RpcTransfers(session, controller.signal);
      return handler(transfers, args);
    });
  const handlers: RpcHost["handlers"] = {
    get_state: () => ({
      initialized: !!active,
      sessionId: active?.sessionId ?? manager.id,
      cwd: active?.cwd ?? manager.cwd,
      busy: active?.isBusy ?? false,
      status: active?.getStatus() ?? null,
    }),
    prompt: bindHandler((session, args) =>
      session.prompt(
        {
          text: String(args.text),
          attachments: z
            .array(z.record(z.string(), z.unknown()))
            .optional()
            .parse(args.attachments),
        },
        {
          delivery:
            args.delivery === "follow_up"
              ? "followUp"
              : args.delivery === "steer"
                ? "steer"
                : "reject",
        },
      ),
    ),
    reload: bindHandler((session) => session.reloadResources()),
    get_settings: bindHandler((session) => session.getSettings()),
    set_settings: bindHandler((session, args) =>
      session.setSettings(PreferencesPatchSchema.parse(args.values), {
        persist: args.persist === true,
      }),
    ),
    get_available_models: bindHandler((session) =>
      session.getAvailableModels(),
    ),
    cycle_model: bindHandler((session, args) =>
      session.cycleModel(args.direction === -1 ? -1 : 1),
    ),
    cycle_thinking: bindHandler((session, args) =>
      session.cycleThinkingLevel(args.direction === -1 ? -1 : 1),
    ),
    set_auto_compaction: bindHandler((session, args) => {
      session.setAutoCompaction(z.boolean().parse(args.enabled));
    }),
    set_auto_retry: bindHandler((session, args) => {
      session.setAutoRetry(z.boolean().parse(args.enabled));
    }),
    abort_retry: bindHandler((session) => ({ aborted: session.abortRetry() })),
    steer: bindHandler((session, args) => {
      const receipt = session.steer({
        text: String(args.text),
        attachments: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .parse(args.attachments),
      });
      void receipt.completion.catch(() => undefined);
      return { inputId: receipt.id };
    }),
    follow_up: bindHandler((session, args) => {
      const receipt = session.followUp({
        text: String(args.text),
        attachments: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .parse(args.attachments),
      });
      void receipt.completion.catch(() => undefined);
      return { inputId: receipt.id };
    }),
    get_queue: bindHandler((session) => session.getQueue()),
    get_queue_modes: bindHandler((session) => session.getQueueModes()),
    set_queue_mode: bindHandler((session, args) => {
      session.setQueueMode(
        args.kind === "follow_up" ? "followUp" : "steer",
        z.enum(["all", "one-at-a-time"]).parse(args.mode),
      );
    }),
    clear_queue: bindHandler((session) => session.clearQueue()),
    abort: bindHandler(async (session, args) => {
      if (args.scope === "task") {
        return session.stopTask(String(args.taskId));
      }
      await Promise.all([
        transfers?.invalidate(),
        session.abort(args.scope === "session" ? "all" : "foreground"),
      ]);
    }),
    get_messages: bindHandler((session) => session.getMessages()),
    get_entries: bindHandler((session) => session.getEntries()),
    get_tree: bindHandler((session) => session.getTree()),
    new_session: bindHandler((session, args) =>
      session.newSession({
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        persist: typeof args.persist === "boolean" ? args.persist : undefined,
      }),
    ),
    switch_session: bindHandler((session, args) => {
      const { sessionId, ...restoration } =
        RpcSessionRestorationArgsSchema.parse(args);
      return session.resume(sessionId, {
        ...restoration,
        signal: controller.signal,
      });
    }),
    resume_session: bindHandler((session, args) => {
      const { sessionId, ...restoration } =
        RpcSessionRestorationArgsSchema.parse(args);
      return session.resume(sessionId, {
        ...restoration,
        signal: controller.signal,
      });
    }),
    name_session: bindHandler((session, args) => {
      session.setName(String(args.name));
    }),
    set_metadata: bindHandler((session, args) => {
      session.setMetadata({
        ...(typeof args.name === "string" ? { name: args.name } : {}),
        ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}),
        ...(typeof args.archived === "boolean"
          ? { archived: args.archived }
          : {}),
      });
    }),
    navigate: bindHandler((session, args) =>
      session.navigate(
        args.entryId === null ? null : z.string().parse(args.entryId),
        {
          summary: typeof args.summary === "string" ? args.summary : undefined,
          signal: controller.signal,
        },
      ),
    ),
    label: bindHandler((session, args) => {
      session.setLabel(
        String(args.entryId),
        args.label === null ? null : z.string().parse(args.label),
      );
    }),
    fork: bindHandler((session, args) => session.fork(String(args.entryId))),
    clone: bindHandler((session) => session.clone()),
    import_session: bindHandler((session, args) =>
      session.import(
        String(args.data),
        typeof args.cwd === "string" ? args.cwd : session.cwd,
      ),
    ),
    export_session: bindHandler((session, args) =>
      session.export({
        scope: args.scope === "tree" ? "tree" : "active",
        format: args.format === "html" ? "html" : "jsonl",
        redact: args.redact !== false,
      }),
    ),
    export_session_begin: transferHandler((store, args) =>
      store.beginExport(args),
    ),
    import_session_begin: transferHandler((store, args) =>
      store.beginImport(args),
    ),
    read_transfer_chunk: transferHandler((store, args) => store.read(args)),
    write_transfer_chunk: transferHandler((store, args) =>
      store.writeChunk(args),
    ),
    finish_transfer: transferHandler((store, args) => store.finish(args)),
    cancel_transfer: transferHandler((store, args) => store.cancel(args)),
    get_model: bindHandler((session) => {
      const model = session.getModel();
      return {
        name: model.name,
        protocol: model.protocol,
        model: model.model,
        thinking: model.thinking,
        context_window: model.context_window,
        max_output_tokens: model.max_output_tokens,
      };
    }),
    set_model: bindHandler((session, args) => {
      if (args.provider) {
        const provider = invocation.config.providers.find(
          (entry) => entry.name === args.provider,
        );
        if (!provider) {
          throw new Error("Unknown provider");
        }
        return session.setModel({ ...provider, model: String(args.model) });
      }
      return session.setModel(String(args.model));
    }),
    get_thinking: bindHandler((session) => session.getThinking()),
    set_thinking: bindHandler((session, args) =>
      session.setThinking(
        z
          .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
          .parse(args.level),
      ),
    ),
    compact: bindHandler((session, args) =>
      session.compact(
        typeof args.instructions === "string" ? args.instructions : "",
      ),
    ),
    bash: bindHandler((session, args) =>
      session.userBash(String(args.command), {
        excludeFromContext: args.excludeFromContext === true,
      }),
    ),
    get_stats: bindHandler((session) => session.getStats()),
    get_retry_state: bindHandler((session) => session.getRetryState()),
    get_code_mode: bindHandler((session) => session.getCodeModeState()),
    stop_code_mode: bindHandler((session) => session.stopCodeMode()),
    get_warming_state: bindHandler((session) => session.getWarmingState()),
    stop_warming: bindHandler((session) => session.stopWarming()),
    resume_warming: bindHandler((session) => {
      session.resumeWarming();
    }),
    get_tasks: bindHandler((session) => session.getTasks()),
    stop_task: bindHandler((session, args) =>
      session.stopTask(String(args.taskId)),
    ),
    get_workflows: bindHandler((session) => session.getWorkflowState()),
    stop_workflow: bindHandler((session, args) =>
      session.stopWorkflow(String(args.runId)),
    ),
    get_mcp: bindHandler((session) => session.getMCPState()),
    mcp_resources: bindHandler((session, args) =>
      session.listMCPResources(String(args.server), {
        cursor: typeof args.cursor === "string" ? args.cursor : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      }),
    ),
    mcp_templates: bindHandler((session, args) =>
      session.listMCPResources(String(args.server), {
        templates: true,
        cursor: typeof args.cursor === "string" ? args.cursor : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      }),
    ),
    mcp_connect: bindHandler((session, args) =>
      session.connectMCPServer(String(args.server)),
    ),
    mcp_disconnect: bindHandler((session, args) =>
      session.disconnectMCPServer(String(args.server)),
    ),
    mcp_read: bindHandler((session, args) =>
      session.readMCPResource(String(args.server), String(args.uri)),
    ),
    mcp_register: bindHandler((session, args) =>
      session.registerMCPServer(MCPServerConfigSchema.parse(args.config)),
    ),
    mcp_unregister: bindHandler((session, args) =>
      session.unregisterMCPServer(String(args.server)),
    ),
    mcp_exposure: bindHandler((session, args) => {
      const exposure = z
        .enum(["direct", "deferred", "codemode", "hidden"])
        .parse(args.exposure);
      return session.setMCPExposure(
        String(args.server),
        exposure,
        typeof args.tool === "string"
          ? [{ tool: args.tool, exposure }]
          : undefined,
      );
    }),
    mcp_logout: bindHandler((session, args) =>
      session.logoutMCP(String(args.server)),
    ),
    diagnostics: bindHandler((session, args) =>
      session.diagnostics({
        includeTranscript: args.includeTranscript === true,
      }),
    ),
  };
  const host: RpcHost = {
    sessionId: () => active?.sessionId ?? manager.id,
    handlers,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    abort: async () => {
      controller.abort();
      await Promise.all([transfers?.dispose(), active?.abort("all")]);
    },
    dispose: async () => {
      await transfers?.dispose();
      try {
        const session = await ready;
        await session.dispose();
      } catch {
        /* Initialization releases its own resources. */
      }
    },
  };
  const server = new RpcServer(host, process.stdout);
  handlers.mcp_login = bindHandler((session, args) =>
    session.loginMCP(String(args.server), {
      signal: controller.signal,
      onAuthorization: async (url, submit) => {
        if (typeof args.callbackUrl === "string") {
          submit(args.callbackUrl);
          return;
        }
        const callback = await server.requestInteraction(
          "mcp_oauth",
          {
            authorizationUrl: url.href,
            instructions:
              "Open the URL and return the complete callback URL, or null for a loopback callback.",
          },
          z.union([z.url(), z.null()]),
          controller.signal,
        );
        if (callback) {
          submit(callback);
        }
      },
    }),
  );
  const factory: CreateAgentSessionOptions = {
    ...invocation,
    inputSource: "rpc",
    signal: controller.signal,
    onTrustRequest: (request) =>
      server.requestInteraction(
        "project_trust",
        request,
        z.enum(["once", "persistent", "deny"]),
        controller.signal,
      ),
    onPermissionRequest: (
      toolName,
      args,
      decision,
      toolCallId,
      signal,
      source,
    ) =>
      server.requestInteraction(
        "permission",
        { toolName, args, reason: decision.reason, toolCallId, source },
        z.enum(["allow", "deny", "allowAlways"]),
        signal ?? controller.signal,
      ),
    askUser: (questions, signal) =>
      server.requestInteraction(
        "ask_user",
        { questions },
        z.record(z.string(), z.string()),
        signal ?? controller.signal,
      ),
    planApproval: (request) =>
      server.requestInteraction(
        "plan_approval",
        { plan: request.plan },
        z.union([
          z.enum(["approve", "deny"]),
          z.strictObject({ feedback: z.string() }),
        ]),
        request.signal ?? controller.signal,
      ),
  };
  const onInterrupt = (): void => {
    process.exitCode = 130;
    void server.stop().catch(() => undefined);
  };
  const onTerminate = (): void => {
    process.exitCode = 143;
    void server.stop().catch(() => undefined);
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  const reading = server.run(process.stdin);
  const initialization = createAgentSession(factory).then(
    async ({ session }) => {
      active = session;
      session.subscribe((event: SessionEvent) => {
        if (event.type === "session_changed" || event.type === "disposed") {
          void transfers?.invalidate();
        }
        for (const listener of listeners) {
          listener(event);
        }
      });
      resolveReady(session);
      await server.emit({
        type: "initialized",
        sessionId: session.sessionId,
        cwd: session.cwd,
      });
    },
    async (error: unknown) => {
      rejectReady(error);
      process.exitCode = 1;
      await server.stop();
    },
  );
  try {
    await Promise.all([reading, initialization]);
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    await server.stop();
  }
}
