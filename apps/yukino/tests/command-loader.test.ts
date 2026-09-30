import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { createDefaultRegistry } from "@/commands/commands.js";
import { loadUserCommands, renderBody } from "@/commands/loader.js";

function cmdDir(): string {
  const workDir = mkdtempSync(join(tmpdir(), "yukino-cmd-"));
  mkdirSync(join(workDir, ".yukino", "commands"), { recursive: true });
  return workDir;
}

describe("user command loader", () => {
  it("loads a command with frontmatter and substitutes $ARGUMENTS", () => {
    const workDir = cmdDir();
    writeFileSync(
      join(workDir, ".yukino", "commands", "deploy.md"),
      "---\ndescription: Deploy it\n---\nDeploy $ARGUMENTS to production.",
    );

    const deploy = loadUserCommands(workDir).find((c) => c.name === "deploy");
    expect(deploy).toBeDefined();
    expect(deploy?.description).toBe("Deploy it");
    expect(deploy?.type).toBe("prompt");
    expect(deploy?.handler({ workDir, args: "staging" })).toBe(
      "Deploy staging to production.",
    );
  });

  it("namespaces subdirectory commands with ':'", () => {
    const workDir = cmdDir();
    const sub = join(workDir, ".yukino", "commands", "git");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "sync.md"), "Sync the repo.");

    const cmd = loadUserCommands(workDir).find((c) => c.name === "git:sync");
    expect(cmd).toBeDefined();
    expect(cmd?.handler({ workDir, args: "" })).toBe("Sync the repo.");
  });

  it("renderBody appends args when there is no placeholder", () => {
    expect(renderBody("Do the thing.", "extra")).toBe("Do the thing.\n\nextra");
    expect(renderBody("Echo $ARGUMENTS!", "hi")).toBe("Echo hi!");
    expect(renderBody("Echo $ARGUMENTS!", "$& $$ $` $'")).toBe(
      "Echo $& $$ $` $'!",
    );
    expect(renderBody("No args needed.", "")).toBe("No args needed.");
  });
});

describe("/help listing", () => {
  it("lists commands but excludes skill-derived ones", () => {
    const registry = createDefaultRegistry();
    registry.register({
      name: "demo-skill",
      type: "prompt",
      description: "Demo skill [skill]",
      isSkill: true,
      handler: () => "",
    });

    const help = registry.find("help");
    const output = help?.handler({ workDir: tmpdir(), args: "" }) ?? "";

    expect(output).toContain("/help");
    expect(output).not.toContain("demo-skill");
    expect(output).not.toContain("[skill]");
  });
});
