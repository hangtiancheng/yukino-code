import { z } from "zod";

import { MAX_WORKFLOW_LOGS } from "./constants.js";
import type { ProgressEvent } from "./types.js";

export const workflowRunSchema = z.object({
  runId: z.string(),
  taskId: z.string(),
  workflowName: z.string(),
  scriptPath: z.string(),
  status: z.enum(["running", "completed", "failed", "killed"]),
  startedAt: z.number(),
  updatedAt: z.number(),
  description: z.string().optional(),
  phases: z.array(
    z.object({
      title: z.string(),
      status: z.enum(["pending", "running", "done"]),
    }),
  ),
  agents: z.array(
    z.object({
      id: z.number(),
      label: z.string().optional(),
      phase: z.string().optional(),
      status: z.enum(["running", "done", "cancelled"]),
      resultKind: z.string().optional(),
      tokenCount: z.number(),
      toolCount: z.number(),
      model: z.string().optional(),
      detail: z.string().optional(),
    }),
  ),
  logs: z.array(z.string()),
  returnValue: z.unknown().optional(),
  error: z.string().optional(),
});
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export class WorkflowProgressStore {
  private runs = new Map<string, WorkflowRun>();
  private listeners = new Set<() => void>();
  private snapshot: WorkflowRun[] = [];
  getSnapshot = (): WorkflowRun[] => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }
  set(run: WorkflowRun): void {
    this.runs.set(run.runId, run);
    this.snapshot = [...this.runs.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
    for (const listener of this.listeners) {
      listener();
    }
  }
  apply(event: ProgressEvent): void {
    const previous = this.runs.get(event.runId);
    if (!previous) {
      return;
    }
    const run: WorkflowRun = {
      ...previous,
      updatedAt: Date.now(),
      phases: previous.phases.map((phase) => ({ ...phase })),
      agents: previous.agents.map((agent) => ({ ...agent })),
    };
    switch (event.type) {
      case "run_started":
        run.workflowName = event.workflowName;
        run.description = event.meta?.description;
        run.phases =
          event.meta?.phases?.map((phase) => ({
            title: phase.title,
            status: "pending",
          })) ?? [];
        break;
      case "phase_started": {
        const phase = run.phases.find((item) => item.title === event.phase);
        if (phase) {
          phase.status = "running";
        } else {
          run.phases.push({ title: event.phase, status: "running" });
        }
        break;
      }
      case "phase_done":
        for (const phase of run.phases) {
          if (phase.title === event.phase) {
            phase.status = "done";
          }
        }
        break;
      case "agent_started":
      case "agent_done": {
        let agent = run.agents.find((item) => item.id === event.agentId);
        if (!agent) {
          agent = {
            id: event.agentId,
            label: event.label,
            phase: event.phase,
            status: "running",
            tokenCount: 0,
            toolCount: 0,
          };
          run.agents.push(agent);
        }
        if (event.type === "agent_done") {
          agent.status = "done";
          agent.resultKind = event.result.kind;
          if (event.result.kind === "ok") {
            agent.tokenCount = event.result.tokenCount ?? 0;
            agent.toolCount = event.result.toolCount ?? 0;
            agent.model = event.result.model;
          } else if (event.result.kind === "dead") {
            agent.detail = event.result.detail;
          }
        }
        break;
      }
      case "agent_progress": {
        const agent = run.agents.find((item) => item.id === event.agentId);
        if (agent) {
          agent.tokenCount = event.tokenCount;
          agent.toolCount = event.toolCount;
        }
        break;
      }
      case "log":
        run.logs = [...run.logs, event.message].slice(-MAX_WORKFLOW_LOGS);
        break;
      case "run_done":
        run.status = event.status;
        run.returnValue = event.returnValue;
        run.error = event.error;
        for (const agent of run.agents) {
          if (agent.status === "running") {
            agent.status = "cancelled";
          }
        }
        break;
    }
    this.set(run);
  }
}
