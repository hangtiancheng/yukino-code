import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { createChildLogger } from "@/logger/index.js";
import { generateSlug } from "@/utils/slug";

const log = createChildLogger({ module: "plan-file" });

let currentPlanPath: string | null = null;

function isPlanUnderWorkDir(planPath: string, workDir: string): boolean {
  const plansDir = resolve(workDir, ".yukino", "plans");
  // relative() is separator-agnostic: on Windows resolve() produces "\"
  // paths, so a hardcoded "/" join would never match.
  const rel = relative(plansDir, resolve(planPath));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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
