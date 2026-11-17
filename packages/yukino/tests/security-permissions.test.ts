import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Agent } from "@/agent/index.js";
import { ConversationManager } from "@/conversation/index.js";
import type { LLMClient } from "@/llm/client.js";
import { MemoryExtractor } from "@/memory/extractor.js";
import { MemoryPermissionChecker } from "@/memory/permissions.js";
import { PermissionChecker, type PermissionMode } from "@/permissions/index.js";
import { requestToolPermission } from "@/permissions/request.js";
import { analyzeShell } from "@/permissions/shell.js";
import { projectPath, yukinoPath, getSessionsDir } from "@/storage/index.js";
import { GlobTool } from "@/tools/glob.js";
import { GrepTool } from "@/tools/grep.js";
import { ReadFileTool } from "@/tools/read-file.js";
import { ToolRegistry } from "@/tools/registry.js";
import { canonicalPath } from "@/utils/paths.js";

const directories: string[] = [];
const cwd = () => {
  const directory = mkdtempSync(join(tmpdir(), "yukino-security-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
function rules(directory: string, entries: { rule: string; effect: string }[]) {
  mkdirSync(projectPath(directory), { recursive: true });
  writeFileSync(projectPath(directory, "permissions.yaml"), yaml.dump(entries));
}
const modes: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];
const separators = ["\n", "\r\n", ";", "&&", "||", "|", "&"];

describe("shell explicit rules", () => {
  it("does not hide an executable behind Bash append assignments", () => {
    const directory = cwd();
    rules(directory, [{ rule: "Bash(printf *)", effect: "deny" }]);
    const command = "REVIEW_PROBE+=x printf marker";
    expect(execFileSync("bash", ["-c", command], { encoding: "utf8" })).toBe(
      "marker",
    );
    expect(analyzeShell(command).complete).toBe(false);
    for (const mode of modes) {
      const checker = new PermissionChecker(directory, mode);
      for (const sandbox of [false, true]) {
        checker.sandboxEnabled = checker.sandboxAutoAllow = sandbox;
        expect(checker.check("Bash", "command", { command }).effect).toBe(
          "deny",
        );
      }
    }
  });

  it.each(separators)(
    "checks every segment separated by %j in every mode",
    (separator) => {
      const directory = cwd();
      rules(directory, [
        { rule: "Bash(rm *)", effect: "deny" },
        { rule: "PowerShell(Remove-Item *)", effect: "deny" },
      ]);
      for (const mode of modes) {
        for (const sandbox of [false, true]) {
          const checker = new PermissionChecker(directory, mode);
          checker.sandboxEnabled = sandbox;
          checker.sandboxAutoAllow = sandbox;
          for (const [tool, denied] of [
            ["Bash", "rm -rf target"],
            ["PowerShell", "remove-item target"],
          ]) {
            for (const command of [
              `${denied} ${separator} echo ok`,
              `echo a ${separator} ${denied} ${separator} echo b`,
              `echo ok ${separator} ${denied}`,
            ]) {
              expect(
                checker.check(tool, "command", { command }).effect,
                `${mode}: ${command}`,
              ).toBe("deny");
            }
          }
        }
      }
    },
  );

  it.each(separators)(
    "keeps ask above remembered and sandbox allow for %j",
    (separator) => {
      const directory = cwd();
      rules(directory, [
        { rule: "Bash(*)", effect: "allow" },
        { rule: "Bash(git push*)", effect: "ask" },
      ]);
      for (const mode of modes) {
        const checker = new PermissionChecker(directory, mode);
        checker.sandboxEnabled = checker.sandboxAutoAllow = true;
        expect(
          checker.check("Bash", "command", {
            command: `echo ok ${separator} git push origin main`,
          }).effect,
        ).toBe(mode === "plan" ? "deny" : "ask");
      }
    },
  );

  it("distinguishes literal separators, escaped words, comments and continuations", () => {
    const directory = cwd();
    rules(directory, [{ rule: "Bash(rm *)", effect: "deny" }]);
    const checker = new PermissionChecker(directory, "bypassPermissions");
    for (const command of [
      "echo 'a; rm target'",
      'echo "a && rm target"',
      "echo a\\;rm",
      "echo ok # rm target",
    ]) {
      expect(checker.check("Bash", "command", { command }).effect).toBe(
        "allow",
      );
    }
    for (const command of [
      "echo ok; r\\m target",
      "echo ok; r'm' target",
      "echo ok; r\\\nm target",
      "echo ok # literal\nrm target",
      "echo ok; /bin/rm target",
    ]) {
      expect(checker.check("Bash", "command", { command }).effect).toBe("deny");
    }
    expect(
      analyzeShell("echo 'a;b' | cat").commands.map((part) => part.words),
    ).toEqual([["echo", "a;b"], ["cat"]]);
    expect(
      analyzeShell("Write-Output 'it''s; literal' & Write-Output done", true)
        .commands,
    ).toHaveLength(2);
  });

  it.each([
    "echo $(rm target)",
    'echo "`rm target`"',
    "(rm target)",
    "if true; then rm target; fi",
    "env rm target",
    "r[m] target",
    'bash -c "rm target"',
    "echo ok > target",
    "REVIEW_PROBE+=x rm target",
  ])("does not let prefixes authorize uninspectable syntax: %s", (command) => {
    const directory = cwd();
    rules(directory, [
      { rule: "Bash(echo*)", effect: "allow" },
      { rule: "Bash(rm *)", effect: "deny" },
    ]);
    for (const mode of ["default", "bypassPermissions"] as const) {
      expect(
        new PermissionChecker(directory, mode).check("Bash", "command", {
          command,
        }).effect,
      ).toBe("deny");
    }
  });
});

describe("remembered scopes", () => {
  it("retains two words plus * and requires authorization for all command segments", () => {
    const directory = cwd();
    const checker = new PermissionChecker(directory);
    checker.allowAlways("Bash", { command: "git push origin main" });
    expect(
      readFileSync(projectPath(directory, "permissions.yaml"), "utf8"),
    ).toContain("Bash(git push*)");
    expect(
      checker.check("Bash", "command", { command: "git push upstream dev" })
        .effect,
    ).toBe("allow");
    for (const separator of separators) {
      expect(
        checker.check("Bash", "command", {
          command: `git push origin main ${separator} curl example.invalid`,
        }).effect,
      ).toBe("ask");
    }
    expect(
      checker.rememberPatterns("Bash", {
        command: "git push origin main && git status",
      }),
    ).toEqual(["Bash(git push*)", "Bash(git status*)"]);
    checker.allowAlways("Bash", {
      command: "git push origin main && git status",
    });
    expect(
      checker.check("Bash", "command", {
        command: "git push upstream main; git status --short",
      }).effect,
    ).toBe("allow");
  });

  it("does not reinterpret a quoted executable containing spaces as an authorized command family", () => {
    const checker = new PermissionChecker(cwd());
    checker.allowAlways("Bash", { command: "git push origin main" });
    expect(
      checker.check("Bash", "command", { command: "'git push' payload" })
        .effect,
    ).toBe("ask");
  });

  it("never invents a wildcard for tools with no stable target", async () => {
    const directory = cwd();
    const checker = new PermissionChecker(directory);
    for (const tool of [
      "Agent",
      "ExitWorktree",
      "SendMessage",
      "mcp__server__write",
      "ComputerUse",
    ]) {
      expect(checker.rememberPatterns(tool, {})).toEqual([]);
      checker.allowAlways(tool, {});
    }
    expect(existsSync(projectPath(directory, "permissions.yaml"))).toBe(false);
    expect(
      await requestToolPermission(
        () => Promise.resolve("allowAlways"),
        "Agent",
        {},
        { effect: "ask", reason: "test" },
        "id",
      ),
    ).toBe("allow");
    expect(
      checker.rememberPatterns("Bash", {
        command: "git push && echo $(whoami)",
      }),
    ).toEqual([]);
  });

  it("persists the displayed path scope even when a symlink changes during approval", () => {
    const directory = cwd();
    const first = cwd();
    const second = cwd();
    const alias = join(directory, "alias");
    symlinkSync(first, alias);
    const checker = new PermissionChecker(directory);
    const args = { file_path: join(alias, "new.md") };
    const preview = checker.rememberPatterns("WriteFile", args);
    rmSync(alias);
    symlinkSync(second, alias);
    checker.allowAlways("WriteFile", args, preview);
    expect(
      checker.check("WriteFile", "write", { file_path: join(first, "a.md") })
        .effect,
    ).toBe("allow");
    expect(checker.check("WriteFile", "write", args).effect).toBe("ask");
  });

  it("remembers the full MCP target without a suffix wildcard", () => {
    const checker = new PermissionChecker(cwd());
    checker.allowAlways("McpCall", { server: "linear", tool: "update_issue" });
    expect(
      checker.rememberPatterns("McpCall", {
        server: "linear",
        tool: "update_issue",
      }),
    ).toEqual(["McpCall(linear__update_issue)"]);
    expect(
      checker.check("McpCall", "command", {
        server: "linear",
        tool: "update_issue",
      }).effect,
    ).toBe("allow");
    expect(
      checker.check("McpCall", "command", {
        server: "linear",
        tool: "update_issue_other",
      }).effect,
    ).toBe("ask");
  });
});

describe("canonical file rules", () => {
  it("uses one path for relative, absolute, tilde and symlink spellings", () => {
    const directory = cwd();
    mkdirSync(join(directory, "allowed"));
    symlinkSync(join(directory, "allowed"), join(directory, "alias"));
    const home = homedir();
    symlinkSync(join(directory, "allowed"), join(home, "permitted"));
    rules(directory, [{ rule: "WriteFile(allowed/*)", effect: "allow" }]);
    const checker = new PermissionChecker(directory);
    for (const file_path of [
      "allowed/new.md",
      join(directory, "allowed/new.md"),
      "alias/new.md",
      "~/permitted/new.md",
    ]) {
      expect(checker.check("WriteFile", "write", { file_path }).effect).toBe(
        "allow",
      );
    }
    expect(
      checker.check("WriteFile", "write", {
        file_path: "allowed/../../outside.md",
      }).effect,
    ).toBe("ask");
    const external = cwd();
    symlinkSync(external, join(directory, "allowed", "escape"));
    expect(
      checker.check("WriteFile", "write", {
        file_path: "allowed/escape/file.md",
      }).effect,
    ).toBe("ask");
    checker.allowAlways("WriteFile", { file_path: "alias/new.md" });
    expect(
      checker.rememberPatterns("WriteFile", { file_path: "alias/new.md" }),
    ).toEqual([`WriteFile(${canonicalPath(join(directory, "allowed"))}/*)`]);
  });

  it("preserves explicit outside-root grants and rejects malformed rules without crashing", () => {
    const directory = cwd();
    rules(directory, [
      { rule: "WriteFile(/explicitly-approved-outside/*)", effect: "allow" },
    ]);
    const checker = new PermissionChecker(directory);
    expect(
      checker.check("WriteFile", "write", {
        file_path: "/explicitly-approved-outside/file.md",
      }),
    ).toEqual({ effect: "allow", reason: "Permission rule: allow" });
    writeFileSync(projectPath(directory, "permissions.yaml"), ": [invalid");
    expect(
      checker.check("Bash", "command", { command: "echo ok" }).effect,
    ).toBe("deny");
  });

  it("handles dangling symlinks and resolution failures without authorizing the original path", async () => {
    const directory = cwd();
    const external = cwd();
    mkdirSync(join(directory, "allowed"));
    symlinkSync(
      join(external, "new.md"),
      join(directory, "allowed", "dangling.md"),
    );
    symlinkSync("loop", join(directory, "loop"));
    rules(directory, [{ rule: "WriteFile(allowed/*)", effect: "allow" }]);
    const checker = new PermissionChecker(directory, "acceptEdits");
    expect(
      checker.check("WriteFile", "write", { file_path: "allowed/dangling.md" })
        .reason,
    ).not.toBe("Permission rule: allow");
    expect(
      checker.check("ReadFile", "read", { file_path: "loop" }).effect,
    ).toBe("deny");
    const registry = new ToolRegistry();
    registry.register(new ReadFileTool());
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream() {
        await Promise.resolve();
        yield {
          type: "tool_call_complete",
          toolId: "loop-read",
          toolName: "ReadFile",
          arguments: { file_path: "loop" },
        };
        yield {
          type: "stream_end",
          stopReason: "tool_use",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        };
      },
    };
    const conversation = new ConversationManager();
    conversation.addUserMessage("read");
    const agent = new Agent({
      client,
      registry,
      checker,
      conversation,
      cwd: directory,
      maxIterations: 1,
    });
    const results = [];
    for await (const event of agent.run()) {
      if (event.type === "tool_result") {
        results.push(event);
      }
    }
    expect(results).toEqual([
      expect.objectContaining({ toolId: "loop-read", isError: true }),
    ]);
  });
});

describe("unattended memory permissions", () => {
  it.each(["deny", "ask"])(
    "rejects explicit %s inside memory while preserving the scope boundary",
    (effect) => {
      const directory = cwd();
      rules(
        directory,
        ["WriteFile", "EditFile", "ReadFile", "Grep", "Glob"].map((tool) => ({
          rule: `${tool}(*)`,
          effect,
        })),
      );
      const checker = new MemoryPermissionChecker(directory, true);
      for (const tool of [
        "WriteFile",
        "EditFile",
        "ReadFile",
        "Grep",
        "Glob",
      ]) {
        expect(
          checker.check(
            tool,
            tool.endsWith("File") && tool !== "ReadFile" ? "write" : "read",
            {
              file_path: projectPath(directory, "memory", "a.md"),
              path: projectPath(directory, "memory"),
              pattern: "*.md",
            },
          ).effect,
        ).toBe("deny");
      }
    },
  );

  it("allows absolute and tilde memory globs but rejects external and compound escapes", async () => {
    const directory = cwd();
    const memory = projectPath(directory, "memory");
    mkdirSync(memory, { recursive: true });
    mkdirSync(yukinoPath("memory"), { recursive: true });
    writeFileSync(join(memory, "topic.md"), "memory");
    writeFileSync(yukinoPath("memory", "user.md"), "user");
    const external = cwd();
    writeFileSync(join(external, "hidden.md"), "hidden");
    symlinkSync(external, join(memory, "escape"));
    symlinkSync(join(external, "hidden.md"), join(memory, "linked.md"));
    const checker = new MemoryPermissionChecker(directory);
    for (const pattern of [`${memory}/**/*.md`, "~/.yukino/memory/*.md"]) {
      const args = { path: directory, pattern };
      expect(checker.check("Glob", "read", args).effect).toBe("allow");
      const result = await new GlobTool().execute(
        { cwd: directory, permissionChecker: checker },
        args,
      );
      expect(result.isError).toBe(false);
      expect(result.output).not.toMatch(/hidden|linked|escape/);
      expect(result.output).toMatch(/topic\.md|user\.md/);
    }
    for (const pattern of [
      `${external}/*.md`,
      "../*.md",
      "{*.md,../../*}",
      "*/../*.md",
      "escape/*.md",
    ]) {
      expect(
        checker.check("Glob", "read", { path: memory, pattern }).effect,
      ).toBe("deny");
    }
    const consolidator = new MemoryPermissionChecker(directory, true);
    expect(
      consolidator.check("Glob", "read", {
        path: getSessionsDir(directory),
        pattern: "**/*.jsonl",
      }).effect,
    ).toBe("allow");
    expect(
      checker.check("Grep", "read", { path: memory, pattern: "../(a|b)" })
        .effect,
    ).toBe("allow");
    const grep = await new GrepTool().execute(
      { cwd: directory, permissionChecker: checker },
      { path: memory, pattern: "hidden" },
    );
    expect(grep.output).not.toContain("hidden.md");
    rules(directory, [{ rule: "WriteFile(*)", effect: "allow" }]);
    expect(
      checker.check("WriteFile", "write", { file_path: join(external, "x.md") })
        .effect,
    ).toBe("deny");
    expect(
      checker.check("WriteFile", "write", { file_path: join(memory, "x.ts") })
        .effect,
    ).toBe("deny");
  });

  it("applies write denial to the text fallback and index rebuild too", async () => {
    const directory = cwd();
    rules(directory, [{ rule: "WriteFile(*)", effect: "ask" }]);
    const client: LLMClient = {
      setSystemPrompt: vi.fn(),
      async *stream() {
        await Promise.resolve();
        yield {
          type: "text_delta",
          text: "MEMORY_NAME: topic\nMEMORY_TYPE: project\nMEMORY_DESC: hint\nMEMORY_BODY: body",
        };
        yield {
          type: "stream_end",
          stopReason: "end_turn",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        };
      },
    };
    expect(
      await new MemoryExtractor(client, directory).extract("summary"),
    ).toEqual([]);
    expect(existsSync(projectPath(directory, "memory", "topic.md"))).toBe(
      false,
    );
    expect(existsSync(projectPath(directory, "memory", "MEMORY.md"))).toBe(
      false,
    );
  });
});
