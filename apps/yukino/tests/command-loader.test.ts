import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { createDefaultRegistry } from "@/commands/commands.js";
import {
  loadUserCommands,
  parseCommandArgs,
  renderBody,
} from "@/commands/loader.js";
import { yukinoPath } from "@/storage/paths.js";

function cmdDir(): string {
  const cwd = mkdtempSync(join(tmpdir(), "yukino-cmd-"));
  mkdirSync(yukinoPath("prompts"), { recursive: true });
  return cwd;
}

describe("user command loader", () => {
  it("parses BOM-prefixed frontmatter without exposing it in the prompt", () => {
    const cwd = cmdDir();
    writeFileSync(
      yukinoPath("prompts", "bom.md"),
      "\uFEFF---\r\ndescription: BOM command\r\n---\r\nBody $1",
    );
    const cmd = loadUserCommands().find((entry) => entry.name === "bom");
    expect(cmd?.description).toBe("BOM command [custom]");
    expect(cmd?.handler({ cwd, args: "argument" })).toBe("Body argument");
  });

  it("supports positional arguments, empty quoted arguments, defaults and slices", () => {
    const args = "\"two words\" '' escaped\\ space fourth";
    expect(parseCommandArgs(args)).toEqual([
      "two words",
      "",
      "escaped space",
      "fourth",
    ]);
    expect(
      renderBody(
        "$1 | ${2:-fallback} | ${@:3:1} | ${@:4} | ${9:-missing}",
        args,
      ),
    ).toBe("two words | fallback | escaped space | fourth | missing");
    expect(renderBody("$ARGUMENTS", args)).toBe(args);
    expect(renderBody("$@", args)).toBe("two words  escaped space fourth");
    expect(renderBody("${ARGUMENTS:-default} ${@:-all}", "")).toBe(
      "default all",
    );
  });

  it("does not recursively substitute argument values or defaults", () => {
    expect(renderBody("$1 | $2 | ${3:-$1}", "'$ARGUMENTS' '$@'")).toBe(
      "$ARGUMENTS | $@ | $1",
    );
    expect(parseCommandArgs("\"C:\\project\\file\" 'a\\b'")).toEqual([
      "C:\\project\\file",
      "a\\b",
    ]);
  });
  it("loads a command with frontmatter and substitutes $ARGUMENTS", () => {
    const cwd = cmdDir();
    writeFileSync(
      yukinoPath("prompts", "deploy.md"),
      "---\ndescription: Deploy it\n---\nDeploy $ARGUMENTS to production.",
    );

    const deploy = loadUserCommands().find((c) => c.name === "deploy");
    expect(deploy).toBeDefined();
    expect(deploy?.description).toBe("Deploy it [custom]");
    expect(deploy?.type).toBe("prompt");
    expect(deploy?.handler({ cwd, args: "staging" })).toBe(
      "Deploy staging to production.",
    );
  });

  it("namespaces subdirectory commands with ':'", () => {
    const cwd = cmdDir();
    const sub = yukinoPath("prompts", "git");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "sync.md"), "Sync the repo.");

    const cmd = loadUserCommands().find((c) => c.name === "git:sync");
    expect(cmd).toBeDefined();
    expect(cmd?.description).toBe("custom command [custom]");
    expect(cmd?.handler({ cwd, args: "" })).toBe("Sync the repo.");
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
    const output = help?.handler({ cwd: tmpdir(), args: "" }) ?? "";

    expect(output).toContain("/help");
    expect(output).not.toContain("demo-skill");
    expect(output).not.toContain("[skill]");
  });
});
