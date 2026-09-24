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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, it, expect } from "vitest";

import {
  clampThinkingLevel,
  DEFAULT_MAX_OUTPUT_TOKENS,
  forkEnabled,
  getContextWindow,
  getMaxOutputTokens,
  getSupportedThinkingLevels,
  getThinkingLevel,
  isValidThinkingLevel,
  loadConfig,
  loadProjectMcpServers,
  ProviderConfigSchema,
  resolveAPIKey,
  THINKING_LEVELS,
  thinkingBudgetForLevel,
  toReasoningEffort,
  withProjectMcpServers,
  withProviderDefaults,
  type AppConfig,
  type MCPServerConfig,
  type ProviderConfig,
} from "@/config/index.js";

describe("config", () => {
  describe("getContextWindow", () => {
    it("returns configured value if set", () => {
      const p: ProviderConfig = {
        context_window: 100000,
        name: "p",
        protocol: "anthropic",
        base_url: "#",
        model: "",
      };
      expect(getContextWindow(p)).toBe(100000);
    });

    it("uses the 1M default independently of model names", () => {
      const p: ProviderConfig = {
        model: "claude-sonnet-4-6",
        name: "p",
        protocol: "anthropic",
        base_url: "#",
      };
      expect(getContextWindow(p)).toBe(1000000);
    });

    it("uses the same default for OpenAI models", () => {
      const p: ProviderConfig = {
        model: "gpt-4o",
        name: "p",
        protocol: "openai",
        base_url: "#",
      };
      expect(getContextWindow(p)).toBe(1000000);
    });
  });

  describe("getMaxOutputTokens", () => {
    const base = {
      name: "p",
      base_url: "#",
      protocol: "anthropic",
      model: "m",
    } as const;

    it("returns the configured cap when set", () => {
      expect(getMaxOutputTokens({ ...base, max_output_tokens: 4096 })).toBe(
        4096,
      );
    });

    it("falls back to the 128k default", () => {
      expect(getMaxOutputTokens({ ...base })).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    });

    it("ignores non-positive or non-integer values", () => {
      expect(getMaxOutputTokens({ ...base, max_output_tokens: 0 })).toBe(
        DEFAULT_MAX_OUTPUT_TOKENS,
      );
      expect(getMaxOutputTokens({ ...base, max_output_tokens: 1.5 })).toBe(
        DEFAULT_MAX_OUTPUT_TOKENS,
      );
    });

    it("never exceeds the context window (PI clampMaxTokensToContext)", () => {
      expect(
        getMaxOutputTokens({
          ...base,
          context_window: 16_000,
          max_output_tokens: 32_000,
        }),
      ).toBe(16_000);
      expect(getMaxOutputTokens({ ...base, context_window: 16_000 })).toBe(
        16_000,
      );
    });
  });

  describe("getThinkingLevel", () => {
    const base = {
      name: "p",
      base_url: "#",
      protocol: "anthropic",
      model: "m",
    } as const;

    it("defaults to high for every protocol when unset", () => {
      expect(getThinkingLevel({ ...base })).toBe("high");
      expect(getThinkingLevel({ ...base, protocol: "openai" })).toBe("high");
      expect(getThinkingLevel({ ...base, protocol: "openai-compat" })).toBe(
        "high",
      );
    });

    it("passes an explicit level through", () => {
      expect(getThinkingLevel({ ...base, thinking: "max" })).toBe("max");
      expect(getThinkingLevel({ ...base, thinking: "off" })).toBe("off");
      expect(
        getThinkingLevel({ ...base, protocol: "openai", thinking: "low" }),
      ).toBe("low");
    });
  });

  describe("withProviderDefaults", () => {
    it("normalizes thinking and carries the output cap", () => {
      const provider = withProviderDefaults({
        name: "p",
        protocol: "openai",
        base_url: "#",
        model: "m",
      });
      expect(provider.thinking).toBe("high");
      expect(provider.context_window).toBe(1000000);
      expect(provider.max_output_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    });
  });

  describe("thinking level helpers", () => {
    it("validates level strings", () => {
      expect(isValidThinkingLevel("high")).toBe(true);
      expect(isValidThinkingLevel("bogus")).toBe(false);
    });

    it("maps levels to anthropic thinking budgets", () => {
      expect(thinkingBudgetForLevel("minimal")).toBe(1024);
      expect(thinkingBudgetForLevel("high")).toBe(16384);
      expect(thinkingBudgetForLevel("max")).toBe(65536);
      expect(thinkingBudgetForLevel("off")).toBe(0);
    });

    it("maps levels to OpenAI reasoning effort", () => {
      expect(toReasoningEffort("off")).toBe("none");
      expect(toReasoningEffort("low")).toBe("low");
      expect(toReasoningEffort("max")).toBe("max");
    });
  });

  describe("explicit thinking capabilities", () => {
    const base: ProviderConfig = {
      name: "p",
      base_url: "#",
      protocol: "openai",
      model: "m",
    };

    it.each(["gpt-4o", "o3", "claude-haiku", "arbitrary-model"])(
      "does not infer capabilities from %s",
      (model) => {
        expect(getSupportedThinkingLevels({ ...base, model })).toEqual(
          THINKING_LEVELS,
        );
        expect(getThinkingLevel({ ...base, model })).toBe("high");
      },
    );

    it("retains capability metadata and unrecognized fields while adding defaults", () => {
      const provider = withProviderDefaults(
        ProviderConfigSchema.parse({
          ...base,
          reasoning: true,
          thinking_mode: "adaptive",
          thinking_level_map: { low: "medium", xhigh: null },
          future_capability: { enabled: true },
        }),
      );
      expect(provider).toMatchObject({
        reasoning: true,
        thinking_mode: "adaptive",
        thinking_level_map: { low: "medium", xhigh: null },
        future_capability: { enabled: true },
        thinking: "high",
        context_window: 1000000,
        max_output_tokens: 128000,
      });
    });

    it.each([
      { reasoning: "false" },
      { thinking_mode: "automatic" },
      { thinking_level_map: { high: "unsupported-native-effort" } },
      { thinking_level_map: { unknown: "low" } },
      { thinking_level_map: { off: "high" } },
      { thinking_level_map: { max: false } },
    ])("rejects malformed capabilities: %j", (metadata) => {
      expect(
        ProviderConfigSchema.safeParse({ ...base, ...metadata }).success,
      ).toBe(false);
    });

    it("only exposes off when configured as non-reasoning", () => {
      const provider = { ...base, reasoning: false };
      expect(getSupportedThinkingLevels(provider)).toEqual(["off"]);
      expect(getThinkingLevel(provider)).toBe("off");
      expect(toReasoningEffort("off", provider)).toBeNull();
      expect(withProviderDefaults(provider).thinking).toBe("off");
    });

    it("uses partial overrides and clamps down rather than raising a requested level", () => {
      const provider: ProviderConfig = {
        ...base,
        thinking_level_map: {
          minimal: null,
          low: null,
          high: null,
          max: "max",
        },
      };
      expect(getSupportedThinkingLevels(provider)).toEqual([
        "off",
        "medium",
        "xhigh",
        "max",
      ]);
      expect(clampThinkingLevel(provider, "low")).toBe("off");
      expect(clampThinkingLevel(provider, "high")).toBe("medium");
      expect(clampThinkingLevel(provider, "max")).toBe("max");
      expect(getThinkingLevel(provider)).toBe("medium");
      expect(toReasoningEffort("max", provider)).toBe("max");
    });

    it("accounts for the context-clamped Anthropic budget ceiling", () => {
      const provider: ProviderConfig = {
        ...base,
        protocol: "anthropic",
        context_window: 1024,
        max_output_tokens: 128000,
      };
      expect(getSupportedThinkingLevels(provider)).toEqual(["off"]);
      expect(getThinkingLevel(provider)).toBe("off");
      expect(
        getSupportedThinkingLevels({ ...provider, thinking_mode: "adaptive" }),
      ).toEqual(THINKING_LEVELS);
    });
  });

  describe("resolveAPIKey", () => {
    it("returns config api_key first", () => {
      const p: ProviderConfig = {
        api_key: "sk-test",
        name: "p",
        base_url: "#",
        protocol: "anthropic",
        model: "m",
      };
      expect(resolveAPIKey(p)).toBe("sk-test");
    });

    it("falls back to env var", () => {
      process.env.ANTHROPIC_API_KEY = "sk-from-env";
      const p: ProviderConfig = {
        name: "p",
        base_url: "#",
        protocol: "anthropic",
        model: "m",
      };
      expect(resolveAPIKey(p)).toBe("sk-from-env");
      delete process.env.ANTHROPIC_API_KEY;
    });
  });

  // enable_fork is on by default, and an explicit false in the config must
  // actually turn it off. Storing it as a required boolean would make "unset"
  // indistinguishable from "set to false", so the latter could never be disabled.
  describe("enable_fork", () => {
    const bare = (): AppConfig => ({
      providers: [],
      mcp_servers: [],
      hooks: [],
    });

    it("defaults to enabled when unset", () => {
      expect(forkEnabled(bare())).toBe(true);
    });

    it("disables for real when set to false", () => {
      expect(forkEnabled({ ...bare(), enable_fork: false })).toBe(false);
      expect(forkEnabled({ ...bare(), enable_fork: true })).toBe(true);
    });
  });

  // .mcp.json is the project-level, Claude Code-compatible MCP config. It ships
  // with the repository, so malformed content must degrade to "no servers"
  // instead of breaking startup, and user-level config wins on name collisions.
  describe("project .mcp.json", () => {
    let dir: string;

    const writeMcpJson = (content: string) => {
      writeFileSync(join(dir, ".mcp.json"), content, "utf-8");
    };

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "yukino-mcp-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("returns [] when the file is absent", () => {
      expect(loadProjectMcpServers(dir)).toEqual([]);
    });

    it("maps stdio, http and sse entries onto MCPServerConfig", () => {
      writeMcpJson(
        JSON.stringify({
          mcpServers: {
            db: {
              command: "npx",
              args: ["-y", "db-mcp"],
              env: { API_KEY: "${DB_KEY}" },
            },
            web: { url: "https://example.com/mcp" },
            legacy: {
              type: "sse",
              url: "https://example.com/sse",
              headers: { A: "b" },
            },
          },
        }),
      );
      expect(loadProjectMcpServers(dir)).toEqual([
        {
          name: "db",
          command: "npx",
          args: ["-y", "db-mcp"],
          env: { API_KEY: "${DB_KEY}" },
        },
        { name: "web", url: "https://example.com/mcp", transport: "http" },
        {
          name: "legacy",
          url: "https://example.com/sse",
          transport: "sse",
          headers: { A: "b" },
        },
      ]);
    });

    it("skips entries missing the field their transport needs", () => {
      writeMcpJson(
        JSON.stringify({
          mcpServers: {
            empty: {},
            noUrl: { type: "http" },
            noCommand: { type: "stdio", args: ["x"] },
            ambiguous: { command: "stdio", url: "https://example.com/mcp" },
            ok: { command: "true" },
          },
        }),
      );
      expect(loadProjectMcpServers(dir)).toEqual([
        { name: "ok", command: "true" },
      ]);
    });

    it("degrades to [] on malformed JSON or schema violations", () => {
      writeMcpJson("{not json");
      expect(loadProjectMcpServers(dir)).toEqual([]);

      writeMcpJson(JSON.stringify({ mcpServers: { bad: { command: 42 } } }));
      expect(loadProjectMcpServers(dir)).toEqual([]);
    });

    it("keeps valid servers when a sibling entry is invalid", () => {
      writeMcpJson(
        JSON.stringify({
          mcpServers: {
            bad: { command: 42 },
            good: { command: "good-server" },
          },
        }),
      );
      expect(loadProjectMcpServers(dir)).toEqual([
        { name: "good", command: "good-server" },
      ]);
    });

    it("appends project servers and lets user config win on collisions", () => {
      writeMcpJson(
        JSON.stringify({
          mcpServers: {
            shared: { command: "project-binary" },
            extra: { command: "extra-binary" },
          },
        }),
      );
      const user: MCPServerConfig = { name: "shared", command: "user-binary" };
      const base: AppConfig = { providers: [], mcp_servers: [user], hooks: [] };
      const merged = withProjectMcpServers(base, dir);
      expect(merged.mcp_servers).toEqual([
        { name: "shared", command: "user-binary" },
        { name: "extra", command: "extra-binary" },
      ]);
      // The input config must stay untouched.
      expect(base.mcp_servers).toEqual([user]);
    });

    it("returns the config unchanged when there is no .mcp.json", () => {
      const base: AppConfig = { providers: [], mcp_servers: [], hooks: [] };
      expect(withProjectMcpServers(base, dir)).toBe(base);
    });

    it("rejects duplicate provider base URLs because base_url is the identity", () => {
      const path = join(dir, "config.yaml");
      writeFileSync(
        path,
        [
          "providers:",
          "  - name: first",
          "    protocol: anthropic",
          "    base_url: https://same.example.com",
          "    model: first-model",
          "  - name: second",
          "    protocol: openai",
          "    base_url: https://same.example.com",
          "    model: second-model",
          "",
        ].join("\n"),
      );
      expect(() => loadConfig(path)).toThrow(/duplicate base_url/);
    });

    it("rejects ambiguous or unusable user-level MCP server entries", () => {
      const path = join(dir, "config.yaml");
      writeFileSync(
        path,
        [
          "providers:",
          "  - name: provider",
          "    protocol: anthropic",
          "    base_url: https://provider.example.com",
          "    model: model",
          "mcp_servers:",
          "  - name: broken",
          "    command: command",
          "    url: https://example.com/mcp",
          "",
        ].join("\n"),
      );
      expect(() => loadConfig(path)).toThrow(/exactly one of command or url/);

      writeFileSync(
        path,
        [
          "providers:",
          "  - name: provider",
          "    protocol: anthropic",
          "    base_url: https://provider.example.com",
          "    model: model",
          "mcp_servers:",
          "  - name: broken",
          "    command: 42",
          "",
        ].join("\n"),
      );
      expect(() => loadConfig(path)).toThrow(
        /Invalid MCP server configuration/,
      );
    });

    it("loads the sandbox-runtime backend", () => {
      const path = join(dir, "config.yaml");
      writeFileSync(
        path,
        [
          "providers:",
          "  - name: provider",
          "    protocol: anthropic",
          "    base_url: https://provider.example.com",
          "    model: model",
          "sandbox:",
          "  enabled: true",
          "  backend: sandbox-runtime",
          "  auto_allow: true",
          "  network_enabled: false",
          "",
        ].join("\n"),
      );

      expect(loadConfig(path).sandbox).toEqual({
        enabled: true,
        backend: "sandbox-runtime",
        auto_allow: true,
        network_enabled: false,
      });
    });

    it("rejects unknown sandbox backends", () => {
      const path = join(dir, "config.yaml");
      writeFileSync(
        path,
        [
          "providers:",
          "  - name: provider",
          "    protocol: anthropic",
          "    base_url: https://provider.example.com",
          "    model: model",
          "sandbox:",
          "  backend: unknown",
          "",
        ].join("\n"),
      );

      expect(() => loadConfig(path)).toThrow(/Invalid sandbox configuration/);
    });
  });
});
