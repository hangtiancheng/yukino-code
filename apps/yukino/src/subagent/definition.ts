import type { PermissionMode } from "@/permissions/index.js";

export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  systemPromptOverride?: string;
  maxTurns?: number;
  model?: string;
  permissionMode?: PermissionMode;
  background?: boolean;
  isolation?: "worktree";
  initialPrompt?: string;
  omitMarkdown?: boolean;
  skills?: string[];
  memory?: boolean;
  mcpServers?: string[];
}

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
    disallowedTools: ["EditFile", "WriteFile"],
    permissionMode: "plan",
  },
  {
    name: "explore",
    description:
      "Find code, trace relevant call paths, and report evidence with file paths and line numbers. Use Glob, Grep, ReadFile, and read-only shell commands. Do not modify files; return missing context or blockers to the parent agent.",
    disallowedTools: ["EditFile", "WriteFile"],
    permissionMode: "plan",
    model: "deepseek-flash",
  },
];
