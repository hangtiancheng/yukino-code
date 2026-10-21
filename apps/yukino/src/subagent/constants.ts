import type { AgentDefinition } from "@/subagent/definition.js";
import { PLAN_TEAMMATE_DESCRIPTION } from "@/subagent/prompts.js";

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

/** Default role, independent of context inheritance. */
export const GENERAL_PURPOSE_AGENT_TYPE = "general-purpose";
export const AGENT_KINDS = ["subagent", "teammate"] as const;
export const DEFAULT_AGENT_KIND = "teammate";

export const PLAN_TEAMMATE_AGENT: AgentDefinition = {
  name: "plan",
  description: PLAN_TEAMMATE_DESCRIPTION,
  permissionMode: "plan",
};

export const PLAN_AGENT_UNAVAILABLE_ERROR =
  "The built-in plan agent is unavailable.";
export const FORK_CONTEXT_REQUIRED_ERROR =
  "Forking requires parent conversation context. Set fork to false to start a fresh conversation.";
export const EMPTY_PLAN_ERROR = "The plan agent returned no plan.";

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
