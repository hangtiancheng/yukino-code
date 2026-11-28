import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { CommandRegistry } from "@/commands/commands.js";
import { getExecutionContext } from "@/cost/context.js";
import { createChildLogger } from "@/logger/index.js";
import { acquireSessionRunLease } from "@/session/lease.js";
import { loadAgentDefinitions } from "@/subagent/loader.js";
import { TaskFailure, type TaskManager } from "@/subagent/task-manager.js";
import type { ToolContext } from "@/tools/types.js";
import { asErrorString } from "@/utils/index.js";
import { AgentAdapterRegistry } from "@/workflow/agent-adapter.js";
import {
  createYukinoBackend,
  YukinoWorkflowHost,
  type WorkflowBackendOptions,
} from "@/workflow/backend.js";
import { clampMaxConcurrency } from "@/workflow/concurrency.js";
import {
  SCRIPT_FILENAME,
  WORKFLOW_DIR_NAME,
  WORKFLOW_RUNNING_ERROR,
  WORKFLOW_TIMEOUT_MS,
} from "@/workflow/constants.js";
import {
  createFileJournalStore,
  rebuildWorkflowJournal,
  workflowFingerprint,
} from "@/workflow/journal.js";
import {
  listNamedWorkflows,
  resolveNamedWorkflow,
} from "@/workflow/named-workflows.js";
import { containsPath } from "@/workflow/paths.js";
import { WorkflowPersistence } from "@/workflow/persistence.js";
import { createHostHandle, type JournalStore } from "@/workflow/ports.js";
import {
  WorkflowProgressStore,
  type WorkflowRun,
} from "@/workflow/progress.js";
import {
  buildNamedWorkflowPrompt,
  formatWorkflowResult,
} from "@/workflow/prompts.js";
import { runWorkflow } from "@/workflow/run-workflow.js";
import { workflowInputSchema, type WorkflowInput } from "@/workflow/schema.js";
import { parseScript } from "@/workflow/script.js";
import {
  assertBoundedWorkflowJson,
  WORKFLOW_VM_FINGERPRINT,
} from "@/workflow/vm.js";

const log = createChildLogger({ module: "workflow" });
export interface WorkflowLaunch {
  runId: string;
  taskId: string;
  workflowName: string;
  scriptPath: string;
}
interface ActiveRun {
  controller: AbortController;
  agents: Map<number, AbortController>;
  taskId?: string;
}
export interface WorkflowServiceOptions extends WorkflowBackendOptions {
  cwd: string;
  taskManager: TaskManager;
  persist?: boolean;
}

export class WorkflowService {
  readonly store = new WorkflowProgressStore();
  readonly persistence: WorkflowPersistence;
  private closed = false;
  private active = new Map<string, ActiveRun>();
  constructor(private options: WorkflowServiceOptions) {
    this.persistence = new WorkflowPersistence(options.cwd);
  }

