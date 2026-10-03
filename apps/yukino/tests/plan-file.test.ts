import { mkdtempSync as createTempDir, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, it, expect } from "vitest";

import {
  getOrCreatePlanPath,
  savePlan,
  loadPlan,
  planExists,
  resetPlanPath,
} from "@/plan-file/index.js";
import { buildPlanModeReminder } from "@/prompt/plan-mode.js";
import { generateSlug } from "@/utils/slug.js";

const tempDirs = new Set<string>();

function mkdtempSync(prefix: string): string {
  const directory = createTempDir(prefix);
  tempDirs.add(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("plan-file", () => {
  it("generates compact collision-resistant slugs without word lists", () => {
    const slugs = Array.from({ length: 256 }, () => generateSlug());

    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.every((slug) => /^[a-z0-9]+-[a-f0-9]{12}$/u.test(slug))).toBe(
      true,
    );
  });

  it("creates, saves, loads, and resets a plan", () => {
    resetPlanPath();
    const workDir = mkdtempSync(join(tmpdir(), "yukino-plan-"));

    const path = getOrCreatePlanPath(workDir);
    expect(path).toContain(join(".yukino", "plans"));
    expect(existsSync(path)).toBe(true);
    expect(planExists(workDir)).toBe(true);
    // Stable within a process.
    expect(getOrCreatePlanPath(workDir)).toBe(path);

    savePlan(workDir, "# Plan\n- step 1\n- step 2");
    expect(loadPlan()).toContain("step 2");

    resetPlanPath();
    expect(planExists(workDir)).toBe(false);
    expect(loadPlan()).toBeNull();
  });

  it("reminder reflects whether a plan file exists", () => {
    const withPlan = buildPlanModeReminder("/x/plan.md", true, 1);
    expect(withPlan).toContain("plan file already exists");
    const noPlan = buildPlanModeReminder("/x/plan.md", false, 1);
    expect(noPlan).toContain("No plan file exists");
    expect(noPlan).toContain("MUST NOT make any edits");
  });
});
