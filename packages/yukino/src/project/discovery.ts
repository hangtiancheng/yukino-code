import { createHash } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { PROJECT_MCP_FILENAME } from "@/config/constants.js";
import {
  ConfigError,
  ProjectMcpServerConfigSchema,
  parseProjectConfig,
  validateMcpServers,
} from "@/config/index.js";
import { globalConfigPath } from "@/config/provider-config.js";
import {
  ESM_EXTENSIONS,
  MAX_RESOURCE_BYTES,
  MAX_RESOURCE_FILES,
  PROJECT_CONFIG_FILENAME,
  PROJECT_DIR_NAME,
  PROJECT_ERRORS,
  PROJECT_PROMPTS_DIR,
  PROJECT_SKILLS_DIR,
  PROJECT_WORKFLOWS_DIR,
  RESOURCE_KINDS,
  UNSAFE_PROJECT_PATH_ERROR,
} from "@/project/constants.js";
import type {
  ProjectDiscovery,
  ProjectManifestEntry,
} from "@/project/types.js";
import { canonicalPath, projectAncestorDirs } from "@/utils/paths.js";

const McpFileSchema = z.strictObject({
  mcpServers: z
    .record(
      z.string(),
      z.custom<Record<string, unknown>>(
        (value) =>
          value !== null && typeof value === "object" && !Array.isArray(value),
      ),
    )
    .default({}),
});

export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function projectResourcePath(
  cwd: string,
  base: string,
  path: string,
): string {
  const absolute = resolve(base, path);
  const rel = relative(cwd, absolute);
  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    resolve(cwd, rel) !== absolute
  ) {
    throw new ConfigError(UNSAFE_PROJECT_PATH_ERROR);
  }
  let current = cwd;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      throw new ConfigError(UNSAFE_PROJECT_PATH_ERROR);
    }
  }
  return absolute;
}

async function readResource(
  cwd: string,
  path: string,
): Promise<string | undefined> {
  projectResourcePath(cwd, cwd, path);
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new ConfigError(UNSAFE_PROJECT_PATH_ERROR);
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_RESOURCE_BYTES) {
      throw new ConfigError(PROJECT_ERRORS.boundedFile);
    }
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

async function collectFiles(
  cwd: string,
  path: string,
  kind: ProjectManifestEntry["kind"],
  manifest: ProjectManifestEntry[],
): Promise<void> {
  projectResourcePath(cwd, cwd, path);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) {
    return;
  }
  if (stat.isDirectory()) {
    const entries = await readdir(path);
    if (entries.length > MAX_RESOURCE_FILES) {
      throw new ConfigError(PROJECT_ERRORS.tooManyFiles);
    }
    for (const name of entries.sort()) {
      await collectFiles(cwd, join(path, name), kind, manifest);
    }
  } else {
    const data = await readResource(cwd, path);
    if (data !== undefined) {
      manifest.push({ kind, path, digest: digest(data) });
      if (manifest.length > MAX_RESOURCE_FILES) {
        throw new ConfigError(PROJECT_ERRORS.tooManyFiles);
      }
    }
  }
}