  async launch(
    raw: WorkflowInput,
    context: ToolContext,
  ): Promise<WorkflowLaunch> {
    if (this.closed) {
      throw new Error("Workflow service is closed");
    }
    const startedAt = Date.now();
    const deadline = startedAt + WORKFLOW_TIMEOUT_MS;
    const input = workflowInputSchema.parse(raw);
    context.abortSignal?.throwIfAborted();
    const runId = input.resumeFromRunId ?? randomUUID();
    if (this.active.has(runId)) {
      throw new Error(WORKFLOW_RUNNING_ERROR);
    }
    const active: ActiveRun = {
      controller: new AbortController(),
      agents: new Map(),
    };
    const target =
      this.options.persist === false
        ? undefined
        : this.options.taskManager.getStorageTarget(context);
    if (!target && input.resumeFromRunId) {
      throw new Error("Workflow resume requires a persistent session");
    }
    const host = new YukinoWorkflowHost(
      context,
      getExecutionContext(),
      !!target,
      target,
    );
    const lease = target
      ? acquireSessionRunLease(target, "background")
      : undefined;
    this.active.set(runId, active);
    try {
      const previous = input.resumeFromRunId
        ? await this.persistence.readRequest(runId)
        : undefined;
      const source = await this.resolveSource(input);
      const parsed = parseScript(source);
      const workflowName =
        input.name ??
        input.title ??
        parsed.meta?.name ??
        previous?.workflowName ??
        "workflow";
      const args = input.args !== undefined ? input.args : previous?.args;
      const maxConcurrency = input.maxConcurrency ?? previous?.maxConcurrency;
      assertBoundedWorkflowJson(args ?? null);
      const provider = this.options.getProvider();
      const declarationFingerprint = workflowFingerprint({
        provider: {
          name: provider.name,
          model: provider.model,
          protocol: provider.protocol,
          endpoint: provider.base_url,
        },
        tools: this.options.registry.listTools().map((tool) => tool.schema()),
        policy: this.options.registry.getPolicy(),
        agents: loadAgentDefinitions(),
      });
      const memoryEntries: Awaited<ReturnType<JournalStore["read"]>> = [];
      const journalStore: JournalStore = target
        ? createFileJournalStore(this.persistence.directory)
        : {
            read: () => Promise.resolve([...memoryEntries]),
            append: (_id, entry) => {
              memoryEntries.push(structuredClone(entry));
              return Promise.resolve();
            },
          };
      if (input.resumeFromRunId) {
        const root = rebuildWorkflowJournal(await journalStore.read(runId)).get(
          "root",
        );
        if (
          root?.final?.status === "completed" &&
          root.header?.fingerprint ===
            workflowFingerprint({
              source,
              args: args ?? null,
              environment: {
                cwd: await realpath(this.options.cwd),
                maxConcurrency: clampMaxConcurrency(maxConcurrency),
                budgetTotal: null,
                declarations: declarationFingerprint,
              },
              runtime: WORKFLOW_VM_FINGERPRINT,
            })
        ) {
          await this.loadPersistedRuns();
          const completed = this.requireRun(runId);
          this.active.delete(runId);
          return {
            runId,
            taskId: completed.taskId,
            workflowName,
            scriptPath: completed.scriptPath,
          };
        }
      }
      const scriptPath = target
        ? await this.persistence.saveRequest(runId, source, {
            workflowName,
            args,
            maxConcurrency,
          })
        : (input.scriptPath ?? "");
      context.abortSignal?.throwIfAborted();
      active.controller.signal.throwIfAborted();
      const task = this.options.taskManager.create(
        input.description ?? workflowName,
        async () => {
          try {
            if (target) {
              await this.persistence.writeState(this.requireRun(runId));
            }
            const outcome = await runWorkflow({
              script: source,
              args,
              runId,
              workflowName,
              ports: {
                agentAdapterRegistry: new AgentAdapterRegistry()
                  .register(createYukinoBackend(this.options))
                  .default("yukino"),
                progressEmitter: {
                  emit: (event) => {
                    this.store.apply(event);
                  },
                },
                journalStore,
                logger: {
                  warn: (message) => {
                    log.warn(message);
                  },
                },
                agentControllers: active.agents,
              },
              host: createHostHandle(host),
              signal: active.controller.signal,
              cwd: this.options.cwd,
              budgetTotal: null,
              maxConcurrency,
              resume: !!input.resumeFromRunId,
              startedAt,
              deadline,
              declarationFingerprint,
            });
            if (this.requireRun(runId).status === "running") {
              this.store.set({ ...this.requireRun(runId), ...outcome });
            }
            const run = this.requireRun(runId);
            const output = formatWorkflowResult(run);
            if (target) {
              await this.persistence.writeState(run);
            }
            if (run.status === "failed") {
              throw new TaskFailure(output);
            }
            return output;
          } catch (error) {
            if (error instanceof TaskFailure) {
              throw error;
            }
            const event = {
              type: "run_done" as const,
              runId,
              status: active.controller.signal.aborted
                ? ("killed" as const)
                : ("failed" as const),
              error: asErrorString(error),
            };
            this.store.apply(event);
            const run = this.requireRun(runId);
            if (target) {
              await this.persistence
                .writeState(run)
                .catch((persistError: unknown) => {
                  log.error(
                    { err: persistError },
                    "workflow state write failed",
                  );
                });
            }
            throw new TaskFailure(formatWorkflowResult(run));
          } finally {
            this.active.delete(runId);
          }
        },
        () => {
          active.controller.abort();
        },
        {
          idPrefix: "workflow",
          kind: "workflow",
          context,
          originToolCallId: context.toolCallId,
        },
      );
      active.taskId = task.id;
      const persisted = this.store.get(runId);
      this.store.set({
        ...persisted,
        runId,
        taskId: task.id,
        workflowName,
        scriptPath,
        status: "running",
        startedAt,
        updatedAt: startedAt,
        phases:
          persisted?.phases ??
          parsed.meta?.phases?.map((phase) => ({
            title: phase.title,
            status: "pending" as const,
          })) ??
          [],
        description: parsed.meta?.description,
        agents: persisted?.agents ?? [],
        logs: persisted?.logs ?? [],
      });
      return { runId, taskId: task.id, workflowName, scriptPath };
    } catch (error) {
      this.active.delete(runId);
      throw error;
    } finally {
      lease?.release();
    }
  }

