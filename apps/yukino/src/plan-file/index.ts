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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { createChildLogger } from "@/logger/index.js";

const log = createChildLogger({ module: "plan-file" });

const ADJECTIVES = [
  "brave",
  "calm",
  "dark",
  "eager",
  "fair",
  "gentle",
  "happy",
  "kind",
  "lively",
  "mighty",
  "noble",
  "proud",
  "quiet",
  "swift",
  "warm",
  "wise",
];

const NOUNS = [
  "crystal",
  "dragon",
  "eagle",
  "falcon",
  "flame",
  "forest",
  "frost",
  "mountain",
  "ocean",
  "phoenix",
  "river",
  "shadow",
  "thunder",
  "tiger",
];

function generateSlug(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const ts = Date.now().toString(36).slice(-4);
  return `${adj}-${noun}-${ts}`;
}

let currentPlanPath: string | null = null;

function isPlanUnderWorkDir(planPath: string, workDir: string): boolean {
  const plansDir = resolve(workDir, ".yukino", "plans");
  const resolved = resolve(planPath);
  return resolved.startsWith(plansDir + "/");
}

export function getOrCreatePlanPath(workDir: string): string {
  if (currentPlanPath && existsSync(currentPlanPath)) {
    if (!isPlanUnderWorkDir(currentPlanPath, workDir)) {
      log.warn(
        { planPath: currentPlanPath, workDir },
        "current plan path is not under work dir",
      );
    } else {
      return currentPlanPath;
    }
  }

  const dir = join(workDir, ".yukino", "plans");
  mkdirSync(dir, { recursive: true });
  const slug = generateSlug();
  currentPlanPath = join(dir, `${slug}.md`);
  writeFileSync(currentPlanPath, "", "utf-8");
  return currentPlanPath;
}

export function savePlan(workDir: string, content: string): void {
  const path = getOrCreatePlanPath(workDir);
  writeFileSync(path, content, "utf-8");
}

export function loadPlan(): string | null {
  if (!currentPlanPath || !existsSync(currentPlanPath)) {
    return null;
  }
  return readFileSync(currentPlanPath, "utf-8");
}

export function planExists(workDir: string): boolean {
  if (!currentPlanPath || !existsSync(currentPlanPath)) {
    return false;
  }
  if (!isPlanUnderWorkDir(currentPlanPath, workDir)) {
    log.warn(
      { planPath: currentPlanPath, workDir },
      "current plan path is not under work dir",
    );
    return false;
  }
  return true;
}

export function resetPlanPath(): void {
  currentPlanPath = null;
}

export function getCurrentPlanPath(): string | null {
  return currentPlanPath;
}
