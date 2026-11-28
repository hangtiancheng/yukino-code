import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { Agent, type AgentConfig } from "@/agent/index.js";
import {
  getContextWindow,
  getMaxOutputTokens,
  type ProviderConfig,
} from "@/config/provider-config.js";
import { ConversationManager } from "@/conversation/index.js";
import {
  bindExecutionContext,
  getExecutionContext,
  registerExecutionContext,
  withExecutionContext,
  type ExecutionContext,
} from "@/cost/context.js";
import { createCostLedger } from "@/cost/ledger.js";
import type { LLMClient } from "@/llm/client.js";
import { createClient } from "@/llm/client.js";
import { loadInstructions } from "@/memory/instructions.js";
import { PermissionChecker } from "@/permissions/index.js";
import { buildSystemPrompt, detectEnvironment } from "@/prompt/builder.js";
import { buildSubagentInstructions } from "@/prompt/prompts.js";
import {
  messageToKeptRecord,
  newSessionId,
  saveTranscriptMessage,
} from "@/session/index.js";
import {
  acquireSessionRunLease,
  inspectSessionStoragePath,
  sessionStorageIdentity,
  withSessionStorageLock,
  type SessionRunLeaseHandle,
  type SessionStorageTarget,
} from "@/session/lease.js";
import {
  ensureSessionHeaderUnderLock,
  parseSessionJsonl,
  readSessionDocument,
} from "@/session/records.js";
import { sessionPath } from "@/storage/index.js";
import {
  NO_OUTPUT_MARKER,
  SUBAGENT_ERROR_RECORD_TYPE,
  SUBAGENT_INTERRUPTED_MARKER,
  TRANSCRIPT_FILENAME,
} from "@/subagent/constants.js";
import type { AgentDefinition } from "@/subagent/definition.js";
import { formatAgentTaskNotification } from "@/subagent/prompts.js";
import {
  registerSessionStorageTarget,
  hasEphemeralSessionStorage,
  resolveSessionStorageTarget,
  TaskManager,
} from "@/subagent/task-manager.js";
import { filterToolsForAgent } from "@/subagent/tool-filter.js";
import { withFileSyncLock } from "@/teams/file-lock.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import type { ToolRegistry } from "@/tools/registry.js";
import { asErrorString } from "@/utils/index.js";
import { canonicalPath } from "@/utils/paths.js";

