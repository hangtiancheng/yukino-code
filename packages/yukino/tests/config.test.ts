import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVELS,
} from "@/config/constants.js";
import {
  AppConfigSchema,
  loadConfig,
  applyConfigEnv,
  ProjectConfigSchema,
  ProjectMcpServerConfigSchema,
  resolveAPIKey,
  hydrateConfigEnv,
  memoryEnabled,
  type AppConfig,
} from "@/config/index.js";
import { RuntimePreferencesSchema } from "@/config/preferences.js";
import {
  clampThinkingLevel,
  getContextWindow,
  getMaxOutputTokens,
  getSupportedThinkingLevels,
  getThinkingLevel,
  isValidThinkingLevel,
  ProviderConfigSchema,
  thinkingBudgetForLevel,
  toReasoningEffort,
  withProviderDefaults,
  type ProviderConfig,
} from "@/config/provider-config.js";
import { mergeProjectConfig } from "@/project/config.js";

describe("config", () => {
  describe("project endpoint binding without discovery", () => {
    afterEach(() => vi.unstubAllEnvs());

    function merge(
      settings: unknown,
      overrides: Partial<AppConfig> = {},
      apiKey: string | undefined = "global-secret",
    ) {
      const base = AppConfigSchema.parse({
        providers: [
          {
            name: "global",
            protocol: "openai",
            base_url: "https://global.example/v1",
            model: "global-model",
            api_key: apiKey,
            reasoning: true,
            thinking: "low",
            thinking_mode: "adaptive",
            thinking_level_map: { high: "low" },
            context_window: 32000,
            max_output_tokens: 2048,
            price: {
              currency: "USD",
              source: "global",
              effective_at: "2026-01-01T00:00:00Z",
              input: 10,
              output: 20,
            },
            cache: {
              mode: "long",
              capabilities: {
                verified: true,
                mapping: "openai_retention",
                long: { ttl_seconds: 3600, min_tokens: 1024 },
              },
            },
            warming: { mode: "idle", reuse_probability: 1 },
            future_model_metadata: true,
          },
        ],
      });
      const result = mergeProjectConfig(
        base,
        {
          cwd: tmpdir(),
          identity: "unit",
          fingerprint: "unit",
          manifest: [],
          configPath: join(tmpdir(), "yukino-project-unit.yaml"),
          config: ProjectConfigSchema.parse(settings),
          mcpServers: [],
          mcpSources: new Map(),
          resources: { prompts: [], skills: [], workflow: [] },
          extensions: [],
        },
        overrides,
        true,
      );
      return { provider: result.config.providers[0], base };
    }

    function expectReset(provider: ProviderConfig): void {
      for (const field of [
        "price",
        "cache",
        "warming",
        "reasoning",
        "thinking_mode",
        "thinking_level_map",
        "future_model_metadata",
      ]) {
        expect(provider[field]).toBeUndefined();
      }
      expect(provider.thinking).toBe(DEFAULT_THINKING_LEVEL);
      expect(provider.context_window).toBe(DEFAULT_CONTEXT_WINDOW);
      expect(provider.max_output_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    }

    it.each([
      { model: "unknown-model" },
      { model: "unknown-model", endpoint: "https://GLOBAL.example:443/v1" },
      { providers: [{ name: "global", model: "unknown-model" }] },
      {
        providers: [
          {
            name: "global",
            model: "unknown-model",
            base_url: "https://GLOBAL.example:443/v1",
          },
        ],
      },
      { providers: [{ name: "global", protocol: "openai-compat" }] },
    ])(
      "keeps keys but not old model metadata at the same endpoint: %j",
      (settings) => {
        const { provider, base } = merge(settings);
        expect(resolveAPIKey(provider)).toBe("global-secret");
        expectReset(provider);
        expect(base.providers[0].price?.input).toBe(10);
        expect(base.providers[0].api_key).toBe("global-secret");
      },
    );

    it.each([
      { endpoint: "https://new.example/v1" },
      { endpoint: "https://global.example/v2" },
      { providers: [{ name: "global", base_url: "https://new.example/v1" }] },
      {
        providers: [
          {
            name: "new",
            protocol: "openai",
            base_url: "https://new.example/v1",
            model: "unknown-model",
          },
        ],
      },
    ])(
      "clears keys, ambient fallback and stale prices across endpoints: %j",
      (settings) => {
        vi.stubEnv("OPENAI_API_KEY", "ambient-secret");
        const { provider } = merge(settings);
        expect(provider.api_key).toBe("");
        expect(resolveAPIKey(provider)).toBe("");
        expectReset(provider);
      },
    );

    it.each([
      { model: "global-model", endpoint: "https://GLOBAL.example:443/v1" },
      {
        providers: [
          {
            name: "global",
            model: "global-model",
            protocol: "openai",
            base_url: "https://GLOBAL.example:443/v1",
          },
        ],
      },
    ])(
      "preserves unchanged normalized endpoint/model metadata: %j",
      (settings) => {
        const { provider, base } = merge(settings);
        expect(provider).toMatchObject({
          ...base.providers[0],
          base_url: "https://GLOBAL.example:443/v1",
        });
        expect(resolveAPIKey(provider)).toBe("global-secret");
      },
    );

    it("binds call-level overrides by endpoint rather than model", () => {
      vi.stubEnv("OPENAI_API_KEY", "ambient-secret");
      const same = merge({}, { model: "call-model" }).provider;
      expect(resolveAPIKey(same)).toBe("global-secret");
      expectReset(same);
      const other = merge({}, { endpoint: "https://call.example/v1" }).provider;
      expect(resolveAPIKey(other)).toBe("");
      expectReset(other);
    });

    it("keeps explicit model preferences but not stale price/cache capabilities", () => {
      const { provider } = merge({
        providers: [
          {
            name: "global",
            model: "unknown-model",
            thinking: "medium",
            context_window: 64000,
            max_output_tokens: 4096,
          },
        ],
      });
      expect(provider).toMatchObject({
        api_key: "global-secret",
        thinking: "medium",
        context_window: 64000,
        max_output_tokens: 4096,
      });
      expect(provider.price).toBeUndefined();
      expect(provider.cache).toBeUndefined();
      expect(provider.warming).toBeUndefined();
    });

    it.each([
      { inherit_env: false },
      { inherit_env: undefined },
      { cwd: "/forged" },
      { oauth: { issuer: "https://auth.example", client_id: "client" } },
      { dynamic: false },
      { owner: "global" },
      { source: "trusted" },
      { client_secret: "secret" },
      { credentials: "secret" },
    ])(
      "rejects project authority/credential fields even on disabled MCP entries: %j",
      (fields) => {
        const server = { name: "repo", enabled: false, ...fields };
        expect(ProjectMcpServerConfigSchema.safeParse(server).success).toBe(
          false,
        );
        expect(
          ProjectConfigSchema.safeParse({ mcp_servers: [server] }).success,
        ).toBe(false);
      },
    );

    it("accepts disabled project MCP resources without an endpoint", () => {
      const settings = { mcp_servers: [{ name: "removed", enabled: false }] };
      expect(ProjectConfigSchema.parse(settings)).toEqual(settings);
    });
  });
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
        model: "deepseek-flash",
        name: "p",
        protocol: "anthropic",
        base_url: "#",
      };
      expect(getContextWindow(p)).toBe(1000000);
    });

    it("uses the same default for OpenAI models", () => {
      const p: ProviderConfig = {
        model: "deepseek-flash",
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

    it.each(["deepseek-flash", "qwen3.8-flash", "arbitrary-model"])(
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
      const previous = process.env.ANTHROPIC_API_KEY;
      try {
        process.env.ANTHROPIC_API_KEY = "sk-from-env";
        const p: ProviderConfig = {
          name: "p",
          base_url: "#",
          protocol: "anthropic",
          model: "m",
        };
        expect(resolveAPIKey(p)).toBe("sk-from-env");
      } finally {
        if (previous === undefined) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          process.env.ANTHROPIC_API_KEY = previous;
        }
      }
    });
  });

  // memory is on by default, and an explicit false in the config must turn the
  // whole auto-memory pipeline off (index injection, recall, extraction,
  // consolidation). "Unset" stays distinguishable from "explicitly false".
  describe("memory", () => {
    const bare = (): AppConfig => ({
      default_provider: 0,
      ...RuntimePreferencesSchema.parse({}),
      providers: [],
      mcp_servers: [],
      hooks: [],
    });

    it("defaults to enabled when unset", () => {
      expect(memoryEnabled(bare())).toBe(true);
    });

    it("disables for real when set to false", () => {
      expect(memoryEnabled({ ...bare(), enable_memory: false })).toBe(false);
      expect(memoryEnabled({ ...bare(), enable_memory: true })).toBe(true);
    });

    it("parses enable_memory from config.yaml", () => {
      const dir = mkdtempSync(join(tmpdir(), "yukino-memory-"));
      try {
        const path = join(dir, "config.yaml");
        writeFileSync(
          path,
          [
            "providers:",
            "  - name: provider",
            "    protocol: anthropic",
            "    base_url: https://provider.example.com",
            "    model: model",
            "enable_memory: false",
            "",
          ].join("\n"),
        );
        const cfg = loadConfig(path);
        expect(cfg.enable_memory).toBe(false);
        expect(memoryEnabled(cfg)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("runtime preferences", () => {
    function loadPreferences(settings: string): AppConfig {
      const dir = mkdtempSync(join(tmpdir(), "yukino-preferences-"));
      try {
        const path = join(dir, "config.yaml");
        writeFileSync(path, `providers: []\n${settings}\n`);
        return loadConfig(path, { allowEmptyProviders: true });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("defaults to auto with an absent or minimal config", () => {
      expect(
        loadConfig(undefined, { allowEmptyProviders: true }),
      ).toMatchObject({
        ...RuntimePreferencesSchema.parse({}),
      });
      expect(loadPreferences("")).toMatchObject({
        ...RuntimePreferencesSchema.parse({}),
      });
    });

    it("rejects the removed setting without rewriting the configuration", () => {
      const dir = mkdtempSync(join(tmpdir(), "yukino-removed-mcp-"));
      const path = join(dir, "config.yaml");
      const data = "providers: []\nmcp_loading: auto\n";
      try {
        writeFileSync(path, data);
        expect(() => loadConfig(path, { allowEmptyProviders: true })).toThrow(
          /mcp_loading is no longer supported/,
        );
        expect(readFileSync(path, "utf8")).toBe(data);
        expect(
          ProjectConfigSchema.safeParse({ mcp_loading: "auto" }).success,
        ).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each(["off", "on", "only"])("parses code_mode.mode: %s", (enabled) => {
      expect(
        loadPreferences(`code_mode: { mode: ${enabled} }`).code_mode.mode,
      ).toBe(enabled);
    });

    it.each(["auto", "eager", "native", "dispatch", "direct", "null"])(
      "explicitly rejects removed mcp_loading: %s",
      (loading) => {
        expect(() => loadPreferences(`mcp_loading: ${loading}`)).toThrow(
          /mcp_loading is no longer supported/,
        );
      },
    );

    it.each(["auto", "dark", "light"] as const)("parses theme: %s", (theme) => {
      expect(loadPreferences(`theme: ${theme}`).theme).toBe(theme);
    });

    it.each([
      "mcp_loading: invalid",
      "mcp_loading: 1",
      "theme: invalid",
      "theme: true",
      'enable_code_mode: "true"',
      "enable_code_mode: 1",
      "enable_code_mode: null",
    ])("rejects invalid preferences: %s", (settings) => {
      expect(() => loadPreferences(settings)).toThrow(/Invalid configuration/);
    });
  });

  describe("env block", () => {
    const ENV_A = "YUKINO_ENV_BLOCK_TEST_A";
    const ENV_B = "YUKINO_ENV_BLOCK_TEST_B";
    const dirs: string[] = [];

    afterEach(() => {
      delete process.env.YUKINO_ENV_BLOCK_TEST_A;
      delete process.env.YUKINO_ENV_BLOCK_TEST_B;
      for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
      }
      dirs.length = 0;
    });

    const writeConfig = (envLines: string[]): string => {
      const dir = mkdtempSync(join(tmpdir(), "yukino-env-"));
      dirs.push(dir);
      const path = join(dir, "config.yaml");
      writeFileSync(
        path,
        [
          "providers:",
          "  - name: provider",
          "    protocol: anthropic",
          "    base_url: https://provider.example.com",
          "    model: model",
          ...envLines,
          "",
        ].join("\n"),
      );
      return path;
    };

    it("parses a mapping block without mutating process.env", () => {
      const cfg = loadConfig(
        writeConfig(["env:", `  ${ENV_A}: "1"`, `  ${ENV_B}: eager`]),
      );
      expect(cfg.env).toEqual({ [ENV_A]: "1", [ENV_B]: "eager" });
      expect(process.env[ENV_A]).toBeUndefined();
      expect(process.env[ENV_B]).toBeUndefined();
    });

    it("never overrides a variable set in the real environment", () => {
      process.env[ENV_A] = "from-real-env";
      const cfg = loadConfig(
        writeConfig(["env:", `  ${ENV_A}: "from-config"`]),
      );
      applyConfigEnv(cfg.env);
      expect(process.env[ENV_A]).toBe("from-real-env");
    });

    it("accepts the list-of-single-key-mappings form", () => {
      const cfg = loadConfig(
        writeConfig(["env:", `  - ${ENV_A}: 1`, `  - ${ENV_B}: eager`]),
      );
      expect(cfg.env).toEqual({ [ENV_A]: "1", [ENV_B]: "eager" });
      expect(process.env[ENV_A]).toBeUndefined();
      expect(process.env[ENV_B]).toBeUndefined();
    });

    it("stringifies scalars and maps an empty value to the empty string", () => {
      const cfg = loadConfig(
        writeConfig(["env:", `  ${ENV_A}: 1`, `  ${ENV_B}:`]),
      );
      expect(cfg.env).toEqual({ [ENV_A]: "1", [ENV_B]: "" });
      expect(process.env[ENV_A]).toBeUndefined();
      expect(process.env[ENV_B]).toBeUndefined();
    });

    it("treats a bare env key (null block) as empty", () => {
      const cfg = loadConfig(writeConfig(["env:"]));
      expect(cfg.env).toEqual({});
    });

    it("does not apply env when provider validation reports an error", () => {
      const dir = mkdtempSync(join(tmpdir(), "yukino-env-"));
      dirs.push(dir);
      const path = join(dir, "config.yaml");
      writeFileSync(
        path,
        [
          "providers:",
          "  - name: a",
          "    protocol: anthropic",
          "    base_url: https://dup.example.com",
          "    model: m",
          "  - name: b",
          "    protocol: anthropic",
          "    base_url: https://dup.example.com",
          "    model: m",
          "env:",
          `  ${ENV_A}: hydrated`,
          "",
        ].join("\n"),
      );
      expect(() => loadConfig(path)).toThrow(/duplicate base_url/);
      expect(process.env[ENV_A]).toBeUndefined();
    });

    it("hydrateConfigEnv reads the global config", () => {
      const configDir = join(homedir(), ".yukino");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config.yaml"),
        ["providers: []", "env:", `  ${ENV_A}: "1"`].join("\n"),
      );
      hydrateConfigEnv();
      expect(process.env[ENV_A]).toBe("1");
    });

    it("hydrateConfigEnv tolerates a missing or broken config", () => {
      expect(() => {
        hydrateConfigEnv();
      }).not.toThrow();
      const configDir = join(homedir(), ".yukino");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "config.yaml"), "providers: [");
      expect(() => {
        hydrateConfigEnv();
      }).not.toThrow();
      expect(process.env[ENV_A]).toBeUndefined();
    });
  });

  describe("configuration validation", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "yukino-mcp-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it.each([
      { name: "active-without-endpoint" },
      { name: "both", command: "binary", url: "https://server.example/mcp" },
      { name: "command-http", command: "binary", transport: "http" },
      {
        name: "url-stdio",
        url: "https://server.example/mcp",
        transport: "stdio",
      },
      {
        name: "oauth-client",
        url: "https://server.example/mcp",
        oauth: { issuer: "https://auth.example" },
      },
      {
        name: "oauth-stdio",
        command: "binary",
        oauth: { issuer: "https://auth.example", client_id: "client" },
      },
      {
        name: "legacy-sse",
        url: "https://server.example/mcp",
        transport: "sse",
      },
      {
        name: "oauth-header",
        url: "https://server.example/mcp",
        headers: { aUtHoRiZaTiOn: "secret" },
        oauth: { issuer: "https://auth.example", client_id: "client" },
      },
      {
        name: "oauth-secret",
        url: "https://server.example/mcp",
        oauth: {
          issuer: "https://auth.example",
          registration: "dynamic",
          client_secret: "secret",
        },
      },
      {
        name: "collision",
        command: "binary",
        tool_exposure: [
          { tool: "read", exposure: "direct" },
          { tool: "read", exposure: "hidden" },
        ],
      },
      {
        name: "disabled-collision",
        enabled: false,
        command: "binary",
        url: "https://server.example/mcp",
      },
      {
        name: "disabled-oauth",
        enabled: false,
        oauth: { issuer: "https://auth.example" },
      },
      { name: "disabled-unknown", enabled: false, owner: "forged" },
      { name: "disabled-secret", enabled: false, client_secret: "secret" },
    ])("retains complete MCP validation for $name", (server) => {
      expect(
        AppConfigSchema.safeParse({ providers: [], mcp_servers: [server] })
          .success,
      ).toBe(false);
      const path = join(dir, "config.yaml");
      writeFileSync(
        path,
        JSON.stringify({ providers: [], mcp_servers: [server] }),
      );
      expect(() => loadConfig(path, { allowEmptyProviders: true })).toThrow(
        /Invalid configuration/,
      );
    });

    it("accepts disabled named MCP entries without an endpoint", () => {
      const server = { name: "disabled", enabled: false };
      expect(
        AppConfigSchema.parse({ providers: [], mcp_servers: [server] })
          .mcp_servers,
      ).toEqual([server]);
      const path = join(dir, "config.yaml");
      writeFileSync(
        path,
        JSON.stringify({ providers: [], mcp_servers: [server] }),
      );
      expect(
        loadConfig(path, { allowEmptyProviders: true }).mcp_servers,
      ).toEqual([server]);
    });

    it("accepts registered/dynamic OAuth and non-colliding MCP exposure rules", () => {
      const servers = [
        {
          name: "registered",
          url: "https://server.example/mcp",
          transport: "http",
          oauth: {
            issuer: "https://auth.example",
            client_id: "client",
            client_secret: "secret",
          },
        },
        {
          name: "dynamic",
          url: "https://server.example/mcp",
          oauth: { issuer: "https://auth.example", registration: "dynamic" },
          tool_exposure: [
            { tool: "read", exposure: "direct" },
            { tool: "*", exposure: "hidden" },
          ],
        },
      ];
      expect(
        AppConfigSchema.parse({ providers: [], mcp_servers: servers })
          .mcp_servers,
      ).toEqual(servers);
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
      expect(() => loadConfig(path)).toThrow(/Invalid configuration/);
    });
  });
});
