import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { homedir } from "node:os";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { Agent } from "@/agent/index.js";
import type { LLMClient } from "@/llm/client.js";
import { MemoryConsolidator } from "@/memory/consolidation.js";
import { PermissionChecker } from "@/permissions/index.js";

const tempDirs = new Set<string>();
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

function makeTmpDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "yukino-test-"));
  tempDirs.add(directory);
  return directory;
}

beforeEach(() => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  const home = makeTmpDir();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function makeChecker(
  tmpDir: string,
  rules: { rule: string; effect: string }[],
) {
  const rulesDir = join(tmpDir, ".yukino");
  mkdirSync(rulesDir, { recursive: true });
  const rulesFile = join(rulesDir, "permissions.yaml");
  const yaml = rules
    .map((r) => `- rule: "${r.rule}"\n  effect: ${r.effect}`)
    .join("\n");
  writeFileSync(rulesFile, yaml);

  const checker = new PermissionChecker(tmpDir, "default");
  checker.sandboxEnabled = true;
  checker.sandboxAutoAllow = true;
  return checker;
}

describe("sandbox auto-allow respects deny/ask rules", () => {
  it("denies compound command with denied subcommand", () => {
    const dir = makeTmpDir();
    const checker = makeChecker(dir, [
      { rule: "Bash(rm -rf /)", effect: "deny" },
    ]);
    const result = checker.check("Bash", "command", {
      command: "echo ok && rm -rf /",
    });
    expect(result.effect).toBe("deny");
  });

  it.each([
    ["a single ampersand", " & "],
    ["a carriage return", "\r"],
    ["a line feed", "\n"],
  ])("splits on %s before applying deny and ask rules", (_label, separator) => {
    const denied = makeChecker(makeTmpDir(), [
      { rule: "Bash(rm -rf /)", effect: "deny" },
    ]).check("Bash", "command", {
      command: `echo ok${separator}rm -rf /`,
    });
    const asked = makeChecker(makeTmpDir(), [
      { rule: "Bash(git push origin main)", effect: "ask" },
    ]).check("Bash", "command", {
      command: `echo ok${separator}git push origin main`,
    });

    expect(denied.effect).toBe("deny");
    expect(asked.effect).toBe("ask");
  });

  it("allows safe command with sandbox", () => {
    const dir = makeTmpDir();
    const checker = makeChecker(dir, [
      { rule: "Bash(rm -rf /)", effect: "deny" },
    ]);
    const result = checker.check("Bash", "command", {
      command: "go test ./...",
    });
    expect(result.effect).toBe("allow");
  });

  it.each([{}, { command: 42 }, { command: "   " }])(
    "does not auto-allow an uninspectable Bash command: %j",
    (args) => {
      const checker = makeChecker(makeTmpDir(), []);

      const result = checker.check("Bash", "command", args);

      expect(result.effect).toBe("ask");
      expect(result.reason).toContain("non-empty Bash command");
    },
  );

  it("respects ask rule even with sandbox", () => {
    const dir = makeTmpDir();
    const checker = makeChecker(dir, [
      { rule: "Bash(git push origin main)", effect: "ask" },
    ]);
    const result = checker.check("Bash", "command", {
      command: "git push origin main",
    });
    expect(result.effect).toBe("ask");
  });

  it("does not auto-allow when the sandbox backend is not ready", () => {
    const dir = makeTmpDir();
    const checker = makeChecker(dir, []);
    checker.sandboxEnabled = false;

    const result = checker.check("Bash", "command", {
      command: "touch generated.txt",
    });

    expect(result.effect).toBe("ask");
  });
});

describe("extra allowed roots", () => {
  it("opens a path outside the project once declared", () => {
    const dir = makeTmpDir();
    // makeTmpDir() won't work here: the system temp directory is already in the sandbox default allow list, so pick a path genuinely outside the project
    const outside = join(originalHome ?? "/", ".extra-root");
    const checker = new PermissionChecker(dir, "default");
    const target = join(outside, "MEMORY.md");

    const before = checker.check("WriteFile", "write", { file_path: target });
    expect(before.reason).toContain("outside allowed directories");

    checker.allowExtraRoot(outside);

    const after = checker.check("WriteFile", "write", { file_path: target });
    expect(after.reason).not.toContain("outside allowed directories");
  });
});

describe("bypassPermissions mode", () => {
  it("leaves ordinary files alone", () => {
    const dir = makeTmpDir();
    const checker = new PermissionChecker(dir, "bypassPermissions");
    const result = checker.check("WriteFile", "write", {
      file_path: join(dir, "a.txt"),
    });
    expect(result.effect).not.toBe("deny");
  });
});

describe("teammate coordination tools", () => {
  it("auto-allows SendMessage and task-board tools for teammate checkers", () => {
    const checker = new PermissionChecker(makeTmpDir(), "acceptEdits");
    checker.teammate = true;

    const message = checker.check("SendMessage", "command", {
      to: "leader",
      content: "done",
    });
    expect(message.effect).toBe("allow");
    expect(message.reason).toBe("Teammate coordination tool");

    expect(
      checker.check("TaskCreate", "command", {
        subject: "s",
        description: "d",
      }).effect,
    ).toBe("allow");
    expect(checker.check("TaskUpdate", "command", { taskId: "1" }).effect).toBe(
      "allow",
    );
  });

  it("keeps SendMessage behind approval for non-teammate checkers", () => {
    const checker = new PermissionChecker(makeTmpDir(), "acceptEdits");

    const result = checker.check("SendMessage", "command", {
      to: "leader",
      content: "done",
    });
    expect(result.effect).toBe("ask");
  });

  it("explicit deny rules still gate teammate coordination tools", () => {
    const dir = makeTmpDir();
    const checker = makeChecker(dir, [
      { rule: "SendMessage(*)", effect: "deny" },
    ]);
    checker.teammate = true;

    expect(
      checker.check("SendMessage", "command", { to: "leader", content: "x" })
        .effect,
    ).toBe("deny");
  });

  it("forWorkDir preserves the teammate flag", () => {
    const dir = makeTmpDir();
    const checker = new PermissionChecker(dir, "acceptEdits");
    checker.teammate = true;

    expect(checker.forWorkDir(dir).teammate).toBe(true);
  });
});

describe("delegated permission modes", () => {
  it.each(["allow", "ask"])(
    "does not let an explicit %s rule bypass a locked plan",
    (effect) => {
      const dir = makeTmpDir();
      const checker = makeChecker(dir, [{ rule: "WriteFile(*)", effect }]);
      checker.planModeLocked = true;
      expect(
        checker.check("WriteFile", "write", { file_path: "a.ts" }).effect,
      ).toBe("deny");
    },
  );
  it.each(["default", "acceptEdits", "bypassPermissions"] as const)(
    "inherits %s and follows live mode changes across work directories",
    (mode) => {
      const dir = makeTmpDir();
      const parent = new PermissionChecker(dir, mode);
      const child = parent.forSubagent(makeTmpDir());
      const nested = child.forWorkDir(makeTmpDir()).forSubagent(dir);
      expect(child.mode).toBe(mode);
      expect(nested.mode).toBe(mode);
      parent.mode = "bypassPermissions";
      expect(
        nested.check("Bash", "command", { command: "pnpm test" }).effect,
      ).toBe("allow");
      parent.mode = "default";
      expect(
        child.check("WriteFile", "write", { file_path: "a.ts" }).effect,
      ).toBe("ask");
    },
  );

  it("keeps the last non-plan mode when the parent enters plan, including newly spawned children", () => {
    const dir = makeTmpDir();
    const parent = new PermissionChecker(dir, "acceptEdits");
    const child = parent.forSubagent(dir);
    parent.mode = "plan";
    expect(parent.mode).toBe("plan");
    expect(child.mode).toBe("acceptEdits");
    expect(parent.forSubagent(dir).mode).toBe("acceptEdits");
    expect(
      child.check("WriteFile", "write", { file_path: "a.ts" }).effect,
    ).toBe("allow");
    parent.mode = "bypassPermissions";
    expect(child.mode).toBe("bypassPermissions");
    parent.mode = "plan";
    expect(child.mode).toBe("bypassPermissions");
    expect(new PermissionChecker(dir, "plan").forSubagent(dir).mode).toBe(
      "default",
    );
  });

  it("holds a teammate's own plan gate through parent changes, then restores the current parent mode", () => {
    const dir = makeTmpDir();
    const parent = new PermissionChecker(dir, "acceptEdits");
    const child = parent.forSubagent(dir);
    child.planModeLocked = true;
    child.planFilePath = join(dir, "plan.md");
    child.teammate = true;
    parent.mode = "bypassPermissions";
    expect(child.mode).toBe("plan");
    expect(parent.mode).toBe("bypassPermissions");
    expect(
      child.check("WriteFile", "write", { file_path: "a.ts" }).effect,
    ).toBe("deny");
    expect(
      child.check("WriteFile", "write", { file_path: child.planFilePath })
        .effect,
    ).toBe("allow");
    expect(
      child.check("Bash", "command", { command: "git status" }).effect,
    ).toBe("allow");
    expect(
      child.check("SendMessage", "command", { to: "leader", content: "ready" })
        .effect,
    ).toBe("allow");
    child.planModeLocked = false;
    expect(child.mode).toBe("bypassPermissions");
  });
});

// Writes the user-level and project-level rule files separately to verify cross-file merging.
// homedir() is redirected to a temp dir while constructing the checker so the
// user-level file never touches the real ~/.yukino/permissions.yaml.
function makeCheckerWithTiers(userRules: string, projectRules: string) {
  const home = makeTmpDir();
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    mkdirSync(join(home, ".yukino"), { recursive: true });
    writeFileSync(join(home, ".yukino", "permissions.yaml"), userRules);
    const workDir = makeTmpDir();
    mkdirSync(join(workDir, ".yukino"), { recursive: true });
    writeFileSync(join(workDir, ".yukino", "permissions.yaml"), projectRules);
    return new PermissionChecker(workDir, "default");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("rule merging across files", () => {
  const allow = '- rule: "Bash(git *)"\n  effect: allow';
  const deny = '- rule: "Bash(git *)"\n  effect: deny';
  const ask = '- rule: "Bash(git *)"\n  effect: ask';

  it("deny in project beats allow in user", () => {
    const checker = makeCheckerWithTiers(allow, deny);
    expect(
      checker.check("Bash", "command", { command: "git push origin main" })
        .effect,
    ).toBe("deny");
  });

  it("deny in user beats allow in project", () => {
    const checker = makeCheckerWithTiers(deny, allow);
    expect(
      checker.check("Bash", "command", { command: "git push origin main" })
        .effect,
    ).toBe("deny");
  });

  it("ask beats allow", () => {
    const checker = makeCheckerWithTiers(ask, allow);
    expect(
      checker.check("Bash", "command", { command: "git push origin main" })
        .effect,
    ).toBe("ask");
  });

  it("picks up rule file changes without restart", () => {
    const dir = makeTmpDir();
    const rulesDir = join(dir, ".yukino");
    mkdirSync(rulesDir, { recursive: true });
    const rulesFile = join(rulesDir, "permissions.yaml");

    writeFileSync(rulesFile, allow);
    const checker = new PermissionChecker(dir, "default");
    expect(
      checker.check("Bash", "command", { command: "git push origin main" })
        .effect,
    ).toBe("allow");

    writeFileSync(rulesFile, deny);
    expect(
      checker.check("Bash", "command", { command: "git push origin main" })
        .effect,
    ).toBe("deny");
  });

  it("deny beats allow regardless of order in the same file", () => {
    for (const body of [`${allow}\n${deny}`, `${deny}\n${allow}`]) {
      const checker = makeCheckerWithTiers("", body);
      expect(
        checker.check("Bash", "command", { command: "git push origin main" })
          .effect,
      ).toBe("deny");
    }
  });
});

describe("memory background agent sandbox", () => {
  it("opens the user-level memory dir for the consolidation sub-agent", async () => {
    // Intercept the sub-agent run to capture its permission checker without issuing a real LLM request
    const captured: PermissionChecker[] = [];

    const spy = vi.spyOn(Agent.prototype, "run").mockImplementation(function (
      this: Agent,
    ) {
      const checker: unknown = Reflect.get(this, "checker");
      if (!(checker instanceof PermissionChecker)) {
        throw new Error("Agent checker was not a PermissionChecker");
      }
      captured.push(checker);
      // The intercepted sub-agent run yields no events; an empty async
      // generator matches Agent.run's AsyncGenerator signature.
      return (async function* () {
        /** noop */
      })();
    });

    try {
      const dir = makeTmpDir();
      const memDir = join(dir, ".yukino", "memory");
      mkdirSync(memDir, { recursive: true });

      const fakeClient: LLMClient = {
        setSystemPrompt(_prompt: string) {
          /** noop */
        },
        async *stream() {
          /** noop */
        },
      };
      const consolidator = new MemoryConsolidator(fakeClient, dir);
      await consolidator.run(memDir, []);

      expect(captured.length).toBe(1);
      const checker = captured[0];

      // The sub-agent runs with a MemoryPermissionChecker (mode is already
      // "default" and its check() override never reads mode, so this
      // assignment is a no-op); the verdicts below come from that override's
      // memory-root scoping, not the path sandbox.
      checker.mode = "default";

      const userMemFile = join(homedir(), ".yukino", "memory", "MEMORY.md");
      const allowed = checker.check("WriteFile", "write", {
        file_path: userMemFile,
      });
      expect(allowed.effect).toBe("allow");

      // Paths outside the memory roots are unaffected and still denied by the override's scoping
      const unrelated = join(homedir(), "unrelated-dir", "x.txt");
      const blocked = checker.check("WriteFile", "write", {
        file_path: unrelated,
      });
      expect(blocked.effect).toBe("deny");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("rule file caching", () => {
  const allowRule = '- rule: "Bash(git *)"\n  effect: allow\n';
  // Same length as allowRule, padded with trailing whitespace that YAML parsing ignores
  const denyRuleSameSize = '- rule: "Bash(git *)"\n  effect: deny \n';

  it("reuses parsed rules when the file looks unchanged", async () => {
    const { utimesSync } = await import("node:fs");
    const dir = makeTmpDir();
    const rulesDir = join(dir, ".yukino");
    mkdirSync(rulesDir, { recursive: true });
    const rulesFile = join(rulesDir, "permissions.yaml");

    expect(allowRule.length).toBe(denyRuleSameSize.length);

    // Both writes pin the timestamp to the same value: utimesSync only has millisecond precision,
    // and restoring from the actual post-write mtime would drop the nanosecond portion, so pinning is needed to craft a "looks unchanged" state
    const fixed = new Date(Date.now() - 60_000);

    writeFileSync(rulesFile, allowRule);
    utimesSync(rulesFile, fixed, fixed);
    const checker = new PermissionChecker(dir, "default");
    expect(
      checker.check("Bash", "command", { command: "git push origin main" })
        .effect,
    ).toBe("allow");

    // Silently swap the content to deny while keeping size and mtime identical to the previous write:
    // the engine cannot tell the file changed and should keep using the cached parse result
    writeFileSync(rulesFile, denyRuleSameSize);
    utimesSync(rulesFile, fixed, fixed);

    expect(
      checker.check("Bash", "command", { command: "git push origin main" })
        .effect,
    ).toBe("allow");
  });

  it("re-parses when only the mtime moves", async () => {
    const { utimesSync } = await import("node:fs");
    const dir = makeTmpDir();
    const rulesDir = join(dir, ".yukino");
    mkdirSync(rulesDir, { recursive: true });
    const rulesFile = join(rulesDir, "permissions.yaml");

    writeFileSync(rulesFile, allowRule);
    const checker = new PermissionChecker(dir, "default");
    expect(
      checker.check("Bash", "command", { command: "git push origin main" })
        .effect,
    ).toBe("allow");

    writeFileSync(rulesFile, denyRuleSameSize);
    // Explicitly move the modification time forward to simulate a real change on a low-precision timestamp filesystem
    const future = new Date(Date.now() + 2000);
    utimesSync(rulesFile, future, future);

    expect(
      checker.check("Bash", "command", { command: "git push origin main" })
        .effect,
    ).toBe("deny");
  });

  it("drops the cache when the file is removed", async () => {
    const { unlinkSync } = await import("node:fs");
    const dir = makeTmpDir();
    const rulesDir = join(dir, ".yukino");
    mkdirSync(rulesDir, { recursive: true });
    const rulesFile = join(rulesDir, "permissions.yaml");

    writeFileSync(rulesFile, '- rule: "Bash(git *)"\n  effect: deny\n');
    const checker = new PermissionChecker(dir, "default");
    expect(
      checker.check("Bash", "command", { command: "git push origin main" })
        .effect,
    ).toBe("deny");

    unlinkSync(rulesFile);
    // With no rules left, fall back to the mode default; under default mode the command class is ask
    expect(
      checker.check("Bash", "command", { command: "git push origin main" })
        .effect,
    ).toBe("ask");
  });
});
