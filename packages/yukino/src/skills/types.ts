import type { ToolContext } from "@/tools/types.js";

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
