package workflow

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/yukino-js/yukino/yukino/internal/prompt"
)

// jsonString mirrors JSON.stringify: no HTML escaping, keys as provided.
func jsonString(value any) string {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "null"
	}
	return string(bytes.TrimRight(buf.Bytes(), "\n"))
}

const WorkflowToolPrompt = `Execute a deterministic JavaScript script to orchestrate multiple subagents. Use when the user requests a workflow or multi-agent orchestration. Runs in the background and returns run_id plus task_id immediately; the final result arrives as a task notification. Use TaskOutput to inspect the background task, TaskStop to cancel it, or /workflows for live progress.

Provide script inline, name from .yukino/workflows/, or scriptPath. Every launch saves its source and JSON args for replay. resumeFromRunId alone reuses them; supply a source or args to override. Completed agent calls replay from the journal; divergent calls run again.

Scripts are AsyncFunction bodies, not ESM modules. No import, dynamic import, TypeScript syntax or extra exports. Optional export const meta = { name, description, phases: [{ title }] } must be a plain literal. Use a top-level return for the result. Date.now(), new Date() and Math.random() are disabled for replay; pass time and seeds in args. Scripts execute in the host process.

Injected primitives:
- agent(prompt, { schema?, model?, maxTokens?, agentType?, isolation?: 'worktree', allowedTools?, label?, phase? }): text or a schema-validated JSON value. A failed agent retries once then returns null; handle null explicitly. Permissions and role restrictions still apply. Worktree edits stay on their own branch.
- parallel([() => agent(...)]) waits for all thunks. Ordinary item errors become null.
- pipeline(items, ...stages) runs each item through its stages in order; items overlap without a barrier. A stage receives (previous, originalItem, index).
- phase(title), log(message), workflow(name | { scriptPath }, args) for one level of composition.
- args is the supplied JSON value; budget.total, budget.spent(), budget.remaining() expose output-token accounting.

Default concurrency is 3, ceiling 16. Omit maxConcurrency unless the user requests a different value. At most 1000 agent calls per run, 4096 items per parallel/pipeline. Prefer pipeline when downstream work only needs one item's result; use parallel for a true barrier. Return evidence and verify important findings before synthesis.`

const UltracodePrompt = `Use the Workflow tool for the user's task, keeping the main agent responsible for scoping and integrating the result. Discover the work list first, then encode independent subtasks and verification in a plain JavaScript script. Prefer pipeline for per-item review then verification, and parallel when synthesis needs every result. Use JSON Schema for structured output and handle null agent results. Avoid concurrent writes to the same files; isolation:'worktree' keeps edits separate and does not merge them. Default concurrency is 3. The workflow runs in the background and notifies on completion; use /workflows to monitor it.

Example:
export const meta = { name: 'review', description: 'Review and verify changes', phases: [{ title: 'Review' }] }
phase('Review')
const results = await parallel(args.files.map(file => () => agent('Review ' + file, { label: file, agentType: 'review' })))
return results.filter(Boolean)

Do not import modules or use TypeScript syntax. Pass real JSON args. Every launch returns the saved script path for iteration. Resume with resumeFromRunId; completed agent calls replay without calling the model.`

// WorkflowLaunch is the handle returned by a successful launch.
type WorkflowLaunch struct {
	RunID        string
	TaskID       string
	WorkflowName string
	ScriptPath   string
}

func FormatWorkflowLaunch(run *WorkflowLaunch) string {
	return fmt.Sprintf("Workflow started in the background.\nrun_id: %s\ntask_id: %s\nworkflow: %s\nscript: %s\nYou will receive the result as a task notification. Use /workflows to view progress.",
		run.RunID, run.TaskID, run.WorkflowName, run.ScriptPath)
}

func BuildNamedWorkflowPrompt(name, args string) string {
	encodedName := jsonString(name)
	if args != "" {
		return fmt.Sprintf("Run the named workflow %s by calling Workflow with name=%s.\nUser arguments (convert to appropriate JSON args): %s", encodedName, encodedName, args)
	}
	return fmt.Sprintf("Run the named workflow %s by calling Workflow with name=%s.", encodedName, encodedName)
}

func FormatWorkflowResult(run *WorkflowRun) string {
	detail := run.Error
	if detail == "" {
		if text, ok := run.ReturnValue.(string); ok {
			detail = text
		} else {
			detail = jsonString(run.ReturnValue)
		}
	}
	return fmt.Sprintf("run_id: %s\nworkflow: %s\nstatus: %s\n%s", run.RunID, run.WorkflowName, run.Status, detail)
}

// BuildStructuredOutputPrompt appends the schema JSON to the prompt. The
// schema is passed as raw JSON text so the key order the script author wrote
// survives (JSON.stringify semantics); callers fall back to jsonString for
// map-shaped schemas.
func BuildStructuredOutputPrompt(prompt, schemaJSON string) string {
	return fmt.Sprintf("%s\n\nAfter completing the task, end with a single JSON value matching this JSON Schema. Emit JSON as plain text; do not call a StructuredOutput or SyntheticOutput tool and do not add prose after the JSON.\n%s", prompt, schemaJSON)
}

// SchemaJSON renders a schema map as JSON text.
func SchemaJSON(schema map[string]any) string { return jsonString(schema) }

// WorkflowRule lives in the prompt package (the tool-guidance builder consumes
// it); the reference keeps it in workflow/prompts.ts and imports it from there.
const WorkflowRule = prompt.WORKFLOW_RULE
