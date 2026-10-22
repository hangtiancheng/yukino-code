import type { AgentDefinition } from "@/subagent/definition.js";
import {
  EXPLORE_AGENT_DESCRIPTION,
  GENERAL_PURPOSE_AGENT_DESCRIPTION,
  PLAN_AGENT_DESCRIPTION,
  PLAN_TEAMMATE_DESCRIPTION,
  REVIEW_AGENT_DESCRIPTION,
} from "@/subagent/prompts.js";

/** Default role, independent of context inheritance. */
export const GENERAL_PURPOSE_AGENT_TYPE = "general-purpose";
export const PLAN_AGENT_NAME = "plan";
export const EXPLORE_AGENT_NAME = "explore";
export const REVIEW_AGENT_NAME = "review";

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: GENERAL_PURPOSE_AGENT_TYPE,
    description: GENERAL_PURPOSE_AGENT_DESCRIPTION,
  },
  {
    name: PLAN_AGENT_NAME,
    description: PLAN_AGENT_DESCRIPTION,
    disallowedTools: ["EditFile", "WriteFile", "ExitPlanMode"],
    permissionMode: "plan",
    readOnly: true,
  },
  {
    name: EXPLORE_AGENT_NAME,
    description: EXPLORE_AGENT_DESCRIPTION,
    disallowedTools: ["EditFile", "WriteFile", "ExitPlanMode"],
    permissionMode: "plan",
    readOnly: true,
  },
  {
    name: REVIEW_AGENT_NAME,
    description: REVIEW_AGENT_DESCRIPTION,
    disallowedTools: ["EditFile", "WriteFile", "ExitPlanMode"],
  },
];

export const AGENT_KINDS = ["subagent", "teammate"] as const;
export const DEFAULT_AGENT_KIND = "teammate";

// Markdown agent definitions under ~/.yukino/agents override built-ins.
export const AGENTS_DIR_NAME = "agents";
export const AGENT_FILE_EXTENSION = ".md";
export const FRONTMATTER_BLOCK_RE =
  /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;
/** Body prefix used as the description when frontmatter omits one. */
export const MAX_FALLBACK_DESCRIPTION_CHARS = 200;

export const PLAN_TEAMMATE_AGENT: AgentDefinition = {
  name: PLAN_AGENT_NAME,
  description: PLAN_TEAMMATE_DESCRIPTION,
  permissionMode: "plan",
};

export const PLAN_AGENT_UNAVAILABLE_ERROR =
  "The built-in plan agent is unavailable.";
export const FORK_CONTEXT_REQUIRED_ERROR =
  "Forking requires parent conversation context. Set fork to false to start a fresh conversation.";
export const EMPTY_PLAN_ERROR = "The plan agent returned no plan.";

export const AGENT_ARGS_REQUIRED_ERROR =
  "Error: description and prompt are required";
export const AGENT_KIND_INVALID_ERROR =
  "Error: kind must be subagent or teammate";
export const AGENT_WORKTREE_INVALID_ERROR = "Error: worktree must be a boolean";
export const AGENT_FORK_INVALID_ERROR = "Error: fork must be a boolean";
export const AGENT_BACKGROUND_INVALID_ERROR =
  "Error: run_in_background must be a boolean";
export const TEAMMATE_NO_TEAM_ERROR =
  "Error: teammate execution is unavailable; no team was created.";
export const TEAMMATE_UNAVAILABLE_ERROR =
  "Error: teammate execution is unavailable.";
export const TEAMMATE_RUNNER_UNAVAILABLE_ERROR =
  "Error: teammate runner is unavailable.";

/**
 * Marker appended to a subagent's output when its run was interrupted. Shared
 * with the UI so restored transcripts can render interrupted Agent cards with
 * the same "stopped" styling as live ones.
 */
export const SUBAGENT_INTERRUPTED_MARKER = "[Interrupted]";

/** Output returned when a subagent run produced no text. */
export const NO_OUTPUT_MARKER = "[No output]";

export const TRANSCRIPT_FILENAME = "transcript.jsonl";
/** Transcript record type written when a subagent run fails. */
export const SUBAGENT_ERROR_RECORD_TYPE = "subagent_error";

