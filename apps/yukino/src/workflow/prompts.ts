import type { WorkflowRun } from "@/workflow/progress.js";
import type { WorkflowLaunch } from "@/workflow/service.js";

export const WORKFLOW_TOOL_PROMPT = `Execute a deterministic JavaScript script to orchestrate multiple subagents. Use when the user requests a workflow or multi-agent orchestration. Runs in the background and returns run_id plus task_id immediately; the final result arrives as a task notification. Use TaskOutput to inspect the background task, TaskStop to cancel it, or /workflows for live progress.

Provide script inline, name from .yukino/workflows/, or scriptPath. Every launch saves its source and JSON args for replay. resumeFromRunId alone reuses them; supply a source or args to override. Completed agent calls replay from the journal; divergent calls run again.

Scripts are AsyncFunction bodies, not ESM modules. No import, dynamic import, TypeScript syntax or extra exports. Optional export const meta = { name, description, phases: [{ title }] } must be a plain literal. Use a top-level return for the result. Date.now(), new Date() and Math.random() are disabled for replay; pass time and seeds in args. Scripts execute in the host process.

Injected primitives:
- agent(prompt, { schema?, model?, maxTokens?, agentType?, isolation?: 'worktree', allowedTools?, label?, phase? }): text or a schema-validated JSON value. A failed agent retries once then returns null; handle null explicitly. Permissions and role restrictions still apply. Worktree edits stay on their own branch.
- parallel([() => agent(...)]) waits for all thunks. Ordinary item errors become null.
- pipeline(items, ...stages) runs each item through its stages in order; items overlap without a barrier. A stage receives (previous, originalItem, index).
- phase(title), log(message), workflow(name | { scriptPath }, args) for one level of composition.
- args is the supplied JSON value; budget.total, budget.spent(), budget.remaining() expose output-token accounting.

Default concurrency is 3, ceiling 16. Omit maxConcurrency unless the user requests a different value. At most 1000 agent calls per run, 4096 items per parallel/pipeline. Prefer pipeline when downstream work only needs one item's result; use parallel for a true barrier. Return evidence and verify important findings before synthesis.`;

export const ULTRACODE_PROMPT = `Use the Workflow tool for the user's task, keeping the main agent responsible for scoping and integrating the result. Discover the work list first, then encode independent subtasks and verification in a plain JavaScript script. Prefer pipeline for per-item review then verification, and parallel when synthesis needs every result. Use JSON Schema for structured output and handle null agent results. Avoid concurrent writes to the same files; isolation:'worktree' keeps edits separate and does not merge them. Default concurrency is 3. The workflow runs in the background and notifies on completion; use /workflows to monitor it.

Example:
export const meta = { name: 'review', description: 'Review and verify changes', phases: [{ title: 'Review' }] }
phase('Review')
const results = await parallel(args.files.map(file => () => agent('Review ' + file, { label: file, agentType: 'review' })))
return results.filter(Boolean)

Do not import modules or use TypeScript syntax. Pass real JSON args. Every launch returns the saved script path for iteration. Resume with resumeFromRunId; completed agent calls replay without calling the model.`;

export function formatWorkflowLaunch(run: WorkflowLaunch): string {
  return `Workflow started in the background.\nrun_id: ${run.runId}\ntask_id: ${run.taskId}\nworkflow: ${run.workflowName}\nscript: ${run.scriptPath}\nYou will receive the result as a task notification. Use /workflows to view progress.`;
}
export function buildNamedWorkflowPrompt(name: string, args: string): string {
  return `Run the named workflow ${JSON.stringify(name)} by calling Workflow with name=${JSON.stringify(name)}.${args ? `\nUser arguments (convert to appropriate JSON args): ${args}` : ""}`;
}
export function formatWorkflowResult(run: WorkflowRun): string {
  return `run_id: ${run.runId}\nworkflow: ${run.workflowName}\nstatus: ${run.status}\n${run.error ?? (typeof run.returnValue === "string" ? run.returnValue : JSON.stringify(run.returnValue ?? null))}`;
}

export function buildStructuredOutputPrompt(
  prompt: string,
  schema: object,
): string {
  return `${prompt}\n\nAfter completing the task, end with a single JSON value matching this JSON Schema. Emit JSON as plain text; do not call a StructuredOutput or SyntheticOutput tool and do not add prose after the JSON.\n${JSON.stringify(schema)}`;
}

export const WORKFLOW_RULE =
  "Use Workflow when the user requests a workflow or multi-agent orchestration. Scripts run in the background; use the returned task_id with TaskOutput/TaskStop and integrate the completion notification. Default concurrency is 3. Subagent permissions still apply; avoid overlapping writes and handle null results.";
