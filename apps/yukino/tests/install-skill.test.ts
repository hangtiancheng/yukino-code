import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { SkillCatalog } from "@/skills/catalog.js";
import { InstallSkillTool } from "@/skills/install-skill-tool.js";
import { yukinoPath } from "@/storage/paths.js";

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
    const cwd = mkdtempSync(join(tmpdir(), "yukino-inst-"));
    const srcPath = join(cwd, "src-skill.md");
    writeFileSync(srcPath, SKILL);

    const catalog = new SkillCatalog();
    const r = await new InstallSkillTool(cwd, catalog).execute(
      { cwd },
      {
        source: srcPath,
      },
    );

    expect(r.isError).toBe(false);
    expect(r.output).toContain("commit-helper");
    const installed = yukinoPath("skills", "commit-helper", "SKILL.md");
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, "utf-8")).toContain("conventional-commit");
    expect(catalog.has("commit-helper")).toBe(true);
  });

  it("errors on a missing local source", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-inst-"));
    const r = await new InstallSkillTool(cwd, new SkillCatalog()).execute(
      { cwd },
      {
        source: "nope.md",
      },
    );
    expect(r.isError).toBe(true);
  });

  it("honors an explicit name override", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yukino-inst-"));
    const srcPath = join(cwd, "s.md");
    writeFileSync(srcPath, SKILL);
    const catalog = new SkillCatalog();
    await new InstallSkillTool(cwd, catalog).execute(
      { cwd },
      {
        source: srcPath,
        name: "renamed",
      },
    );
    expect(existsSync(yukinoPath("skills", "renamed", "SKILL.md"))).toBe(true);
  });
});
