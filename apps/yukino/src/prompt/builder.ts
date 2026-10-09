import { execSync } from "node:child_process";
import { platform, arch } from "node:os";

import type { Section, EnvironmentContext } from "./sections.js";
import {
  identitySection,
  systemSection,
  doingTasksSection,
  executingActionsSection,
  usingToolsSection,
  toneStyleSection,
  outputEfficiencySection,
  environmentSection,
} from "./sections.js";

import { createChildLogger } from "@/logger/index.js";
const log = createChildLogger({ module: "prompt" });

export class PromptBuilder {
  private sections: Section[] = [];

  add(s: Section): this {
    this.sections.push(s);
    return this;
  }

  build(): string {
    const contents = this.sections.map((s) => s.content.trim()).filter(Boolean);
    return [...new Set(contents)].join("\n\n");
  }
}

export function detectEnvironment(cwd: string): EnvironmentContext {
  const env: EnvironmentContext = {
    cwd,
    os: platform(),
    arch: arch(),
    shell: process.env.SHELL ?? "bash",
    isGitRepo: false,
    gitBranch: "",
    model: "",
    date: new Date().toISOString().split("T")[0],
  };

  try {
    const result = execSync("git rev-parse --is-inside-work-tree", {
      cwd: cwd,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
    if (result === "true") {
      env.isGitRepo = true;
      env.gitBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: cwd,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
      }).trim();
    }
  } catch (err) {
    log.error({ err }, "prompt operation failed");
    // not a git repo
  }

  return env;
}

// The system prompt carries the product definitions plus a small environment
// section (work dir, platform, git state, date); within a session it is a single
// stable block that keeps the prompt-cache prefix intact. Project instructions,
// auto-memories, and the skill listing are all project-scoped and injected into
// the conversation via conversation.injectLongTermMemory as a system-reminder
// message.
export function buildSystemPrompt(env: EnvironmentContext): string {
  const b = new PromptBuilder();
  b.add(identitySection());
  b.add(systemSection());
  b.add(doingTasksSection());
  b.add(executingActionsSection());
  b.add(usingToolsSection());
  b.add(toneStyleSection());
  b.add(outputEfficiencySection());
  b.add(environmentSection(env));
  return b.build();
}
