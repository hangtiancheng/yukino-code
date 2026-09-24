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

export interface SkillMeta {
  name: string;
  description: string;
  mode?: "inline" | "fork"; // "inline"
  model?: string;
  forkContext?: "full" | "recent" | "none";
}

export interface Skill {
  meta: SkillMeta;
  body: string;
  sourceDir: string;
  isDirectory: boolean;
}

export interface SkillHost {
  activateSkill(name: string, body: string): void;
}

export interface SkillForkHost extends SkillHost {
  runSubagent(prompt: string): Promise<string>;
  snapshotParentMessages(count: number): string;
}

// Submodule namespaces for library consumers (Skills.<Sub>.*).
export * as Catalog from "./catalog.js";
export * as Executor from "./executor.js";
export * as InstallTool from "./install-tool.js";
export * as LoadSkillTool from "./load-skill-tool.js";
