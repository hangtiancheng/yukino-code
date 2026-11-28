import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { cloneRegistryForTeammate } from "@/subagent/tool-filter.js";
import { ToolRegistry } from "@/tools/registry.js";
import type { Tool } from "@/tools/types.js";

// The team directory lives at <home>/.yukino/teams. Point HOME to a temp
// directory to avoid leaving artifacts in the real ~/.yukino/teams.
// os.homedir() reads USERPROFILE on Windows and HOME elsewhere; set both.
let __origHome: string | undefined;
let __origUserProfile: string | undefined;
let cwd: string;

beforeEach(() => {
  __origHome = process.env.HOME;
  __origUserProfile = process.env.USERPROFILE;
  cwd = mkdtempSync(join(tmpdir(), "yukino-teammate-"));
  process.env.HOME = cwd;
  process.env.USERPROFILE = cwd;
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
  rmSync(cwd, { recursive: true, force: true });
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