export async function discoverProject(
  cwd: string,
  disabled = false,
): Promise<ProjectDiscovery> {
  const canonicalCwd = await realpath(resolve(cwd));
  if (!lstatSync(canonicalCwd).isDirectory()) {
    throw new ConfigError(PROJECT_ERRORS.invalidCwd);
  }
  if (disabled) {
    return {
      cwd: canonicalCwd,
      identity: digest(canonicalCwd),
      fingerprint: digest("disabled"),
      manifest: [],
      configPath: join(canonicalCwd, PROJECT_DIR_NAME, PROJECT_CONFIG_FILENAME),
      config: {},
      mcpServers: [],
      mcpSources: new Map(),
      resources: { prompts: [], skills: [], workflow: [] },
      extensions: [],
    };
  }
  const base = projectResourcePath(
    canonicalCwd,
    canonicalCwd,
    PROJECT_DIR_NAME,
  );
  const configPath = join(base, PROJECT_CONFIG_FILENAME);
  const manifest: ProjectManifestEntry[] = [];
  const configData =
    canonicalPath(configPath) === canonicalPath(globalConfigPath())
      ? undefined
      : await readResource(canonicalCwd, configPath);
  const config =
    configData === undefined ? {} : parseProjectConfig(configData, configPath);
  if (configData !== undefined) {
    manifest.push({
      kind: "config",
      path: configPath,
      digest: digest(configData),
    });
  }
  const mcpPath = join(canonicalCwd, PROJECT_MCP_FILENAME);
  const mcpData = await readResource(canonicalCwd, mcpPath);
  const mcpServers = [...(config.mcp_servers ?? [])];
  const mcpSources = new Map(
    mcpServers.map((server) => [server.name, configPath]),
  );
  if (mcpData !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(mcpData);
    } catch {
      throw new ConfigError(`Invalid project MCP JSON in ${mcpPath}`);
    }
    const parsed = McpFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(
        `Invalid project MCP configuration in ${mcpPath}:\n${z.prettifyError(parsed.error)}`,
      );
    }
    for (const [name, entry] of Object.entries(parsed.data.mcpServers)) {
      if (Object.hasOwn(entry, "name") || Object.hasOwn(entry, "transport")) {
        throw new ConfigError(
          `Invalid project MCP configuration in ${mcpPath}`,
        );
      }
      const { type, ...server } = entry;
      const checked = ProjectMcpServerConfigSchema.safeParse({
        ...server,
        name,
        transport: type ?? (entry.command ? "stdio" : "http"),
      });
      if (!checked.success) {
        throw new ConfigError(
          `Invalid project MCP configuration in ${mcpPath} (server "${name}"):\n${z.prettifyError(checked.error)}`,
        );
      }
      mcpServers.push(checked.data);
      mcpSources.set(name, mcpPath);
    }
    manifest.push({ kind: "mcp", path: mcpPath, digest: digest(mcpData) });
  }
  validateMcpServers({ mcp_servers: mcpServers });
  const resources = {
    prompts: [join(base, PROJECT_PROMPTS_DIR)],
    skills: projectAncestorDirs(canonicalCwd).map((dir) =>
      join(dir, PROJECT_SKILLS_DIR),
    ),
    workflow: [join(base, PROJECT_WORKFLOWS_DIR)],
  };
  for (const kind of RESOURCE_KINDS) {
    const paths = config[kind]?.paths;
    if (kind !== "prompts" && paths?.length) {
      throw new ConfigError(
        `Project ${kind} resources use their single canonical directory.`,
      );
    }
    if (paths !== undefined && kind === "prompts") {
      resources[kind] = paths.map((path) =>
        projectResourcePath(canonicalCwd, base, path),
      );
    }
    for (const path of resources[kind]) {
      await collectFiles(
        kind === "skills" ? projectAncestorDirs(canonicalCwd)[0] : canonicalCwd,
        path,
        kind,
        manifest,
      );
    }
  }
  const extensions: { name: string; path: string }[] = [];
  const extensionNames = new Set<string>();
  for (const extension of config.extensions ?? []) {
    if (extensionNames.has(extension.name)) {
      throw new ConfigError(PROJECT_ERRORS.duplicateExtension);
    }
    extensionNames.add(extension.name);
    if (extension.enabled === false) {
      continue;
    }
    if (!extension.path) {
      throw new ConfigError(PROJECT_ERRORS.extensionPathRequired);
    }
    const path = projectResourcePath(canonicalCwd, base, extension.path);
    if (
      !ESM_EXTENSIONS.has(extname(path)) ||
      (await readResource(canonicalCwd, path)) === undefined
    ) {
      throw new ConfigError(PROJECT_ERRORS.esmRequired);
    }
    extensions.push({ name: extension.name, path });
    // Hash sibling dependencies too, not only the entrypoint imported by the host.
    await collectFiles(canonicalCwd, dirname(path), "extension", manifest);
  }
  manifest.sort(
    (a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind),
  );
  const execution = {
    mcpServers,
    providers: config.providers,
    model: config.model,
    endpoint: config.endpoint,
    hooks: config.hooks ?? [],
    extensions: config.extensions ?? [],
    env: config.env ?? {},
    files: manifest.filter(
      (entry) =>
        entry.kind === "extension" ||
        entry.kind === "workflow" ||
        entry.kind === "skills",
    ),
  };
  return {
    cwd: canonicalCwd,
    identity: digest(canonicalCwd),
    fingerprint: digest(JSON.stringify(execution)),
    manifest,
    configPath,
    config,
    mcpServers,
    mcpSources,
    resources,
    extensions,
  };
}