// Finished tasks kept in memory (with their outputs) before the oldest are
// evicted; see TaskManager.pruneCompleted.
export const MAX_RETAINED_FINISHED_TASKS = 200;

export const DEFAULT_TASK_ID_PREFIX = "agent";
export const TASK_STOPPED_OUTPUT = "Stopped by user";
export const TASK_RESTORE_INTERRUPTED_ERROR =
  "Task interrupted before completion (session restored)";
export const TASKS_PENDING_SESSION_SWITCH_ERROR =
  "Stop and await tasks before switching their session";
export const TASKS_PENDING_CLEAR_ERROR =
  "Stop and await tasks before clearing their manager";
export const MAX_TASK_WAIT_TIMEOUT_MS = 60_000;
export const TASK_WAIT_TIMEOUT_RANGE_ERROR = `Task wait timeout must be between 0 and ${String(MAX_TASK_WAIT_TIMEOUT_MS)}ms`;
export const TASK_WAIT_INTERRUPTED_ERROR = "Task wait interrupted";
export const MAX_TEAMMATE_NAME_CHARS = 30;

export const BACKGROUND_TASKS_DIR_NAME = "background-tasks";
export const TASK_RECORD_EXTENSION = ".json";
export const TASK_RECORD_TMP_SUFFIX = ".tmp";

type AllTools =
  | "InstallSkill"
  | "LoadSkill"
  | "Agent"
  | "TaskStop"
  | "TodoWrite"
  | "TaskOutput"
  | "LSP"
  | "TeamCreate"
  | "SendMessage"
  | "TeamList"
  | "TeamDelete"
  | "SyntheticOutput"
  | "AskUserQuestion"
  | "Bash"
  | "PowerShell"
  | "ComputerUse"
  | "EditFile"
  | "EnterPlanMode"
  | "EnterWorktree"
  | "ExitPlanMode"
  | "ExitWorktree"
  | "ReadFile"
  | "ToolSearch"
  | "WriteFile"
  | "Glob"
  | "Goal"
  | "Grep"
  | "WebFetch"
  | "McpCall";

// Tools that only work correctly on the main thread: each depends on main-thread
// UI state or a singleton device, so it is stripped from every delegated agent —
// with or without inherited context.
//   ComputerUse     — drives the physical screen/mouse/keyboard; delegated agents
//                     would fight over one device.
//   AskUserQuestion — prompts through a single modal dialog; a delegated agent
//                     would hijack it and race parallel siblings (the loser hangs).
//   EnterPlanMode — only the main agent can initiate a planning phase.
//   ExitPlanMode  — excluded by default; plan definitions can submit a plan.
export const MAIN_AGENT_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "ComputerUse",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "Goal",
] satisfies readonly AllTools[]);

/** `tools: ["*"]` in an agent definition disables the whitelist layer. */
export const ALL_TOOLS_WILDCARD = "*";

// Global list of tools disallowed for subagents — MAIN_AGENT_ONLY_TOOLS plus
// delegation-policy restrictions (recursive Agent spawning and team authority).
// TaskStop only controls owned tasks;
// delegated agents never inherit leader messaging or team lifecycle authority.
const SUBAGENT_EXTRA_TOOLS = [
  "Agent",
  "TeamCreate",
  "TeamDelete",
  "SendMessage",
] satisfies readonly AllTools[];
export const SUBAGENT_DISALLOWED_TOOLS: ReadonlySet<string> = new Set([
  ...MAIN_AGENT_ONLY_TOOLS,
  ...SUBAGENT_EXTRA_TOOLS,
]);

export const ASYNC_AGENT_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "TodoWrite",
  "TaskOutput",
  "TaskStop",
  "LSP",
  "ReadFile",
  "WebFetch",
  "Grep",
  "Glob",
  "Bash",
  "PowerShell",
  "EditFile",
  "WriteFile",
  "LoadSkill",
  "SyntheticOutput",
  "ToolSearch",
  "EnterWorktree",
  "ExitWorktree",
  // ToolSearch only reads out schemas; actual invocation relies on McpCall.
  // The two must be allowed together, or the subagent sees tools but cannot call them
  "McpCall",
] satisfies readonly AllTools[]);
