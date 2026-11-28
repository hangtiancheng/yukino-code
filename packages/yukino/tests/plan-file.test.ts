import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import {
  getOrCreatePlanPath,
  savePlan,
  loadPlan,
  planExists,
  resetPlanPath,
} from "@/plan-file/index.js";
import { buildPlanModeReminder } from "@/prompt/plan-mode.js";
import { generateSlug } from "@/utils/slug.js";

describe("plan-file", () => {
  it("generates compact collision-resistant slugs without word lists", () => {
    const slugs = Array.from({ length: 256 }, () => generateSlug());

    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.every((slug) => /^[a-z0-9]+-[a-f0-9]{12}$/u.test(slug))).toBe(
      true,
    );
  });

  it("creates, saves, loads, and resets a plan", () => {
    const owner = { planFilePath: "" };

    const path = getOrCreatePlanPath(owner);
    expect(path).toContain(join(".yukino", "plans"));
    expect(existsSync(path)).toBe(true);
    expect(planExists(owner)).toBe(true);
    // Stable within the owning session.
    expect(getOrCreatePlanPath(owner)).toBe(path);

    savePlan(owner, "# Plan\n- step 1\n- step 2");
    expect(loadPlan(owner)).toContain("step 2");

    resetPlanPath(owner);
    expect(planExists(owner)).toBe(false);
    expect(loadPlan(owner)).toBeNull();
  });

  it("reminder reflects whether a plan file exists", () => {
    const withPlan = buildPlanModeReminder("/x/plan.md", true, 1);
    expect(withPlan).toContain("plan file already exists");
    const noPlan = buildPlanModeReminder("/x/plan.md", false, 1);
    expect(noPlan).toContain("No plan file exists");
    expect(noPlan).toContain("Read-only except the declared plan file");
    expect(noPlan).toContain("Do not run mutating tools");
  });
});
