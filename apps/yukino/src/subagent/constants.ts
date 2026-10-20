import type { AgentDefinition } from "@/subagent/definition.js";

export const FORK_AGENT: AgentDefinition = {
  name: "fork",
  description:
    "Complete the assigned task using the inherited conversation context.",
  maxTurns: 200,
};

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: "general-purpose",
    description:
      "General-purpose agent for researching complex questions, exploring codebase, and executing multi-step tasks.",
  },
  {
    name: "plan",
    description:
      "Investigate the existing architecture and propose a concrete implementation plan with relevant files, constraints, and verification steps. Read-only: do not create, edit, or delete files. Return unresolved questions to the parent agent.",
    disallowedTools: ["EditFile", "WriteFile", "ExitPlanMode"],
    permissionMode: "plan",
    readOnly: true,
  },
  {
    name: "explore",
    description:
      "Find code, trace relevant call paths, and report evidence with file paths and line numbers. Use Glob, Grep, ReadFile, and read-only shell commands. Do not modify files; return missing context or blockers to the parent agent.",
    disallowedTools: ["EditFile", "WriteFile", "ExitPlanMode"],
    permissionMode: "plan",
    readOnly: true,
  },
  {
    name: "review",
    description:
      "Review pull requests for correctness, project conventions, performance, test coverage, and security. Read the diff and relevant code, then return concise findings with file paths, line numbers, impact, and suggested improvements. Do not modify files or publish reviews; return missing context or blockers to the parent.",
    disallowedTools: ["EditFile", "WriteFile", "ExitPlanMode"],
  },
];

/** Fallback target when subagent_type is omitted and fork is disabled */
export const GENERAL_PURPOSE_AGENT_TYPE = "general-purpose";

// Leading marker for forked child Agents — used for nested fork detection
export const FORK_BOILERPLATE_TAG = "<fork_boilerplate>";

/**
 * Marker appended to a subagent's output when its run was interrupted. Shared
 * with the UI so restored transcripts can render interrupted Agent cards with
 * the same "stopped" styling as live ones.
 */
export const SUBAGENT_INTERRUPTED_MARKER = "[Interrupted]";

// Finished tasks kept in memory (with their outputs) before the oldest are
// evicted; see TaskManager.pruneCompleted.
export const MAX_RETAINED_FINISHED_TASKS = 200;

type AllTools =
  | "InstallSkill"
  | "LoadSkill"
  | "Agent"
  | "TaskStop"
  | "TaskCreate"
  | "TaskGet"
  | "TaskList"
  | "TaskUpdate"
  | "TodoWrite"
  | "TaskOutput"
  | "LSP"
  | "TeamCreate"
  | "SendMessage"
  | "ListTeams"
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
// both forks (cloneRegistryForFork) and defined subagents (via the spread below).
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

// Global list of tools disallowed for subagents — MAIN_AGENT_ONLY_TOOLS plus
// delegation-policy restrictions (recursive Agent spawning and team authority).
// Forks keep Agent (as a tagged clone). TaskStop only controls owned tasks;
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
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
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

export const FORK_QUERY_SOURCE = "agent:builtin:fork";
