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

import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("plan-file", () => {
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
