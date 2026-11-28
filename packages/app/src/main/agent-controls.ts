import { AgentControlSchema } from "@main/agent-control-schema";
import type {
  AgentControl,
  AgentState,
  QueuedMessage,
} from "@shared/agent-types";
import {
  assertBoundedJson,
  contentToText,
  getWorkflowService,
  type AgentSession,
} from "@yukino.js/yukino";

export function projectQueue(
  entries: ReturnType<AgentSession["getQueue"]>,
  originalText?: (id: string) => string | undefined,
): QueuedMessage[] {
  return entries.map(({ attachments, ...entry }) => ({
    ...entry,
    text: (originalText?.(entry.id) ?? entry.text).slice(0, 1024),
    attachmentCount: attachments?.length ?? 0,
  }));
}

export function snapshotAgent(
  session: AgentSession,
  originalText?: (id: string) => string | undefined,
): AgentState {
  const labels = new Map<string, string>();
  const visit = (nodes: ReturnType<AgentSession["getTree"]>): void => {
    for (const node of nodes) {
      if (node.label) {
        labels.set(node.entry.entryId, node.label);
      }
      visit(node.children);
    }
  };
  visit(session.getTree());
  const active = new Set(
    session.sessionManager.getActiveEntries().map((entry) => entry.entryId),
  );
  return {
    sessionId: session.sessionId,
    busy: session.isBusy,
    metadata: session.getMetadata(),
    entries: session
      .getEntries()
      .filter((entry) => !entry.message.type)
      .map((entry) => ({
        id: entry.entryId,
        parentId: entry.parentId,
        role: entry.message.role,
        text: contentToText(entry.message.content).slice(0, 400),
        label: labels.get(entry.entryId),
        active: active.has(entry.entryId),
      })),
    queue: projectQueue(session.getQueue(), originalText),
    queueModes: session.getQueueModes(),
    retry: session.getRetryState(),
    status: session.getStatus(),
    stats: session.getStats({ sessionId: session.sessionId }),
    attempts: session
      .getCostEntries({ sessionId: session.sessionId })
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 50)
      .map(
        ({
          attempt,
          attemptId,
          purpose,
          startedAt,
          endedAt,
          outcome,
          usage,
          estimate,
          providerAmount,
          provider,
        }) => ({
          attempt,
          attemptId,
          purpose,
          startedAt,
          endedAt,
          outcome,
          usage,
          estimate,
          providerAmount,
          model: provider.model,
        }),
      ),
    codeMode: session.getCodeModeState(),
    mcp: session.getMCPState(),
    sources: session.getProjectSources(),
    preferences: session.getSettings(),
  };
}

export async function controlAgent(
  session: AgentSession,
  input: AgentControl,
  authorize: (url: URL, submitCallback: (url: string) => void) => Promise<void>,
): Promise<unknown> {
  assertBoundedJson(input);
  const action = AgentControlSchema.parse(input);
  switch (action.type) {
    case "reload":
      return session.reloadResources();
    case "settings":
      return session.setSettings(action.patch, { persist: action.persist });
    case "metadata": {
      session.setMetadata(action.metadata);
      return;
    }
    case "label": {
      session.setLabel(action.entryId, action.label);
      return;
    }
    case "navigate":
      return session.navigate(action.entryId, { summary: action.summary });
    case "fork":
      return session.fork(action.entryId);
    case "clone":
      return session.clone();
    case "compact":
      return session.compact(action.instructions);
    case "clear_queue":
      return projectQueue(session.clearQueue(action.kind));
    case "queue_mode": {
      session.setQueueMode(action.kind, action.mode);
      return;
    }
    case "auto_retry": {
      session.setAutoRetry(action.enabled);
      return;
    }
    case "auto_compaction": {
      session.setAutoCompaction(action.enabled);
      return;
    }
    case "abort_retry":
      return session.abortRetry();
    case "abort":
      return session.abort(action.scope);
    case "cycle_model":
      return session.cycleModel(action.direction);
    case "cycle_thinking":
      return session.cycleThinkingLevel(action.direction);
    case "warming": {
      if (action.enabled) {
        session.resumeWarming();
      } else {
        await session.stopWarming();
      }
      return;
    }
    case "stop_code":
      return session.stopCodeMode();
    case "revoke_trust":
      return session.revokeProjectTrust();
    case "mcp_register":
      return session.registerMCPServer(action.config);
    case "mcp_connect":
      return session.connectMCPServer(action.server);
    case "mcp_disconnect":
      return session.disconnectMCPServer(action.server);
    case "mcp_reload":
      return session.reloadMCPServer(action.server, action.config);
    case "mcp_remove":
      return session.unregisterMCPServer(action.server);
    case "mcp_logout":
      return session.logoutMCP(action.server);
    case "mcp_login":
      return session.loginMCP(action.server, { onAuthorization: authorize });
    case "mcp_exposure":
      return session.setMCPExposure(
        action.server,
        action.exposure,
        action.rules,
      );
    case "mcp_resources":
      return session.listMCPResources(action.server, {
        templates: action.templates,
        cursor: action.cursor,
      });
    case "mcp_read":
      return session.readMCPResource(action.server, action.uri);
    case "workflow_run": {
      const { name } = action.input;
      if (
        name &&
        session.runtime.cmdRegistry.find(name)?.resource !== "workflow"
      ) {
        throw new Error("The named workflow is unavailable in this project");
      }
      const run = await session.runWorkflow(action.input);
      return { runId: run.runId, taskId: run.taskId };
    }
    case "workflow_stop":
      if (!session.stopWorkflow(action.id)) {
        throw new Error("The workflow is no longer running");
      }
      return;
    case "workflow_stop_agent":
      if (
        !getWorkflowService(session.runtime.registry)?.killAgent(
          action.id,
          action.agentId,
        )
      ) {
        throw new Error("The workflow agent is no longer running");
      }
      return;
    default:
      throw new Error("Unknown agent control");
  }
}
