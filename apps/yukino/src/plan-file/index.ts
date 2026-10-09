import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { createChildLogger } from "@/logger/index.js";
import { yukinoPath } from "@/storage/paths.js";
import { generateSlug } from "@/utils/slug";

const log = createChildLogger({ module: "plan-file" });

export interface PlanOwner {
  planFilePath?: string;
}

function isPlanInStorage(planPath: string): boolean {
  const plansDir = yukinoPath("plans");
  // relative() is separator-agnostic: on Windows resolve() produces "\"
  // paths, so a hardcoded "/" join would never match.
  const rel = relative(plansDir, resolve(planPath));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function getOrCreatePlanPath(owner: PlanOwner): string {
  if (owner.planFilePath && existsSync(owner.planFilePath)) {
    if (!isPlanInStorage(owner.planFilePath)) {
      log.warn(
        { planPath: owner.planFilePath },
        "current plan path is outside plan storage",
      );
    } else {
      return owner.planFilePath;
    }
  }

  owner.planFilePath = createPlanPath();
  return owner.planFilePath;
}

export function createPlanPath(): string {
  const dir = yukinoPath("plans");
  mkdirSync(dir, { recursive: true });
  const slug = generateSlug();
  const path = join(dir, `${slug}.md`);
  writeFileSync(path, "", { encoding: "utf-8", flag: "wx" });
  return path;
}

export function savePlan(owner: PlanOwner, content: string): void {
  const path = getOrCreatePlanPath(owner);
  writeFileSync(path, content, "utf-8");
}

export function loadPlan(owner: PlanOwner): string | null {
  if (!owner.planFilePath || !existsSync(owner.planFilePath)) {
    return null;
  }
  return readFileSync(owner.planFilePath, "utf-8");
}

export function planExists(owner: PlanOwner): boolean {
  if (!owner.planFilePath || !existsSync(owner.planFilePath)) {
    return false;
  }
  if (!isPlanInStorage(owner.planFilePath)) {
    log.warn(
      { planPath: owner.planFilePath },
      "current plan path is outside plan storage",
    );
    return false;
  }
  return true;
}

export function resetPlanPath(owner: PlanOwner): void {
  owner.planFilePath = "";
}

export function getCurrentPlanPath(owner: PlanOwner): string | null {
  return owner.planFilePath || null;
}
