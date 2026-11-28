import { loadInvocation } from "@/bootstrap/invocation.js";
import type { InvocationOptions } from "@/cli.js";
import type { CreateAgentSessionOptions } from "@/sdk/types.js";
import { listSessions } from "@/session/index.js";
import { SessionManager } from "@/session/manager.js";

export async function prepareInvocationSession(options: InvocationOptions) {
  const { cwd, config, configPath, systemPrompt } =
    await loadInvocation(options);
  const sessionId = options.continue
    ? listSessions(cwd)[0]?.id
    : options.sessionId;
  if (options.continue && !sessionId) {
    throw new Error("No session is available to continue");
  }
  const sessionManager = sessionId
    ? SessionManager.open(cwd, sessionId)
    : SessionManager.create(cwd, { persist: options.persist });
  if (options.name) {
    sessionManager.setName(options.name);
  }
  return {
    cwd,
    config,
    configPath,
    sessionManager,
    persist: options.persist,
    overrides: {
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinking ? { thinking: options.thinking } : {}),
    },
    systemPrompt:
      options.systemPrompt !== undefined ||
      options.systemPromptFile ||
      options.appendSystemPromptFile
        ? systemPrompt
        : undefined,
    thinking: options.thinking,
    tools: options.tools,
    exclude: options.excludeTools,
    permissions: options.permissionMode ?? config.permission_mode ?? "default",
    trust: options.trustProject ? "once" : undefined,
    disabled: options.noProjectResources,
  } satisfies CreateAgentSessionOptions;
}