export type SubagentProgressEvent =
  | {
      type: "tool_use";
      toolId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | { type: "tool_result"; toolId: string }
  | { type: "usage"; usage: { inputTokens: number; outputTokens: number } }
  | { type: "turn_complete" };

export type AgentEventSink = (event: SubagentProgressEvent) => void;

export interface SubagentRunOptions {
  maxOutputTokens?: number;
  sessionId?: string;
  executionContext?: ExecutionContext;
  purpose?: "subagent" | "workflow";
  persist?: boolean;
  storageTarget?: SessionStorageTarget;
  cleanupArtifacts?: boolean;
  memoryContent?: string;
  agentName?: string;
  abortSignal?: AbortSignal;
  background?: boolean;
  onPermissionRequest?: AgentConfig["onPermissionRequest"];
  permissionMode?: PermissionChecker["mode"];
  /** Persistent teammate history; the caller supplies its scoped registry. */
  conversation?: ConversationManager;
  /** Inherited context for a definition run; definition tool restrictions still apply. */
  contextSnapshot?: ConversationManager;
  /**
   * Whether this run gets a per-run background task manager (default true).
   * In-process teammate turns pass false: a teammate loop is one run per task
   * turn, so the turn-end stopAll() would immediately kill anything the
   * teammate backgrounded, and the drain disappears before any notification
   * could be delivered. Teammates stay purely foreground and do not expose the Agent tool.
   */
  backgroundTasks?: boolean;
}

export async function spawnSubagent(
  definition: AgentDefinition,
  prompt: string,
  parentClient: LLMClient,
  parentRegistry: ToolRegistry,
  parentProvider: ProviderConfig,
  cwd: string,
  onProgress?: (p: { turn?: number; lastTool?: string }) => void,
  onEvent?: AgentEventSink,
  modelOverride?: string,
  checkerOverride?: PermissionChecker,
  options: SubagentRunOptions = {},
): Promise<string> {
  options.abortSignal?.throwIfAborted();
  const parent = options.executionContext ?? getExecutionContext();
  const sessionId = options.sessionId ?? newSessionId();
  if (
    options.persist === undefined &&
    parent &&
    hasEphemeralSessionStorage(parent)
  ) {
    options = { ...options, persist: false };
  }
  const leases: SessionRunLeaseHandle[] = [];
  try {
    if (options.persist !== false) {
      const target =
        options.storageTarget ??
        resolveSessionStorageTarget({ cwd, sessionId }, parent);
      if (!target) {
        throw new Error(
          "Subagent execution requires the root session storage target",
        );
      }
      if (!parent && !options.storageTarget) {
        withSessionStorageLock(target, (identity) => {
          inspectSessionStoragePath(
            identity.storageRoot,
            identity.transcriptPath,
          );
          ensureSessionHeaderUnderLock(identity.transcriptPath);
        });
      }
      leases.push(
        acquireSessionRunLease(
          target,
          options.background ? "background" : "foreground",
        ),
      );
      const identity = sessionStorageIdentity(target);
      const childProjectPath = sessionStorageIdentity({
        cwd,
        sessionId,
      }).transcriptPath;
      if (
        childProjectPath !== identity.transcriptPath &&
        inspectSessionStoragePath(identity.storageRoot, childProjectPath)
      ) {
        leases.push(
          acquireSessionRunLease(
            { cwd, sessionId },
            options.background ? "background" : "foreground",
          ),
        );
      }
      const artifactPath = canonicalPath(
        sessionPath(sessionId, TRANSCRIPT_FILENAME),
      );
      inspectSessionStoragePath(identity.storageRoot, artifactPath);
      inspectSessionStoragePath(identity.storageRoot, `${artifactPath}.lock`);
      withFileSyncLock(artifactPath, () => {
        const child = inspectSessionStoragePath(
          identity.storageRoot,
          artifactPath,
        );
        if (
          child &&
          (!child.bytes ||
            parseSessionJsonl(child.bytes.toString("utf8")).header.sessionId !==
              "transcript")
        ) {
          throw new Error("Invalid subagent artifact transcript");
        }
        ensureSessionHeaderUnderLock(artifactPath);
      });
      options = { ...options, storageTarget: target };
    }
    return await runSubagent(
      definition,
      prompt,
      parentClient,
      parentRegistry,
      parentProvider,
      cwd,
      onProgress,
      onEvent,
      modelOverride,
      checkerOverride,
      { ...options, sessionId },
    );
  } finally {
    for (const lease of leases.reverse()) {
      lease.release();
    }
  }
}

async function runSubagent(
  definition: AgentDefinition,
  prompt: string,
  parentClient: LLMClient,
  parentRegistry: ToolRegistry,
  parentProvider: ProviderConfig,
  cwd: string,
  onProgress: ((p: { turn?: number; lastTool?: string }) => void) | undefined,
  onEvent: AgentEventSink | undefined,
  modelOverride: string | undefined,
  checkerOverride: PermissionChecker | undefined,
  options: SubagentRunOptions,
): Promise<string> {
  const parent = options.executionContext ?? getExecutionContext();
  const sessionId = options.sessionId ?? newSessionId();
  const ledger =
    parent?.ledger ?? createCostLedger({ sessionId, persist: false });
  registerSessionStorageTarget(
    ledger,
    options.persist === false ? null : (options.storageTarget ?? null),
  );
  registerSessionStorageTarget(
    ledger,
    options.persist === false ? null : (options.storageTarget ?? null),
    sessionId,
  );
  const executionContext: ExecutionContext = {
    sessionId: ledger.sessionId,
    runId: randomUUID(),
    parentRunId: parent?.runId,
    agentId: sessionId,
    purpose:
      options.purpose ??
      (parent?.purpose === "workflow" ? "workflow" : "subagent"),
    ledger,
  };
  options.abortSignal?.throwIfAborted();
  if (parent) {
    registerExecutionContext(parent);
  }
  registerExecutionContext(executionContext);
  // Determine the model: call-level override > definition-level model > parent Agent's model
  const effectiveModel = modelOverride ?? definition.model;
  const resolvedModel = effectiveModel ?? parentProvider.model;
  const env = detectEnvironment(cwd, { skipGit: true });
  env.model = resolvedModel;
  const systemPrompt =
    definition.systemPromptOverride ?? buildSystemPrompt(env);
  const provider = {
    ...parentProvider,
    max_output_tokens:
      options.maxOutputTokens ?? parentProvider.max_output_tokens,
    model: resolvedModel,
    thinking: parentClient.getThinkingLevel?.() ?? parentProvider.thinking,
  };
  const client: LLMClient =
    effectiveModel || definition.systemPromptOverride
      ? await createClient(provider, systemPrompt)
      : parentClient;

  // Persistent teammates reuse their prepared registry. One-shot runs apply
  // role restrictions equally to inherited and fresh conversations.
  const registry = options.conversation
    ? parentRegistry
    : filterToolsForAgent(
        parentRegistry,
        definition.tools,
        definition.disallowedTools,
        options.background ?? false,
        checkerOverride?.teammate
          ? checkerOverride.mode
          : definition.permissionMode,
      );
  const transcriptPath =
    options.persist === false
      ? ""
      : sessionPath(sessionId, TRANSCRIPT_FILENAME);
  const taskManager =
    options.backgroundTasks === false
      ? null
      : new TaskManager(
          options.persist === false ? undefined : sessionId,
          cwd,
          options.persist === false ? null : options.storageTarget,
        );
  let output = "";
  let submittedPlan: string | undefined;
  let turn = 0;
  try {
    const inheritedChecker =
      checkerOverride ?? new PermissionChecker(cwd, options.permissionMode);
    const checker = inheritedChecker.teammate
      ? inheritedChecker.forCwd(cwd)
      : inheritedChecker.forSubagent(cwd, definition.permissionMode);
    checker.readOnly ||= definition.readOnly ?? false;
    const conversation =
      options.conversation ??
      options.contextSnapshot ??
      new ConversationManager();
    const initialize = conversation.getMessages().length === 0;
    if (initialize && options.conversation && options.contextSnapshot) {
      conversation.appendMessages(options.contextSnapshot.getMessages());
    }
    if (!options.conversation || initialize) {
      conversation.addSystemReminder(buildSubagentInstructions(definition));
    }
    conversation.addUserMessage(prompt);
    const initialMessages =
      transcriptPath && readSessionDocument(transcriptPath)?.records.length
        ? conversation.getMessages().slice(-1)
        : conversation.getMessages();
    if (transcriptPath) {
      for (const message of initialMessages) {
        saveTranscriptMessage(transcriptPath, {
          ...messageToKeptRecord(message),
          timestamp: Math.floor(Date.now() / 1000),
        });
      }
    }

    const agent = new Agent({
      agentName: options.agentName ?? definition.name,
      client,
      registry,
      checker,
      conversation,
      cwd,
      sessionId,
      transcriptPath,
      maxIterations: definition.maxTurns,
      abortSignal: options.abortSignal,
      onPermissionRequest: options.onPermissionRequest,
      fileStateCache: new FileStateCache(),
      instructions: loadInstructions(cwd),
      memoryContent: options.memoryContent,
      contextWindow: getContextWindow(provider),
      maxOutput: getMaxOutputTokens(provider),
      taskManager,
      notificationFn: taskManager
        ? () =>
            taskManager.drainNotifications().map(formatAgentTaskNotification)
        : undefined,
    });

    const iterator = withExecutionContext(executionContext, () =>
      bindExecutionContext(agent.run(), executionContext),
    );
    for await (const event of iterator) {
      switch (event.type) {
        case "stream_text":
          output += event.text;
          break;
        case "tool_use":
          onProgress?.({ lastTool: event.toolName });
          onEvent?.({
            type: "tool_use",
            toolId: event.toolId,
            toolName: event.toolName,
            args: event.args,
          });
          break;
        case "tool_result":
          if (event.toolName === "ExitPlanMode" && !event.isError) {
            submittedPlan = event.output;
          }
          onEvent?.({
            type: "tool_result",
            toolId: event.toolId,
          });
          break;
        case "usage":
          onEvent?.({
            type: "usage",
            usage: {
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
            },
          });
          break;
        case "turn_complete":
          onProgress?.({ turn: ++turn });
          onEvent?.({ type: "turn_complete" });
          break;
        case "loop_complete":
          if (event.stopReason === "interrupted") {
            return `${output}${output ? "\n\n" : ""}${SUBAGENT_INTERRUPTED_MARKER}`;
          }
          return submittedPlan
            ? `${output}${output ? "\n\n" : ""}${submittedPlan}`
            : output || NO_OUTPUT_MARKER;
        case "error":
          throw event.error;
      }
    }

    return output || NO_OUTPUT_MARKER;
  } catch (error) {
    const detail = asErrorString(error);
    if (transcriptPath) {
      saveTranscriptMessage(transcriptPath, {
        role: "system",
        type: SUBAGENT_ERROR_RECORD_TYPE,
        content: detail,
        timestamp: Math.floor(Date.now() / 1000),
      });
    }
    throw new Error(
      `${detail}${output ? `\n\nPartial output:\n${output}` : ""}${transcriptPath ? `\n\nTranscript: ${transcriptPath}` : ""}`,
      { cause: error },
    );
  } finally {
    // Kill background shells still running now that this loop (and its
    // notification drain) is going away — nobody would ever see their
    // completion, so they must not outlive the subagent. Awaited: the kill
    // itself is synchronous, but the runners' post-kill cleanup (sandbox
    // teardown, output-file unlink) and Windows' async taskkill would
    // otherwise race a prompt process exit.
    try {
      await taskManager?.stopAll();
    } finally {
      try {
        if (!options.conversation) {
          await registry.dispose();
        }
      } finally {
        if (options.persist === false && options.cleanupArtifacts !== false) {
          await rm(sessionPath(sessionId), { recursive: true, force: true });
        }
      }
    }
  }
}