  private requireRun(runId: string): WorkflowRun {
    const run = this.store.get(runId);
    if (!run) {
      throw new Error(`Workflow run ${runId} not found`);
    }
    return run;
  }
  private async resolveSource(input: WorkflowInput): Promise<string> {
    if (input.script !== undefined) {
      return input.script;
    }
    if (input.name !== undefined) {
      const found = await resolveNamedWorkflow(
        join(this.options.cwd, WORKFLOW_DIR_NAME),
        input.name,
      );
      if (!found) {
        throw new Error(
          `Named workflow "${input.name}" not found in ${WORKFLOW_DIR_NAME}`,
        );
      }
      return found.content;
    }
    if (input.scriptPath !== undefined) {
      const path = await realpath(resolve(this.options.cwd, input.scriptPath));
      if (
        !containsPath(await realpath(this.options.cwd), path) &&
        !containsPath(
          await realpath(this.persistence.directory).catch(
            () => this.persistence.directory,
          ),
          path,
        )
      ) {
        throw new Error(
          "Workflow scriptPath is outside the project and workflow storage",
        );
      }
      return readFile(path, "utf8");
    }
    if (!input.resumeFromRunId) {
      throw new Error("Workflow source is required");
    }
    return readFile(
      this.persistence.path(input.resumeFromRunId, SCRIPT_FILENAME),
      "utf8",
    );
  }

  kill(runId: string): boolean {
    const active = this.active.get(runId);
    return active?.taskId
      ? this.options.taskManager.stop(active.taskId)
      : false;
  }
  killAgent(runId: string, agentId: number): boolean {
    const controller = this.active.get(runId)?.agents.get(agentId);
    if (!controller) {
      return false;
    }
    controller.abort();
    return true;
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.active.values()].map(async (run) => {
        if (run.taskId) {
          await this.options.taskManager.stopAndWait(run.taskId);
        } else {
          run.controller.abort();
        }
      }),
    );
  }
  async loadPersistedRuns(): Promise<void> {
    if (this.options.persist === false) {
      return;
    }
    for (const run of await this.persistence.list()) {
      if (this.store.get(run.runId)) {
        continue;
      }
      this.store.set(
        run.status === "running"
          ? {
              ...run,
              status: "killed",
              error: "Workflow interrupted before shutdown",
              agents: run.agents.map((agent) =>
                agent.status === "running"
                  ? { ...agent, status: "cancelled" }
                  : agent,
              ),
            }
          : run,
      );
    }
  }
  async registerNamedCommands(registry: CommandRegistry): Promise<void> {
    const names = await listNamedWorkflows(
      join(this.options.cwd, WORKFLOW_DIR_NAME),
    );
    for (const name of names) {
      if (!registry.find(name)) {
        registry.register({
          name,
          type: "prompt",
          description: `Run workflow: ${name}`,
          resource: "workflow",
          handler: (context) => buildNamedWorkflowPrompt(name, context.args),
        });
      }
    }
  }
  async command(args: string, context: ToolContext): Promise<string> {
    const [action, runId] = args.trim().split(/\s+/u);
    if (action === "stop" && runId) {
      return this.kill(runId)
        ? `Workflow ${runId} stopped`
        : `Workflow ${runId} is not running`;
    }
    if (action === "resume" && runId) {
      const run = await this.launch({ resumeFromRunId: runId }, context);
      return `Workflow resumed: run_id=${run.runId} task_id=${run.taskId}`;
    }
    await this.loadPersistedRuns();
    const runs = this.store.getSnapshot();
    if (action && action !== "list") {
      const run = this.store.get(action);
      if (!run) {
        throw new Error(`Workflow run ${action} not found`);
      }
      return formatWorkflowResult(run);
    }
    return runs.length
      ? runs
          .map(
            (run) =>
              `${run.runId} | ${run.workflowName} | ${run.status} | ${run.agents.length} agents | task_id=${run.taskId}`,
          )
          .join("\n")
      : "No workflow runs";
  }
}
