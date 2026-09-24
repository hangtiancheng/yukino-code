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

import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { SkillCatalog } from "@/skills/catalog.js";
import { InstallSkillTool } from "@/skills/install-tool.js";

const SKILL = `---
name: commit-helper
description: Helps write commits
---
Write a conventional-commit message for the staged changes.`;

describe("InstallSkillTool", () => {
  it("installs a skill from a local path and loads it into the catalog", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-inst-"));
    const srcPath = join(workDir, "src-skill.md");
    writeFileSync(srcPath, SKILL);

    const catalog = new SkillCatalog();
    const r = await new InstallSkillTool(workDir, catalog).execute(
      { workDir },
      {
        source: srcPath,
      },
    );

    expect(r.isError).toBe(false);
    expect(r.output).toContain("commit-helper");
    const installed = join(
      workDir,
      ".agents",
      "skills",
      "commit-helper",
      "SKILL.md",
    );
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, "utf-8")).toContain("conventional-commit");
    // catalog reloaded with the new skill
    expect(catalog.has("commit-helper")).toBe(true);
  });

  it("errors on a missing local source", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-inst-"));
    const r = await new InstallSkillTool(workDir, new SkillCatalog()).execute(
      { workDir },
      {
        source: "nope.md",
      },
    );
    expect(r.isError).toBe(true);
  });

  it("honors an explicit name override", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "yukino-inst-"));
    const srcPath = join(workDir, "s.md");
    writeFileSync(srcPath, SKILL);
    const catalog = new SkillCatalog();
    await new InstallSkillTool(workDir, catalog).execute(
      { workDir },
      {
        source: srcPath,
        name: "renamed",
      },
    );
    expect(
      existsSync(join(workDir, ".agents", "skills", "renamed", "SKILL.md")),
    ).toBe(true);
  });
});
