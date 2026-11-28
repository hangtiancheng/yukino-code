import { createHash } from "node:crypto";

import { resolveInvocationProvider } from "@/bootstrap/invocation.js";
import type { AppConfig, ProviderConfig } from "@/config/index.js";
import type { ProjectContext } from "@/project/types.js";
import type { AgentRuntime } from "@/runtime/types.js";
import {
  SessionRuntimeStateSchema,
  type SessionRuntimeState,
} from "@/session/records.js";
import type { Tool } from "@/tools/types.js";

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function providerEndpointFingerprint(provider: ProviderConfig): string {
  const raw = provider.base_url ?? "";
  let endpoint = raw;
  if (raw) {
    try {
      endpoint = new URL(raw).href.replace(/\/+$/u, "");
    } catch {
      endpoint = raw;
    }
  }
  return fingerprint({ protocol: provider.protocol, endpoint });
}

function toolSourceFingerprint(
  runtime: AgentRuntime,
  project: ProjectContext | undefined,
  tool: Tool,
): string {
  if ("mcpServerName" in tool && typeof tool.mcpServerName === "string") {
    const manager = runtime.mcpManager;
    const state = manager?.state(tool.mcpServerName);
    if (!state || !manager) {
      throw new Error("MCP declaration is no longer available");
    }
    return fingerprint({
      category: tool.category,
      server: tool.mcpServerName,
      scope: state.source.scope,
      projectRoot: state.source.projectRoot,
      projectFingerprint:
        state.source.scope === "global" ? undefined : project?.fingerprint,
      config: manager.getServerConfig(tool.mcpServerName),
    });
  }
  return fingerprint({
    scope: "native",
    name: tool.name,
    category: tool.category,
  });
}

export function captureSessionRuntimeState(
  runtime: AgentRuntime,
  project?: ProjectContext,
): SessionRuntimeState {
  const tools = runtime.registry
    .snapshotDeclarations((tool) =>
      toolSourceFingerprint(runtime, project, tool),
    )
    .filter((tool) => runtime.toolFilter?.(tool.name) !== false);
  return SessionRuntimeStateSchema.parse({
    provider: {
      name: runtime.provider.name,
      protocol: runtime.provider.protocol,
      model: runtime.provider.model,
      endpointFingerprint: providerEndpointFingerprint(runtime.provider),
    },
    thinking:
      runtime.client.getThinkingLevel?.() ?? runtime.provider.thinking ?? "off",
    tools,
    discovered: tools
      .filter((tool) => runtime.registry.isDiscovered(tool.name))
      .map((tool) => tool.name),
  });
}

export function resolveSessionProvider(
  state: SessionRuntimeState,
  config: AppConfig,
  current?: ProviderConfig,
): ProviderConfig {
  const candidates = [...config.providers, ...(current ? [current] : [])];
  const index = candidates.findIndex(
    (provider) =>
      provider.name === state.provider.name &&
      provider.protocol === state.provider.protocol &&
      providerEndpointFingerprint(provider) ===
        state.provider.endpointFingerprint,
  );
  if (index < 0) {
    throw new Error(
      "Session provider target is unavailable; choose a configured provider explicitly",
    );
  }
  return resolveInvocationProvider(candidates, index, {
    model: state.provider.model,
    thinking: state.thinking,
  });
}

export function restoreSessionDeclarations(
  runtime: AgentRuntime,
  state: SessionRuntimeState,
  project?: ProjectContext,
  explicitTools = false,
): string[] {
  const declarations = new Map(
    runtime.registry
      .snapshotDeclarations((tool) =>
        toolSourceFingerprint(runtime, project, tool),
      )
      .map((tool) => [tool.name, tool]),
  );
  const unavailable = state.tools
    .filter((tool) => {
      const current = declarations.get(tool.name);
      return (
        current?.schemaFingerprint !== tool.schemaFingerprint ||
        current?.sourceFingerprint !== tool.sourceFingerprint
      );
    })
    .map((tool) => tool.name);
  if (!explicitTools) {
    const unavailableNames = new Set(unavailable);
    const allowed = state.tools
      .filter((tool) => !unavailableNames.has(tool.name))
      .map((tool) => tool.name);
    runtime.registry.setPolicy({
      ...runtime.registry.getPolicy(),
      allowlist: allowed,
    });
  }
  const discovered = new Set(state.discovered);
  const dropped = runtime.registry.restoreDiscovered(
    state.tools.filter((tool) => discovered.has(tool.name)),
    (tool) => toolSourceFingerprint(runtime, project, tool),
  );
  return [...new Set([...unavailable, ...dropped])];
}
