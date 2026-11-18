// Package workflow mirrors src/workflow: deterministic multi-agent workflow
// scripts executed on an embedded JavaScript engine.
package workflow

import "regexp"

const WorkflowToolName = "Workflow"

const WorkflowDirName = ".yukino/workflows"

const WorkflowRunsDir = "workflow-runs"

var WorkflowScriptExtensions = []string{".ts", ".js", ".mjs"}

const DefaultMaxConcurrency = 3

const MaxConcurrencyCap = 16

const MaxTotalAgents = 1000

const MaxItemsPerCall = 4096

var RunIDRe = regexp.MustCompile(`^[a-zA-Z0-9][\w-]{0,127}$`)

const JournalFilename = "journal.jsonl"
const ScriptFilename = "script.js"
const RequestFilename = "request.json"
const StateFilename = "state.json"
const MaxVisibleRuns = 20
const MaxWorkflowLogs = 100
const WorkflowCommandDescription = "Monitor, stop and resume workflow runs"
const WorkflowPanelTitle = "Workflows"
const WorkflowPanelEmpty = "No workflow runs. Launch one with Workflow or /ultracode."
const WorkflowPanelHint = "Tab run · ↑↓ agent · x stop agent · K stop run · r resume · Esc close"
const WorkflowRunningError = "This workflow run is already running"

const WorkflowPanelCompactHint = "Tab · ↑↓ · x/K · r · Esc close"
