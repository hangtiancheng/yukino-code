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

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { SkillCatalog } from "@/skills/catalog.js";
import {
  SUBAGENT_DISALLOWED_TOOLS,
  TEAMMATE_DISALLOWED_TOOLS,
} from "@/subagent/tool-filter.js";
import { buildTeammateRegistry, parseTeammateFlags } from "@/teammate.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool } from "@/tools/types.js";

// The team directory lives at <home>/.yukino/teams. Point HOME to a temp
// directory to avoid leaving artifacts in the real ~/.yukino/teams.
// os.homedir() reads USERPROFILE on Windows and HOME elsewhere; set both.
let __origHome: string | undefined;
let __origUserProfile: string | undefined;
let workDir: string;

beforeEach(() => {
  __origHome = process.env.HOME;
  __origUserProfile = process.env.USERPROFILE;
  workDir = mkdtempSync(join(tmpdir(), "yukino-teammate-"));
  process.env.HOME = workDir;
  process.env.USERPROFILE = workDir;
});

afterEach(() => {
  process.env.HOME = __origHome;
  process.env.USERPROFILE = __origUserProfile;
});

describe("teammate worker tool registry", () => {
  // The teammate process assembles its own registry independently from the
  // in-process member path, so pin the expected tool set here: collaboration
  // tools must be present; team management and subagent tools must not.
  it("includes collaboration tools, excludes team management and subagent tools", async () => {
    const catalog = new SkillCatalog();
    const registry = await buildTeammateRegistry({
      workDir,
      teamName: "alpha",
      memberName: "ann",
      catalog,
      skillHost: {
        activateSkill: () => {
          /** noop */
        },
      },
      mcpServers: [],
    });
    const names = new Set(registry.listTools().map((t) => t.name));

    // Core file/command tools, general utilities, and inter-teammate
    // collaboration tools (messaging and shared task board)
    for (const name of [
      "ReadFile",
      "WriteFile",
      "EditFile",
      "Bash",
      "Glob",
      "Grep",
      "ToolSearch",
      "SyntheticOutput",
      "EnterWorktree",
      "ExitWorktree",
      "SendMessage",
      "TaskCreate",
      "TaskGet",
      "TaskList",
      "TaskUpdate",
    ]) {
      expect(names.has(name)).toBe(true);
    }

    // Spawning agents and managing team lifecycle are Lead-only capabilities
    for (const name of ["Agent", "ComputerUse", "TeamCreate", "TeamDelete"]) {
      expect(names.has(name)).toBe(false);
    }
  });

  // The task board resolves by team name, so the team name must be passed
  // into the worker process at spawn time.
  it("parses --team-name", () => {
    const args = parseTeammateFlags([
      "--teammate",
      "--team-dir",
      join(workDir, "alpha"),
      "--team-name",
      "alpha",
      "--member-name",
      "ann",
      "--task",
      "do work",
    ]);
    expect(args?.teamName).toBe("alpha");
    expect(args?.memberName).toBe("ann");
  });

  it("uses the provider base URL as the teammate provider identity", () => {
    const args = parseTeammateFlags([
      "--teammate",
      "--team-dir",
      join(workDir, "alpha"),
      "--member-name",
      "ann",
      "--task",
      "do work",
      "--provider-base-url",
      "https://provider.example.com",
    ]);
    expect(args?.providerBaseUrl).toBe("https://provider.example.com");
  });

  // Legacy invocations without --team-name fall back to deriving the team
  // name from the mailbox directory basename.
  it("derives team name from directory when --team-name is absent", () => {
    const args = parseTeammateFlags([
      "--teammate",
      "--team-dir",
      join(workDir, "beta"),
      "--member-name",
      "bob",
      "--task",
      "do work",
    ]);
    expect(args?.teamName).toBe("beta");
  });
});

describe("in-process teammate tool filtering", () => {
  // In-process teammates clone the Lead's registry; two categories must be
  // excluded during cloning: globally disallowed subagent tools and team
  // membership management tools.
  it("excludes subagent and team management tools", () => {
    const stub = (name: string): Tool => ({
      name,
      description: name,
      category: "read",
      schema: () => ({
        name,
        description: name,
        input_schema: {
          type: "object",
          properties: {},
        },
      }),
      // eslint-disable-next-line @typescript-eslint/require-await
      execute: async () => ({ output: "", isError: false }),
    });

    const parent = new ToolRegistry();
    for (const n of [
      "ReadFile",
      "Bash",
      "EditFile",
      "ComputerUse",
      "Agent",
      "TeamCreate",
      "TeamDelete",
    ]) {
      parent.register(stub(n));
    }

    // Replicate the cloning logic from runAsTeammate
    const teammate = new ToolRegistry();
    for (const tool of parent.listTools()) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      if ((SUBAGENT_DISALLOWED_TOOLS as Set<string>).has(tool.name)) {
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      if ((TEAMMATE_DISALLOWED_TOOLS as Set<string>).has(tool.name)) {
        continue;
      }
      teammate.register(tool);
    }
    const names = new Set(teammate.listTools().map((t) => t.name));

    for (const n of ["Agent", "ComputerUse", "TeamCreate", "TeamDelete"]) {
      expect(names.has(n)).toBe(false);
    }
    for (const n of ["ReadFile", "Bash", "EditFile"]) {
      expect(names.has(n)).toBe(true);
    }
  });
});
