import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { SkillCatalog } from "@/skills/catalog.js";
import { InstallSkillTool } from "@/skills/install-skill-tool.js";

const SKILL = `---
name: commit-helper
description: Helps write commits
---
Write a conventional-commit message for the staged changes.`;

describe("InstallSkillTool", () => {
  it("advertises HTTP and HTTPS URL support", () => {
    const tool = new InstallSkillTool(".", new SkillCatalog());

    expect(tool.description).toContain("http(s) URL");
    expect(tool.schema().description).toBe(tool.description);
  });

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
