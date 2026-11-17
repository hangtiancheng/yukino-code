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
  readOnly?: boolean;
  background?: boolean;
  worktree?: boolean;
  initialPrompt?: string;
}
