import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "@yukino.js/agent";
import type { LLMClient } from "@yukino.js/llm/client.js";
import { PermissionChecker } from "@yukino.js/permissions";
import { yukinoPath } from "@yukino.js/storage";
import { loadAgentDefinitions } from "@yukino.js/subagent/loader.js";
import { spawnSubagent } from "@yukino.js/subagent/spawn.js";
import { ToolRegistry } from "@yukino.js/tools/registry.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "yukino-agent-permissions-"));
  vi.stubEnv("HOME", cwd);
  vi.stubEnv("USERPROFILE", cwd);
  mkdirSync(yukinoPath("agents"), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});

describe("custom subagent permission modes", () => {
  it.each(["default", "acceptEdits", "plan", "bypassPermissions"] as const)(
    "loads and applies %s through the production spawn path",
    async (mode) => {
      writeFileSync(
        yukinoPath("agents", "custom.md"),
        `---\nname: custom\npermission_mode: ${mode}\n---\nFollow the assignment.`,
      );
      const definition = loadAgentDefinitions().find(
        (agent) => agent.name === "custom",
      );
      expect(definition?.permissionMode).toBe(mode);
      if (!definition) {
        throw new Error("Custom definition missing");
      }
      const observed: string[] = [];
      vi.spyOn(Agent.prototype, "run").mockImplementation(function (
        this: Agent,
      ) {
        const checker: unknown = Reflect.get(this, "checker");
        if (!(checker instanceof PermissionChecker)) {
          throw new Error("Missing checker");
        }
        observed.push(checker.mode);
        return (async function* () {
          yield await Promise.resolve({ type: "turn_complete" as const });
        })();
      });
      const client: LLMClient = {
        setSystemPrompt: vi.fn(),
        async *stream() {
          yield await Promise.resolve({
            type: "text_delta" as const,
            text: "done",
          });
        },
      };
      const provider = {
        name: "test",
        model: "test",
        api_key: "test",
        base_url: "http://localhost",
        protocol: "anthropic" as const,
      };
      for (const parentMode of [
        "default",
        "acceptEdits",
        "bypassPermissions",
        "plan",
      ] as const) {
        await spawnSubagent(
          definition,
          "task",
          client,
          new ToolRegistry(),
          provider,
          cwd,
          undefined,
          undefined,
          undefined,
          new PermissionChecker(cwd, parentMode),
        );
      }
      expect(observed).toEqual([
        mode,
        mode === "bypassPermissions" ? "bypassPermissions" : "acceptEdits",
        "bypassPermissions",
        mode,
      ]);
    },
  );

  it("rejects unsupported configured modes", () => {
    writeFileSync(
      yukinoPath("agents", "invalid.md"),
      "---\nname: invalid\npermission_mode: dontAsk\n---\nTask",
    );
    expect(
      loadAgentDefinitions().some((agent) => agent.name === "invalid"),
    ).toBe(false);
  });
});
