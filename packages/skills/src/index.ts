import type { ToolContext } from "@yukino.js/tools/types.js";

// Submodule namespaces for library consumers (Skills.<Sub>.*).
export * from "./catalog.js";
export * from "./constants.js";
export * from "./executor.js";
export * from "./install-skill-tool.js";
export * from "./load-skill-tool.js";
export * from "./prompts.js";

export interface SkillMeta {
  name: string;
  description: string;
  mode?: "inline" | "fork"; // defaults to "inline"
  model?: string;
  forkContext?: "full" | "recent" | "none";
}

export interface Skill {
  meta: SkillMeta;
  body: string;
  sourceDir: string;
}

export interface SkillHost {
  activateSkill(name: string, body: string): void;
}

export interface SkillForkHost extends SkillHost {
  runSubagent(
    prompt: string,
    abortSignal?: AbortSignal,
    context?: ToolContext,
  ): Promise<string>;
  snapshotParentMessages(count: number): string;
}
