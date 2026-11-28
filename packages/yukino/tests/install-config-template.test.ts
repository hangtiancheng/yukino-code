import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AppConfigSchema, memoryEnabled } from "@/config/index.js";
import { ProviderConfigSchema } from "@/config/provider-config.js";

const root = resolve(import.meta.dirname, "../../..");
const starter = {
  permission_mode: "default",
  providers: [],
  default_provider: 0,
  enable_memory: false,
  enable_coordinator_mode: false,
  code_mode: { mode: "off", inline_budget: 12000 },
  mcp_servers: [],
  hooks: [],
  sandbox: { enabled: false, auto_allow: false, network_enabled: true },
};
const installers = [
  {
    file: "install.sh",
    pattern: /^\tcat >"\$CONFIG_FILE" <<'EOF'\n([\s\S]*?)\nEOF$/gm,
    prefix: [
      'CONFIG_DIR="$HOME/.yukino"',
      'CONFIG_FILE="$CONFIG_DIR/config.yaml"',
      'if [ -f "$CONFIG_FILE" ]; then',
      '\tinfo "Config already exists at $CONFIG_FILE."',
      "else",
      '\tmkdir -p "$CONFIG_DIR"',
      "\tcat >\"$CONFIG_FILE\" <<'EOF'",
    ].join("\n"),
    suffix: 'EOF\n\tok "Wrote default config to $CONFIG_FILE"\nfi',
  },
  {
    file: "install.ps1",
    pattern: /^\t\$DefaultConfig = @'\n([\s\S]*?)\n'@$/gm,
    prefix: [
      '$ConfigDir = Join-Path $HOME ".yukino"',
      '$ConfigFile = Join-Path $ConfigDir "config.yaml"',
      "if (Test-Path -LiteralPath $ConfigFile) {",
      '\tWrite-Info "Config already exists at $ConfigFile."',
      "}",
      "else {",
      "\tNew-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null",
      "\t$DefaultConfig = @'",
    ].join("\n"),
    suffix: [
      "'@",
      "\t[System.IO.File]::WriteAllText($ConfigFile, $DefaultConfig, [System.Text.UTF8Encoding]::new($false))",
      '\tWrite-Ok "Wrote default config to $ConfigFile"',
      "}",
    ].join("\n"),
  },
];

function readTemplate(installer: (typeof installers)[number]) {
  const source = readFileSync(resolve(root, installer.file), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  const matches = [...source.matchAll(installer.pattern)];
  expect(matches).toHaveLength(1);
  const template = matches[0]?.[1];
  if (!template) {
    throw new Error(`Missing literal config template in ${installer.file}`);
  }
  const data: unknown = yaml.load(template);
  return { source, template, data, config: AppConfigSchema.parse(data) };
}

describe("installer config templates (read-only data extraction)", () => {
  it.each(installers)(
    "provides safe minimal defaults in $file",
    (installer) => {
      const { template, data, config } = readTemplate(installer);
      expect(data).toEqual(starter);
      expect(config).toEqual(AppConfigSchema.parse(starter));
      expect(memoryEnabled(config)).toBe(false);
      expect(config.providers).toEqual([]);
      expect(config.mcp_servers).toEqual([]);
      expect(config.hooks).toEqual([]);
      expect(template).not.toMatch(
        /api_key|sk-|https?:\/\/|\$|codegraph|pnpm|command:|env:|headers:|mcp_loading|bypassPermissions/,
      );
    },
  );

  it("keeps shell and PowerShell literal YAML and schema results identical", () => {
    const [shell, powershell] = installers.map(readTemplate);
    expect(shell?.template).toBe(powershell?.template);
    expect(shell?.config).toEqual(powershell?.config);
  });

  it.each(installers)(
    "preserves the existing-file guard in $file",
    (installer) => {
      const { source, template } = readTemplate(installer);
      expect(source).toContain(
        `${installer.prefix}\n${template}\n${installer.suffix}`,
      );
    },
  );

  it.each(installers)(
    "retains full AppConfigSchema refinements for $file",
    (installer) => {
      const { config } = readTemplate(installer);
      expect(
        AppConfigSchema.safeParse({ ...config, mcp_loading: "auto" }).success,
      ).toBe(false);
      for (const server of [
        { name: "missing-endpoint" },
        {
          name: "disabled-both",
          enabled: false,
          command: "binary",
          url: "https://example.test/mcp",
        },
        {
          name: "oauth",
          url: "https://example.test/mcp",
          oauth: { issuer: "https://example.test/auth" },
        },
        {
          name: "rules",
          command: "binary",
          tool_exposure: [
            { tool: "read", exposure: "direct" },
            { tool: "read", exposure: "hidden" },
          ],
        },
      ]) {
        expect(
          AppConfigSchema.safeParse({ ...config, mcp_servers: [server] })
            .success,
        ).toBe(false);
      }
    },
  );

  it("documents the same starter and only disabled opt-in MCP examples", () => {
    const readme = readFileSync(
      resolve(root, "packages/yukino/README.md"),
      "utf8",
    );
    const configuration =
      readme.split("## Configuration\n")[1]?.split("### Telemetry\n")[0] ?? "";
    const blocks = [...configuration.matchAll(/```yaml\n([\s\S]*?)\n```/g)];
    expect(blocks).toHaveLength(3);
    const documentedStarter: unknown = yaml.load(blocks[0]?.[1] ?? "");
    const example: unknown = yaml.load(blocks[1]?.[1] ?? "");
    expect(documentedStarter).toEqual(starter);
    const sampling: unknown = yaml.load(blocks[2]?.[1] ?? "");
    const samplingProvider = ProviderConfigSchema.parse({
      name: "sample",
      protocol: "openai-compat",
      base_url: "https://example.invalid",
      model: "local",
      ...z.record(z.string(), z.unknown()).parse(sampling),
    });
    expect(samplingProvider.sampling_params).toEqual({
      temperature: 0.6,
      top_p: 0.9,
      top_k: 40,
    });
    expect(samplingProvider.sampling_params_by_thinking_level).toEqual({
      off: { temperature: 0.2 },
      high: { temperature: 0.8, top_k: 60 },
    });
    const config = AppConfigSchema.parse(example);
    expect(config.permission_mode).toBe("default");
    expect(config.hooks).toEqual([]);
    expect(config.code_mode).toEqual({ mode: "off", inline_budget: 12000 });
    expect(config.providers).toHaveLength(2);
    expect(config.providers.every((provider) => provider.api_key === "")).toBe(
      true,
    );
    expect(config.mcp_servers).toHaveLength(4);
    expect(config.mcp_servers.every((server) => server.enabled === false)).toBe(
      true,
    );
    expect(config.mcp_servers.map((server) => server.exposure)).toEqual([
      "direct",
      "deferred",
      "codemode",
      "hidden",
    ]);
  });
});
