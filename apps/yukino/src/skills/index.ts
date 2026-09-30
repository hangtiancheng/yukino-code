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
  runSubagent(prompt: string, abortSignal?: AbortSignal): Promise<string>;
  snapshotParentMessages(count: number): string;
}

// Submodule namespaces for library consumers (Skills.<Sub>.*).
export * as Catalog from "./catalog.js";
export * as Executor from "./executor.js";
export * as InstallSkillTool from "./install-skill-tool.js";
export * as LoadSkillTool from "./load-skill-tool.js";
