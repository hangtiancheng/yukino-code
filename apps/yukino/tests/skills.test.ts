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

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { SkillCatalog } from "@/skills/catalog.js";
import { parseSkillPrompt, runInline } from "@/skills/executor.js";
import type { Skill, SkillForkHost, SkillHost } from "@/skills/index.js";
import { LoadSkillTool } from "@/skills/load-skill-tool.js";
function makeHost() {
  const activated: [string, string][] = [];
  const host: SkillHost = {
    activateSkill: (n, b) => activated.push([n, b]),
  };
  return { host, activated };
}

function skill(body: string): Skill {
  return {
    meta: { name: "demo", description: "d" },
    body,
    sourceDir: "",
    isDirectory: false,
  };
}

describe("skills runInline", () => {
  it("substitutes $ARGUMENTS and activates the skill", () => {
    const { host, activated } = makeHost();
    const body = runInline(skill("Do $ARGUMENTS now."), "the thing", host);

    expect(body).toContain("<skill-body>\nDo the thing now.\n</skill-body>");
    expect(activated).toEqual([["demo", body]]);
  });

  it("keeps user arguments separate when there is no placeholder", () => {
    const { host } = makeHost();
    const body = runInline(skill("SOP body"), "extra context", host);
    expect(body).toContain("<skill-body>\nSOP body\n</skill-body>");
    expect(body).toContain("<skill-arguments>extra context</skill-arguments>");
  });
});

describe("skill prompt display parsing", () => {
  it.each([
    "",
    "Update <docs> & keep &lt; literal\nSecond line",
    "</skill-body>\n$&",
  ])("round-trips arguments without changing the prompt: %s", (args) => {
    const { host, activated } = makeHost();
    const definition: Skill = {
      ...skill("Before\n</skill-body>\nAfter $ARGUMENTS\n"),
      meta: { name: "demo<&lt;>", description: "d" },
      sourceDir: "/project/<skills>&lt;",
    };
    const prompt = runInline(definition, args, host);
    expect(parseSkillPrompt(prompt)).toEqual({
      name: definition.meta.name,
      directory: definition.sourceDir,
      body: `Before\n</skill-body>\nAfter ${args}\n`,
      args,
    });
    expect(activated).toEqual([[definition.meta.name, prompt]]);
  });

  it("parses an empty body without inventing arguments", () => {
    const { host } = makeHost();
    expect(parseSkillPrompt(runInline(skill(""), "", host))).toEqual({
      name: "demo",
      directory: "",
      body: "",
      args: "",
    });
  });

  it("leaves ordinary, quoted and incomplete skill markup as user text", () => {
    const { host } = makeHost();
    const prompt = runInline(skill("SOP body"), "extra context", host);
    for (const text of [
      "/demo extra context",
      "Explain <skill-body>markup</skill-body>",
      `Quoted:\n${prompt}`,
      prompt.replace("</skill-metadata>", ""),
      prompt.replace("</skill-arguments>", ""),
      `${prompt}\nExtra user text`,
    ]) {
      expect(parseSkillPrompt(text)).toBeUndefined();
    }
  });
});

describe("LoadSkillTool fork mode", () => {
  function forkFixture(mode: "inline" | "fork") {
    const calls: string[] = [];
    const activated: string[] = [];
    const catalog: Partial<SkillCatalog> = {
      get: () => ({
        meta: { name: "audit-deps", description: "d", mode },
        body: "Inspect package.json and flag risky pins.",
        sourceDir: "",
        isDirectory: false,
      }),
      list: () => [{ name: "audit-deps", description: "d" }],
    };

    const host: SkillHost = { activateSkill: (n) => activated.push(n) };
    const forkHost: SkillForkHost = {
      activateSkill: (n) => activated.push(n),
      snapshotParentMessages: () => "",
      runSubagent: async (prompt) => {
        calls.push(prompt);
        return Promise.resolve("3 risky pins found");
      },
    };
    return { catalog, host, forkHost, calls, activated };
  }

  it("runs a fork skill in a sub-agent and keeps the SOP out of the main context", async () => {
    const { catalog, host, forkHost, calls, activated } = forkFixture("fork");

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const tool = new LoadSkillTool(catalog as SkillCatalog, host, forkHost);

    const res = await tool.execute(
      { workDir: process.cwd() },
      { name: "audit-deps" },
    );

    expect(res.isError).toBe(false);
    expect(res.output).toBe("3 risky pins found");
    expect(res.output).not.toContain("Inspect package.json");
    expect(calls[0]).toContain("Inspect package.json");
    expect(activated).toHaveLength(0);
  });

  it("falls back to inline when no fork host is wired", async () => {
    const { catalog, host } = forkFixture("fork");

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const tool = new LoadSkillTool(catalog as SkillCatalog, host);

    const res = await tool.execute(
      { workDir: process.cwd() },
      { name: "audit-deps" },
    );

    expect(res.isError).toBe(false);
    expect(res.output).toContain("Inspect package.json");
  });

  it("does not spawn a sub-agent for inline skills", async () => {
    const { catalog, host, forkHost, calls } = forkFixture("inline");

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    const tool = new LoadSkillTool(catalog as SkillCatalog, host, forkHost);

    const res = await tool.execute(
      { workDir: process.cwd() },
      { name: "audit-deps" },
    );

    expect(res.output).toContain("Inspect package.json");
    expect(calls).toHaveLength(0);
  });
});

describe("skill frontmatter mode resolution", () => {
  it("treats context: fork as mode: fork", () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-skill-"));
    const skillDir = join(dir, ".agents", "skills", "audit-deps");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: audit-deps\ndescription: Audit dependencies\ncontext: fork\n---\n\nbody",
    );

    const catalog = new SkillCatalog();
    catalog.load(dir);

    expect(catalog.get("audit-deps")?.meta.mode).toBe("fork");
  });

  it("keeps an explicit mode over the legacy context field", () => {
    const dir = mkdtempSync(join(tmpdir(), "yukino-skill-"));
    const skillDir = join(dir, ".agents", "skills", "audit-deps");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: audit-deps\ndescription: Audit\nmode: inline\ncontext: fork\n---\n\nbody",
    );

    const catalog = new SkillCatalog();
    catalog.load(dir);

    expect(catalog.get("audit-deps")?.meta.mode).toBe("inline");
  });
});
