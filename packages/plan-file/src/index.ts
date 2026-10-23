import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { createChildLogger } from "@yukino.js/logger";
import { yukinoPath } from "@yukino.js/storage";
import {
  readPrivateFileSync as readFileSync,
  writePrivateFileSync as writeFileSync,
  mkdirPrivateSync as mkdirSync,
} from "@yukino.js/storage/private.js";
import { generateSlug } from "@yukino.js/utils/slug.js";

import {
  PLAN_FILE_EXTENSION,
  PLAN_PATH_OUTSIDE_STORAGE_MESSAGE,
  PLANS_DIR_NAME,
} from "./constants.js";

export * from "./constants.js";

const log = createChildLogger({ module: "plan-file" });

export interface PlanOwner {
  planFilePath?: string;
}

function isPlanInStorage(planPath: string): boolean {
  const plansDir = yukinoPath(PLANS_DIR_NAME);
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
        PLAN_PATH_OUTSIDE_STORAGE_MESSAGE,
      );
    } else {
      return owner.planFilePath;
    }
  }

  owner.planFilePath = createPlanPath();
  return owner.planFilePath;
}

export function createPlanPath(): string {
  const dir = yukinoPath(PLANS_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  const slug = generateSlug();
  const path = join(dir, `${slug}${PLAN_FILE_EXTENSION}`);
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
      PLAN_PATH_OUTSIDE_STORAGE_MESSAGE,
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
