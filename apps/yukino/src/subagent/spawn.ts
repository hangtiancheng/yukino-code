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

import type { AgentDefinition } from "./definition.js";
import { formatAgentTaskNotification, TaskManager } from "./task-manager.js";
import { filterToolsForAgent } from "./tool-filter.js";

import { Agent, type AgentConfig } from "@/agent/index.js";
import { getContextWindow, getMaxOutputTokens, type ProviderConfig } from "@/config/index.js";
import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import { createClient } from "@/llm/client.js";
import { resolveModelId } from "@/llm/model-resolver.js";
import { loadInstructions } from "@/memory/instructions.js";
import { PermissionChecker } from "@/permissions/index.js";
import { buildSystemPrompt, detectEnvironment } from "@/prompt/builder.js";
import { buildSubagentInstructions } from "@/prompt/delegation.js";
import { FileStateCache } from "@/tools/file-state-cache.js";
import type { ToolRegistry } from "@/tools/registry.js";

/**
 * Marker appended to a subagent's output when its run was interrupted. Shared
 * with the UI so restored transcripts can render interrupted Agent cards with
 * the same "stopped" styling as live ones.
 */
export const SUBAGENT_INTERRUPTED_MARKER = "[Interrupted]";

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
  abortSignal?: AbortSignal;
  background?: boolean;
  onPermissionRequest?: AgentConfig["onPermissionRequest"];
  permissionMode?: PermissionChecker["mode"];
  conversation?: ConversationManager;
  /**
   * Whether this run gets a per-run background task manager (default true).
   * In-process teammate turns pass false: a teammate loop is one run per task
   * turn, so the turn-end stopAll() would immediately kill anything the
   * teammate backgrounded, and the drain disappears before any notification
   * could be delivered. Teammates stay purely foreground (matching the
   * subprocess teammate path); subagents they spawn themselves are unaffected.
   */
  backgroundTasks?: boolean;
}

export async function spawnSubagent(
  definition: AgentDefinition,
  prompt: string,
  parentClient: LLMClient,
  parentRegistry: ToolRegistry,
  parentProvider: ProviderConfig,
  workDir: string,
  onProgress?: (p: { turn?: number; lastTool?: string }) => void,
  onEvent?: AgentEventSink,
  modelOverride?: string,
  checkerOverride?: PermissionChecker,
  options: SubagentRunOptions = {},
): Promise<string> {
  options.abortSignal?.throwIfAborted();
  // Determine the model: call-level override > definition-level model > parent Agent's model

  const effectiveModel = modelOverride ?? definition.model;
  const resolvedModel = effectiveModel ? resolveModelId(effectiveModel) : parentProvider.model;
  const env = detectEnvironment(workDir);
  env.model = resolvedModel;
  const systemPrompt = definition.systemPromptOverride ?? buildSystemPrompt(env);
  const provider = {
    ...parentProvider,
    model: resolvedModel,
    thinking: parentClient.getThinkingLevel?.() ?? parentProvider.thinking,
  };
  const client: LLMClient =
    effectiveModel || definition.systemPromptOverride
      ? await createClient(provider, systemPrompt)
      : parentClient;

  // Build the subagent tool registry through multi-layer filtering
  const registry = options.conversation
    ? parentRegistry
    : filterToolsForAgent(
        parentRegistry,
        definition.tools,
        definition.disallowedTools,
        options.background ?? false,
      );
  // When a teammate runs in plan mode, the checker is created and held by the team layer:
  // after approval passes, the mode must be switched back to default in place. If the checker
  // were only instantiated here, the team layer would have no handle to modify it.
  const permMode =
    options.permissionMode === "plan"
      ? "plan"
      : (definition.permissionMode ?? options.permissionMode ?? "acceptEdits");
  const checker = checkerOverride ?? new PermissionChecker(workDir, permMode);
  const conversation = options.conversation ?? new ConversationManager();
  conversation.addSystemReminder(buildSubagentInstructions(definition));
  conversation.addUserMessage(prompt);

  // Per-run background task registry: Bash commands backgrounded inside this
  // subagent register here and notify this subagent's own loop (via
  // notificationFn below), not the main thread. Null when the caller opted out
  // (in-process teammate turns) — the explicit null also blocks the tools'
  // fallback to their host-wired instance manager.
  const taskManager = options.backgroundTasks === false ? null : new TaskManager();

  const agent = new Agent({
    client,
    registry,
    checker,
    conversation,
    workDir,
    maxIterations: definition.maxTurns ?? 200,
    abortSignal: options.abortSignal,
    onPermissionRequest: options.onPermissionRequest,
    fileStateCache: new FileStateCache(),
    instructions: loadInstructions(workDir),
    contextWindow: getContextWindow(provider),
    maxOutput: getMaxOutputTokens(provider),
    taskManager,
    notificationFn: taskManager
      ? () => taskManager.drainNotifications().map(formatAgentTaskNotification)
      : undefined,
  });

  let output = "";
  let turn = 0;
  try {
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
          return output || "[No output]";
        case "error":
          throw event.error;
      }
    }

    return output || "[No output]";
  } finally {
    // Kill background shells still running now that this loop (and its
    // notification drain) is going away — nobody would ever see their
    // completion, so they must not outlive the subagent. Awaited: the kill
    // itself is synchronous, but the runners' post-kill cleanup (sandbox
    // teardown, output-file unlink) and Windows' async taskkill would
    // otherwise race a prompt process exit.
    await taskManager?.stopAll();
  }
}
