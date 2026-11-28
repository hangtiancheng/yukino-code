import type { ProviderConfig } from "@/config/provider-config.js";
import {
  getExecutionContext,
  registerExecutionContext,
  type ExecutionContext,
} from "@/cost/context.js";
import { createCostLedger } from "@/cost/ledger.js";
import type { LLMClient } from "@/llm/client.js";
import { createChildLogger } from "@/logger/index.js";
import { PermissionChecker } from "@/permissions/index.js";
import type { SessionStorageTarget } from "@/session/lease.js";
import { BUILTIN_AGENTS } from "@/subagent/constants.js";
import { loadAgentDefinitions } from "@/subagent/loader.js";
import { spawnSubagent } from "@/subagent/spawn.js";
import { resolveSessionStorageTarget } from "@/subagent/task-manager.js";
import { filterToolsForAgent } from "@/subagent/tool-filter.js";
import type { ToolRegistry } from "@/tools/registry.js";
import type { ToolContext } from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";
import { extractJsonOutput } from "@/utils/json.js";
import type { AgentAdapter } from "@/workflow/agent-adapter.js";
import { unwrapHostHandle } from "@/workflow/ports.js";
import { buildStructuredOutputPrompt } from "@/workflow/prompts.js";
import {
  createAgentWorktree,
  hasWorktreeChanges,
  removeAgentWorktree,
} from "@/worktree/index.js";
import { buildWorktreeNotice } from "@/worktree/prompts.js";

const log = createChildLogger({ module: "workflow-backend" });

export interface WorkflowBackendOptions {
  registry: ToolRegistry;
  getClient(): LLMClient;
  getProvider(): ProviderConfig;
}

export class YukinoWorkflowHost {
  constructor(
    readonly context: ToolContext,
    readonly executionContext = getExecutionContext(),
    readonly persist = !!resolveSessionStorageTarget(context, executionContext),
    readonly storageTarget: SessionStorageTarget | undefined = persist
      ? resolveSessionStorageTarget(context, executionContext)
      : undefined,
  ) {
    if (persist && !storageTarget) {
      throw new Error("Workflow requires the root session storage target");
    }
  }
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
      const rootLedger =
        bundle.executionContext?.ledger ??
        createCostLedger({
          sessionId: host.sessionId ?? context.runId,
          cwd: host.cwd,
          persist: false,
        });
      const provider = options.getProvider();
      const client = options.getClient();
      const definitions = loadAgentDefinitions();
      const definition = params.agentType
        ? definitions.find((agent) => agent.name === params.agentType)
        : BUILTIN_AGENTS[0];
      if (!definition) {
        throw new Error(`Unknown Workflow agentType: ${params.agentType}`);
      }
      if (
        params.allowedTools?.some(
          (name) => name !== "*" && !options.registry.get(name),
        )
      ) {
        throw new Error("Workflow allowedTools contains an unknown tool");
      }
      const roleAllowed = definition.tools;
      const allowedTools = params.allowedTools
        ? params.allowedTools.includes("*")
          ? roleAllowed
          : roleAllowed && !roleAllowed.includes("*")
            ? params.allowedTools.filter((name) => roleAllowed.includes(name))
            : params.allowedTools
        : roleAllowed;
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
          allowedTools,
          definition.disallowedTools,
          true,
        );
        if (allowedTools && !allowedTools.includes("*")) {
          for (const tool of registry.listTools()) {
            if (!allowedTools.includes(tool.name)) {
              registry.unregister(tool.name);
            }
          }
        }
        if (bundle.executionContext) {
          registerExecutionContext(bundle.executionContext);
        }
        const executionContext: ExecutionContext = {
          sessionId: rootLedger.sessionId,
          runId: context.runId,
          parentRunId: bundle.executionContext?.runId,
          agentId: String(context.agentId),
          purpose: "workflow",
          ledger: rootLedger,
        };
        registerExecutionContext(executionContext);
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
            persist: bundle.persist,
            storageTarget: bundle.storageTarget,
            purpose: "workflow",
            executionContext,
          },
        );
        context.signal.throwIfAborted();
        let result: unknown = output;
        if (params.schema) {
          try {
            result = extractJsonOutput(output);
          } catch (error) {
            return {
              kind: "dead",
              reason: "no-structured-output",
              detail: asErrorString(error),
              usage: { outputTokens },
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
      } catch (error) {
        return context.signal.aborted
          ? { kind: "skipped", usage: { outputTokens } }
          : {
              kind: "dead",
              reason: "run-agent-threw",
              detail: asErrorString(error),
              usage: { outputTokens },
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
