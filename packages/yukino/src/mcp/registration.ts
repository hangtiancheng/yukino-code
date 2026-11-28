import { expandMcpServerConfigEnvironment } from "@/mcp/client.js";
import { MCPServerConfigSchema, type MCPServerConfig } from "@/mcp/config.js";
import { ENV_REFERENCE_RE, SAFE_CHILD_ENV_KEYS } from "@/project/constants.js";

export function prepareRuntimeMCPServer(
  input: MCPServerConfig,
): MCPServerConfig {
  const config = MCPServerConfigSchema.parse(input);
  if (config.enabled === false) {
    return { ...config, inherit_env: false };
  }
  const safe = Object.fromEntries(
    SAFE_CHILD_ENV_KEYS.flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key] ?? ""]],
    ),
  );
  if (
    Object.values(config.env ?? {}).some((value) =>
      new RegExp(ENV_REFERENCE_RE).test(value),
    )
  ) {
    throw new Error(
      "MCP registration cannot inherit or nest credential references",
    );
  }
  const environment = { ...safe, ...config.env };
  const prepared = expandMcpServerConfigEnvironment(config, environment);
  const stack: unknown[] = [prepared];
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === "string" && new RegExp(ENV_REFERENCE_RE).test(value)) {
      throw new Error(
        "MCP registration cannot inherit or nest credential references",
      );
    }
    if (value && typeof value === "object") {
      const entries: unknown[] = Object.values(value);
      stack.push(...entries);
    }
  }
  return {
    ...prepared,
    inherit_env: false,
    ...(config.command ? { env: { ...safe, ...prepared.env } } : {}),
  };
}

export function mcpRegistrationPreview(
  config: MCPServerConfig,
): Record<string, unknown> {
  const secrets = [
    ...Object.values(config.headers ?? {}),
    ...Object.values(config.env ?? {}).filter(
      (value) => value !== config.url && value !== config.command,
    ),
    config.oauth?.client_secret,
  ].filter((value): value is string => !!value);
  let redactNext = false;
  const argumentsPreview = (config.args ?? []).map((part) => {
    if (redactNext) {
      redactNext = false;
      return "[redacted]";
    }
    if (
      /^--?(?:api[-_]?key|token|secret|password|authorization|cookie)$/iu.test(
        part,
      )
    ) {
      redactNext = true;
      return part;
    }
    return part
      .replace(
        /^(--?(?:api[-_]?key|token|secret|password|authorization|cookie))(?:=|\s+).+/iu,
        "$1=[redacted]",
      )
      .replace(/\b(authorization|cookie)\s*[:=].+/iu, "$1: [redacted]");
  });
  let command = config.command
    ? [config.command, ...argumentsPreview]
        .map((part) => JSON.stringify(part))
        .join(" ")
    : undefined;
  for (const secret of secrets) {
    command = command
      ?.replaceAll(secret, "[redacted]")
      .replaceAll(JSON.stringify(secret).slice(1, -1), "[redacted]");
  }
  let endpoint: string | undefined;
  if (config.url && config.enabled !== false) {
    const url = new URL(config.url);
    endpoint = url.origin + url.pathname;
    for (const secret of secrets) {
      endpoint = endpoint
        .replaceAll(secret, "[redacted]")
        .replaceAll(encodeURIComponent(secret), "[redacted]");
    }
  }
  return {
    server: config.name,
    command,
    endpoint,
    cwd: config.cwd,
    enabled: config.enabled !== false,
    exposure: config.exposure ?? "deferred",
    headerNames: Object.keys(config.headers ?? {}),
    environmentNames: Object.keys(config.env ?? {}),
    oauth: config.oauth
      ? { issuer: new URL(config.oauth.issuer).origin }
      : undefined,
  };
}
