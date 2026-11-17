import type { ToolContext } from "@/tools/types.js";

// Submodule namespaces for library consumers (Skills.<Sub>.*).
export * as Catalog from "@/skills/catalog.js";
export * as Constants from "@/skills/constants.js";
export * as Executor from "@/skills/executor.js";
export * as InstallSkillTool from "@/skills/install-skill-tool.js";
export * as LoadSkillTool from "@/skills/load-skill-tool.js";
export * as Prompts from "@/skills/prompts.js";

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
