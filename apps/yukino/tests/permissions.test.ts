import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "path";

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { Agent } from "@/agent/index.js";
import type { LLMClient } from "@/llm/client.js";
import { MemoryConsolidator } from "@/memory/consolidation.js";
import { PathSandbox, PermissionChecker } from "@/permissions/index.js";
import { yukinoPath, projectPath } from "@/storage/paths.js";

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
  vi.restoreAllMocks();
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
  const rulesDir = yukinoPath();
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

describe("read-only Docker commands", () => {
  it.each(["docker ps", "docker images --all"])("allows %s", (command) => {
    const checker = new PermissionChecker(makeTmpDir(), "plan");
    expect(checker.check("Bash", "command", { command }).effect).toBe("allow");
  });

  it.each(["touch docker ps", "rm docker images", "mydocker ps"])(
    "does not treat %s as a read-only Docker command",
    (command) => {
      const checker = new PermissionChecker(makeTmpDir(), "default");
      expect(checker.check("Bash", "command", { command }).effect).toBe("ask");
      checker.mode = "plan";
      expect(checker.check("Bash", "command", { command }).effect).toBe("deny");
    },
  );
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

describe.each(["main", "subagent", "teammate"] as const)(
  "%s path sandbox",
  (kind) => {
    function forAgent(parent: PermissionChecker): PermissionChecker {
      if (kind === "main") {
        return parent;
      }
      const checker = parent.forSubagent(makeTmpDir());
      checker.teammate = kind === "teammate";
      return checker;
    }

    function outsideFile(): string {
      return join(originalHome ?? "/", ".outside-project", "file.ts");
    }

    it.each(["default", "acceptEdits", "plan", "bypassPermissions"] as const)(
      "skips path checks for read-only tools in %s",
      (mode) => {
        const checker = forAgent(new PermissionChecker(makeTmpDir(), mode));
        const pathCheck = vi.spyOn(PathSandbox.prototype, "check");
        for (const [tool, args] of [
          ["ReadFile", { file_path: outsideFile() }],
          ["Glob", { path: outsideFile(), pattern: "**/*" }],
          ["Grep", { path: outsideFile(), pattern: "text" }],
        ] as const) {
          expect(checker.check(tool, "read", args).effect).toBe("allow");
        }
        expect(pathCheck).not.toHaveBeenCalled();
      },
    );

    it.each(["default", "acceptEdits"] as const)(
      "still asks for outside-root writes in %s",
      (mode) => {
        const checker = forAgent(new PermissionChecker(makeTmpDir(), mode));
        for (const tool of ["WriteFile", "EditFile"]) {
          expect(
            checker.check(tool, "write", { file_path: outsideFile() }),
          ).toEqual({
            effect: "ask",
            reason: `Path ${outsideFile()} is outside allowed directories`,
          });
        }
        expect(
          checker.check("WriteProbe", "write", { path: outsideFile() }).effect,
        ).toBe("ask");
      },
    );

    it("does not run path checks for writes in bypassPermissions", () => {
      const checker = forAgent(
        new PermissionChecker(makeTmpDir(), "bypassPermissions"),
      );
      const pathCheck = vi.spyOn(PathSandbox.prototype, "check");
      for (const tool of ["WriteFile", "EditFile"]) {
        expect(
          checker.check(tool, "write", { file_path: outsideFile() }).effect,
        ).toBe("allow");
      }
      expect(
        checker.check("WriteProbe", "write", { path: outsideFile() }).effect,
      ).toBe("allow");
      expect(pathCheck).not.toHaveBeenCalled();
    });

    it("follows live parent mode changes including plan", () => {
      const parent = new PermissionChecker(makeTmpDir(), "acceptEdits");
      const checker = forAgent(parent);
      const args = { file_path: outsideFile() };
      expect(checker.check("WriteFile", "write", args).effect).toBe("ask");
      parent.mode = "bypassPermissions";
      expect(checker.check("WriteFile", "write", args).effect).toBe("allow");
      parent.mode = "plan";
      expect(checker.check("WriteFile", "write", args).effect).toBe("deny");
      parent.mode = "default";
      expect(checker.check("WriteFile", "write", args).effect).toBe("ask");
      expect(checker.check("ReadFile", "read", args).effect).toBe("allow");
    });

    it.each(["deny", "ask"] as const)(
      "preserves explicit %s rules for reads and bypassed writes",
      (effect) => {
        const parent = makeChecker(makeTmpDir(), [
          { rule: "ReadFile(*)", effect },
          { rule: "WriteFile(*)", effect },
        ]);
        const checker = forAgent(parent);
        for (const mode of [
          "default",
          "acceptEdits",
          "plan",
          "bypassPermissions",
        ] as const) {
          parent.mode = mode;
          expect(
            checker.check("ReadFile", "read", { file_path: outsideFile() }),
          ).toEqual({ effect, reason: `Permission rule: ${effect}` });
          expect(
            checker.check("WriteFile", "write", { file_path: outsideFile() }),
          ).toEqual(
            mode === "plan"
              ? { effect: "deny", reason: "Plan mode forbids mutations" }
              : { effect, reason: `Permission rule: ${effect}` },
          );
        }
      },
    );

    it("allows explicitly approved outside-root writes", () => {
      const checker = forAgent(
        makeChecker(makeTmpDir(), [{ rule: "WriteFile(*)", effect: "allow" }]),
      );
      expect(
        checker.check("WriteFile", "write", { file_path: outsideFile() }),
      ).toEqual({ effect: "allow", reason: "Permission rule: allow" });
    });
  },
);

describe("plan mode and path sandbox", () => {
  it.each(["default", "acceptEdits", "plan", "bypassPermissions"] as const)(
    "applies the inherited or overridden mode to subagents and teammates in %s",
    (mode) => {
      const parent = new PermissionChecker(makeTmpDir(), mode);
      const target = join(originalHome ?? "/", ".outside-project", "file.ts");
      const pathCheck = vi.spyOn(PathSandbox.prototype, "check");
      for (const teammate of [false, true]) {
        const checker = parent.forSubagent(makeTmpDir(), "plan");
        checker.teammate = teammate;
        checker.planFilePath = `${target}.plan.md`;
        expect(
          checker.check("ReadFile", "read", { file_path: target }).effect,
        ).toBe("allow");
        expect(
          checker.check("Grep", "read", { path: target, pattern: "text" })
            .effect,
        ).toBe("allow");
        expect(
          checker.check("WriteFile", "write", { file_path: target }).effect,
        ).toBe(
          mode === "default" || mode === "plan"
            ? "deny"
            : mode === "acceptEdits"
              ? "ask"
              : "allow",
        );
        expect(
          checker.check("WriteFile", "write", {
            file_path: checker.planFilePath,
          }).effect,
        ).toBe(mode === "acceptEdits" ? "ask" : "allow");
        expect(checker.mode).toBe(mode === "default" ? "plan" : mode);
      }
      if (
        mode === "default" ||
        mode === "plan" ||
        mode === "bypassPermissions"
      ) {
        expect(pathCheck).not.toHaveBeenCalled();
      }
    },
  );

  it("still checks symlink targets for non-bypassed writes", () => {
    const dir = makeTmpDir();
    symlinkSync(originalHome ?? "/", join(dir, "external"), "dir");
    const parent = new PermissionChecker(dir, "acceptEdits");
    const checkers = [parent, parent.forSubagent(dir), parent.forSubagent(dir)];
    checkers[2].teammate = true;
    const args = {
      file_path: join(dir, "external", ".outside-project", "file.ts"),
    };
    for (const checker of checkers) {
      expect(checker.check("WriteFile", "write", args).effect).toBe("ask");
      expect(checker.check("ReadFile", "read", args).effect).toBe("allow");
    }
    parent.mode = "bypassPermissions";
    for (const checker of checkers) {
      expect(checker.check("WriteFile", "write", args).effect).toBe("allow");
    }
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

  it("forCwd preserves the teammate flag", () => {
    const dir = makeTmpDir();
    const checker = new PermissionChecker(dir, "acceptEdits");
    checker.teammate = true;

    expect(checker.forCwd(dir).teammate).toBe(true);
  });
});

describe("delegated permission modes", () => {
  const modes = [
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
  ] as const;
  it.each(modes)("inherits %s when no mode is configured", (mode) => {
    const parent = new PermissionChecker(makeTmpDir(), mode);
    const child = parent.forSubagent(makeTmpDir());
    expect(child.mode).toBe(mode);
    for (const next of modes) {
      parent.mode = next;
      expect(child.mode).toBe(next);
    }
  });
  it.each(modes)(
    "resolves every configured mode under parent %s",
    (parentMode) => {
      const parent = new PermissionChecker(makeTmpDir(), parentMode);
      for (const configured of modes) {
        const child = parent.forSubagent(makeTmpDir(), configured);
        const expected =
          parentMode === "acceptEdits" ||
          parentMode === "bypassPermissions" ||
          configured === "bypassPermissions"
            ? parentMode
            : configured;
        expect(child.mode).toBe(expected);
        expect(child.forCwd(makeTmpDir()).mode).toBe(expected);
      }
    },
  );
  it("keeps child transitions local and removes bypass when the parent exits it", () => {
    const parent = new PermissionChecker(makeTmpDir());
    const child = parent.forSubagent(makeTmpDir(), "plan");
    const sibling = parent.forSubagent(makeTmpDir());
    child.mode = "acceptEdits";
    expect(parent.mode).toBe("default");
    expect(sibling.mode).toBe("default");
    child.mode = "bypassPermissions";
    expect(child.mode).toBe("default");
    parent.mode = "bypassPermissions";
    expect(child.mode).toBe("bypassPermissions");
    parent.mode = "plan";
    expect(child.mode).toBe("plan");
  });
  it.each(["allow", "ask"])(
    "plan rejects writes despite an explicit %s rule or sandbox auto-allow",
    (effect) => {
      const checker = makeChecker(makeTmpDir(), [
        { rule: "WriteFile(*)", effect },
        { rule: "Bash(*)", effect },
      ]);
      checker.mode = "plan";
      expect(
        checker.check("WriteFile", "write", { file_path: "a.ts" }).effect,
      ).toBe("deny");
      expect(
        checker.check("Bash", "command", { command: "touch a.ts" }).effect,
      ).toBe("deny");
    },
  );
  it("permits plan control tools and the exact plan file while preserving explicit deny", () => {
    const checker = new PermissionChecker(makeTmpDir(), "plan");
    checker.planFilePath = join(makeTmpDir(), "plan.md");
    expect(checker.check("ExitPlanMode", "command", {}).effect).toBe("allow");
    expect(checker.check("Agent", "command", {}).effect).toBe("allow");
    expect(
      checker.check("WriteFile", "write", { file_path: checker.planFilePath })
        .effect,
    ).toBe("allow");
    expect(
      checker.check("WriteFile", "write", {
        file_path: `${checker.planFilePath}.other`,
      }).effect,
    ).toBe("deny");
    const denied = makeChecker(makeTmpDir(), [
      { rule: "ExitPlanMode(*)", effect: "deny" },
    ]);
    denied.mode = "plan";
    expect(denied.check("ExitPlanMode", "command", {}).effect).toBe("deny");
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
    mkdirSync(yukinoPath(), { recursive: true });
    writeFileSync(yukinoPath("permissions.yaml"), userRules);
    const cwd = makeTmpDir();
    mkdirSync(projectPath(cwd), { recursive: true });
    writeFileSync(projectPath(cwd, "permissions.yaml"), projectRules);
    return new PermissionChecker(cwd, "default");
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
    const rulesDir = yukinoPath();
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
      const memDir = projectPath(dir, "memory");
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

      const userMemFile = yukinoPath("memory", "MEMORY.md");
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
    const rulesDir = yukinoPath();
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
    const rulesDir = yukinoPath();
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
    const rulesDir = yukinoPath();
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
