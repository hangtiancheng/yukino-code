/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

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
    const sorted = [...this.sections].sort((a, b) => a.priority - b.priority);
    const contents = sorted.map((s) => s.content.trim()).filter(Boolean);
    return [...new Set(contents)].join("\n\n");
  }
}

export function detectEnvironment(workDir: string): EnvironmentContext {
  const env: EnvironmentContext = {
    workDir,
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
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
    if (result === "true") {
      env.isGitRepo = true;
      env.gitBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: workDir,
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

// The system prompt contains only project-agnostic product definitions so it stays
// as a single global copy and keeps hitting the same cache across projects.
// Project instructions, auto-memories, and the skill listing are all project-scoped
// and injected into the conversation via conversation.injectLongTermMemory as a
// system-reminder message.
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
