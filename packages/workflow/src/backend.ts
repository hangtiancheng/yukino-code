import type { ProviderConfig } from "@yukino.js/config/provider-config.js";
import type { LLMClient } from "@yukino.js/llm/client.js";
import { createChildLogger } from "@yukino.js/logger";
import { PermissionChecker } from "@yukino.js/permissions";
import { BUILTIN_AGENTS } from "@yukino.js/subagent/constants.js";
import { loadAgentDefinitions } from "@yukino.js/subagent/loader.js";
import { spawnSubagent } from "@yukino.js/subagent/spawn.js";
import { filterToolsForAgent } from "@yukino.js/subagent/tool-filter.js";
import type { ToolRegistry } from "@yukino.js/tools/registry.js";
import type { ToolContext } from "@yukino.js/tools/types.js";
import { asErrorString } from "@yukino.js/utils";
import {
  createAgentWorktree,
  hasWorktreeChanges,
  removeAgentWorktree,
} from "@yukino.js/worktree";
import { buildWorktreeNotice } from "@yukino.js/worktree/prompts.js";

import type { AgentAdapter } from "./agent-adapter.js";
import { unwrapHostHandle } from "./ports.js";
import { buildStructuredOutputPrompt } from "./prompts.js";

const log = createChildLogger({ module: "workflow-backend" });

export interface WorkflowBackendOptions {
  registry: ToolRegistry;
  getClient(): LLMClient;
  getProvider(): ProviderConfig;
}

export function extractStructuredOutput(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    /* Look for JSON in the final response. */
  }
  const candidates: string[] = [];
  for (const match of text.matchAll(/```[\w-]*\s*\n([\s\S]*?)\n?```/gu)) {
    candidates.push(match[1]);
  }
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{" && text[start] !== "[") {
      continue;
    }
    const stack: string[] = [];
    let quoted = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (char === "\\") {
          end++;
        } else if (char === '"') {
          quoted = false;
        }
        continue;
      }
      if (char === '"') {
        quoted = true;
      } else if (char === "{" || char === "[") {
        stack.push(char);
      } else if (char === "}" || char === "]") {
        if (stack.pop() !== (char === "}" ? "{" : "[")) {
          break;
        }
        if (stack.length === 0) {
          candidates.push(text.slice(start, end + 1));
          start = end;
          break;
        }
      }
    }
  }
  for (const candidate of candidates.reverse()) {
    try {
      const value: unknown = JSON.parse(candidate);
      return value;
    } catch {
      continue;
    }
  }
  throw new Error("Workflow agent produced no valid JSON output");
}

export class YukinoWorkflowHost {
  constructor(readonly context: ToolContext) {}
}

export function createYukinoBackend(
  options: WorkflowBackendOptions,
): AgentAdapter {
  return {
    id: "yukino",
    capabilities: { structuredOutput: true, tools: true },
    async run(params, context) {
      const bundle = unwrapHostHandle(context.host);
      if (!(bundle instanceof YukinoWorkflowHost)) {
        throw new Error("Invalid Yukino workflow host");
      }
      const host = bundle.context;
      const provider = options.getProvider();
      const client = options.getClient();
      const definition =
        loadAgentDefinitions().find(
          (agent) => agent.name === params.agentType,
        ) ?? BUILTIN_AGENTS[0];
      const checker =
        host.permissionChecker ??
        new PermissionChecker(host.cwd, host.approvedPermissionMode);
      let worktree: Awaited<ReturnType<typeof createAgentWorktree>> | undefined;
      let registry: ToolRegistry | undefined;
      let outputTokens = 0;
      let tokenCount = 0;
      let toolCount = 0;
      try {
        context.signal.throwIfAborted();
        if (params.isolation === "worktree") {
          try {
            worktree = await createAgentWorktree(
              `wf_${context.runId}_${context.agentId}`,
              undefined,
              host.cwd,
            );
          } catch (error) {
            return {
              kind: "dead",
              reason: "worktree-failed",
              detail: asErrorString(error),
            };
          }
        }
        registry = filterToolsForAgent(
          options.registry,
          params.allowedTools,
          undefined,
          true,
        );
        const output = await spawnSubagent(
          definition,
          [
            worktree ? buildWorktreeNotice(host.cwd, worktree.path) : "",
            params.schema
              ? buildStructuredOutputPrompt(params.prompt, params.schema)
              : params.prompt,
          ]
            .filter(Boolean)
            .join("\n\n"),
          client,
          registry,
          provider,
          worktree?.path ?? host.cwd,
          undefined,
          (event) => {
            if (event.type === "usage") {
              outputTokens += event.usage.outputTokens;
              tokenCount = event.usage.inputTokens + event.usage.outputTokens;
            }
            if (event.type === "tool_use") {
              toolCount++;
            }
            context.onProgress?.({ tokenCount, toolCount });
          },
          params.model,
          worktree ? await checker.forWorktree(worktree) : checker,
          {
            abortSignal: context.signal,
            background: true,
            onPermissionRequest: host.onPermissionRequest,
            maxOutputTokens: params.maxTokens,
          },
        );
        context.signal.throwIfAborted();
        let result: unknown = output;
        if (params.schema) {
          try {
            result = extractStructuredOutput(output);
          } catch (error) {
            return {
              kind: "dead",
              reason: "no-structured-output",
              detail: asErrorString(error),
            };
          }
        }
        return {
          kind: "ok",
          output: result,
          usage: { outputTokens },
          tokenCount,
          toolCount,
          model: params.model ?? definition.model ?? provider.model,
        };
      } finally {
        await registry?.dispose();
        if (
          worktree &&
          !(await hasWorktreeChanges(worktree.path, worktree.headCommit))
        ) {
          try {
            await removeAgentWorktree(
              worktree.path,
              worktree.branch,
              worktree.gitRoot,
            );
          } catch (error) {
            log.warn(
              { err: error, path: worktree.path },
              "workflow worktree cleanup failed",
            );
          }
        } else if (worktree) {
          log.info(
            { path: worktree.path, branch: worktree.branch },
            "workflow worktree retained",
          );
        }
      }
    },
  };
}
