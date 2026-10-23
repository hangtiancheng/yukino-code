export const WORKFLOW_TOOL_NAME = "Workflow";

export const WORKFLOW_DIR_NAME = ".yukino/workflows";

export const WORKFLOW_RUNS_DIR = "workflow-runs";

export const WORKFLOW_SCRIPT_EXTENSIONS = [".ts", ".js", ".mjs"] as const;

export const DEFAULT_MAX_CONCURRENCY = 3;

export const MAX_CONCURRENCY_CAP = 16;

export const MAX_TOTAL_AGENTS = 1000;

export const MAX_ITEMS_PER_CALL = 4096;

export const RUN_ID_RE = /^[a-zA-Z0-9][\w-]{0,127}$/u;
export const JOURNAL_FILENAME = "journal.jsonl";
export const SCRIPT_FILENAME = "script.js";
export const REQUEST_FILENAME = "request.json";
export const STATE_FILENAME = "state.json";
export const MAX_VISIBLE_RUNS = 20;
export const MAX_WORKFLOW_LOGS = 100;
export const WORKFLOW_COMMAND_DESCRIPTION =
  "Monitor, stop and resume workflow runs";
export const WORKFLOW_PANEL_TITLE = "Workflows";
export const WORKFLOW_PANEL_EMPTY =
  "No workflow runs. Launch one with Workflow or /ultracode.";
export const WORKFLOW_PANEL_HINT =
  "Tab run · ↑↓ agent · x stop agent · K stop run · r resume · Esc close";
export const WORKFLOW_RUNNING_ERROR = "This workflow run is already running";
