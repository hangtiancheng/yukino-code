import { existsSync } from "node:fs";

import { Agent, type AgentConfig } from "@/agent/index.js";
import {
  getContextWindow,
  getMaxOutputTokens,
  type ProviderConfig,
} from "@/config/provider-config.js";
import { ConversationManager } from "@/conversation/index.js";
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
import { sessionPath } from "@/storage/index.js";
import {
  NO_OUTPUT_MARKER,
  SUBAGENT_ERROR_RECORD_TYPE,
  SUBAGENT_INTERRUPTED_MARKER,
  TRANSCRIPT_FILENAME,
} from "@/subagent/constants.js";
import type { AgentDefinition } from "@/subagent/definition.js";
import { formatAgentTaskNotification } from "@/subagent/prompts.js";
import { TaskManager } from "@/subagent/task-manager.js";
import { filterToolsForAgent } from "@/subagent/tool-filter.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import type { ToolRegistry } from "@/tools/registry.js";
import { asErrorString } from "@/utils/index.js";

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
  // Determine the model: call-level override > definition-level model > parent Agent's model
  const effectiveModel = modelOverride ?? definition.model;
  const resolvedModel = effectiveModel ?? parentProvider.model;
  const env = detectEnvironment(cwd);
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
  const sessionId = options.sessionId ?? newSessionId();
  const transcriptPath = sessionPath(sessionId, TRANSCRIPT_FILENAME);
  const taskManager =
    options.backgroundTasks === false ? null : new TaskManager(sessionId);
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
    const initialMessages = existsSync(transcriptPath)
      ? conversation.getMessages().slice(-1)
      : conversation.getMessages();
    for (const message of initialMessages) {
      saveTranscriptMessage(transcriptPath, {
        ...messageToKeptRecord(message),
        timestamp: Math.floor(Date.now() / 1000),
      });
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

    for await (const event of agent.run()) {
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
    saveTranscriptMessage(transcriptPath, {
      role: "system",
      type: SUBAGENT_ERROR_RECORD_TYPE,
      content: detail,
      timestamp: Math.floor(Date.now() / 1000),
    });
    throw new Error(
      `${detail}${output ? `\n\nPartial output:\n${output}` : ""}\n\nTranscript: ${transcriptPath}`,
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
      if (!options.conversation) {
        await registry.dispose();
      }
    }
  }
}
