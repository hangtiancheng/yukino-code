import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { SkillCatalog } from "@/skills/catalog.js";
import { cloneRegistryForTeammate } from "@/subagent/tool-filter.js";
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
  if (__origHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = __origHome;
  }
  if (__origUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = __origUserProfile;
  }
  rmSync(workDir, { recursive: true, force: true });
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

    // Agent is blocked to prevent recursive spawning, ComputerUse is a
    // main-thread-only device tool, and team lifecycle is Leader-only
    for (const name of ["Agent", "ComputerUse", "TeamCreate", "TeamDelete"]) {
      expect(names.has(name)).toBe(false);
    }
  });

  // The task board resolves by team name, so the team name must be passed
  // into the worker process at spawn time.
  it("parses --team-name", () => {
    const args = parseTeammateFlags([
      "--teammate",
      "--permission-mode",
      "default",
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

  it.each(["default", "acceptEdits", "bypassPermissions"])(
    "parses inherited permission mode %s",
    (mode) => {
      expect(
        parseTeammateFlags(["--teammate", "--permission-mode", mode])
          ?.permissionMode,
      ).toBe(mode);
    },
  );

  it("rejects missing or invalid permission modes", () => {
    expect(() => parseTeammateFlags(["--teammate"])).toThrow("required");
    expect(() =>
      parseTeammateFlags(["--teammate", "--permission-mode", "invalid"]),
    ).toThrow("Invalid");
  });

  it("parses the provider index that selects the teammate provider", () => {
    const args = parseTeammateFlags([
      "--teammate",
      "--permission-mode",
      "default",
      "--team-dir",
      join(workDir, "alpha"),
      "--member-name",
      "ann",
      "--task",
      "do work",
      "--provider-index",
      "2",
    ]);
    expect(args?.providerIndex).toBe(2);
  });

  // Legacy invocations without --team-name fall back to deriving the team
  // name from the --team-dir path: its basename, or the parent directory's
  // name when the path ends in "inboxes" (the production mailbox layout).
  it("derives team name from directory when --team-name is absent", () => {
    const args = parseTeammateFlags([
      "--teammate",
      "--permission-mode",
      "default",
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
  // In-process teammates clone the Leader's registry through the production
  // cloneRegistryForTeammate: globally disallowed subagent tools and
  // Leader-only team membership management tools must be stripped.
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
      execute: () => Promise.resolve({ output: "", isError: false }),
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

    const teammate = cloneRegistryForTeammate(parent);
    const names = new Set(teammate.listTools().map((t) => t.name));

    for (const n of ["Agent", "ComputerUse", "TeamCreate", "TeamDelete"]) {
      expect(names.has(n)).toBe(false);
    }
    for (const n of ["ReadFile", "Bash", "EditFile"]) {
      expect(names.has(n)).toBe(true);
    }
  });
});
