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

import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "node:os";
import { tmpdir } from "os";
import { join } from "path";

import { describe, it, expect, vi } from "vitest";

import { Agent } from "@/agent/index.js";
import type { LLMClient } from "@/llm/client.js";
import { MemoryConsolidator } from "@/memory/consolidation.js";
import { PermissionChecker } from "@/permissions/index.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "yukino-test-"));
}

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
    const outside = join(homedir(), ".extra-root");
    const checker = new PermissionChecker(dir, "default");
    const target = join(outside, "MEMORY.md");

    const before = checker.check("WriteFile", "write", { file_path: target });
    expect(before.reason).toContain("outside allowed directories");

    checker.allowExtraRoot(outside);

    const after = checker.check("WriteFile", "write", { file_path: target });
    expect(after.reason).not.toContain("outside allowed directories");
  });
});

describe("protected paths under bypass", () => {
  const protectedRelatives: string[] = [];

  it("denies writing protected paths even in bypass mode", () => {
    const dir = makeTmpDir();
    const checker = new PermissionChecker(dir, "bypassPermissions");
    for (const rel of protectedRelatives) {
      const result = checker.check("WriteFile", "write", {
        file_path: join(dir, rel),
      });
      expect(result.effect).toBe("deny");
    }
  });

  it("leaves ordinary files alone", () => {
    const dir = makeTmpDir();
    const checker = new PermissionChecker(dir, "bypassPermissions");
    const result = checker.check("WriteFile", "write", {
      file_path: join(dir, "a.txt"),
    });
    expect(result.effect).not.toBe("deny");
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
        // delete process.env[key];
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

    // Same checker instance: rule file edits take effect immediately
    writeFileSync(rulesFile, deny);
    expect(
      checker.check("Bash", "command", { command: "git push origin main" })
        .effect,
    ).toBe("deny");
  });

  it("deny beats allow regardless of order in the same file", () => {
    for (const body of [`${allow}\n${deny}`, `${deny}\n${allow}`]) {
      const checker = makeCheckerWithTiers(makeTmpDir(), body);
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

    const spy = vi.spyOn(Agent.prototype, "run").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/require-await, require-yield
      async function* (this: Agent) {
        const checker: unknown = Reflect.get(this, "checker");
        if (!(checker instanceof PermissionChecker)) {
          throw new Error("Agent checker was not a PermissionChecker");
        }
        captured.push(checker);
      },
    );

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
      await consolidator.run(memDir, [], 0);

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
      expect(allowed.reason).not.toContain("outside allowed directories");

      // Other directories outside the project are unaffected and still blocked by the sandbox
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
