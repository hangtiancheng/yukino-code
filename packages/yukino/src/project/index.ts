import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { PROMPTS_DIR_NAME } from "@/commands/constants.js";
import { loadPromptCommands } from "@/commands/loader.js";
import { cloneAppConfig, ConfigError, type AppConfig } from "@/config/index.js";
import type { MCPServerConfig } from "@/mcp/config.js";
import {
  mergeProjectConfig,
  prepareProjectMcpServer,
} from "@/project/config.js";
import {
  PROJECT_CHANGED_ERROR,
  PROJECT_ERRORS,
  PROJECT_NOT_TRUSTED_ERROR,
} from "@/project/constants.js";
import { digest, discoverProject } from "@/project/discovery.js";
import { resolve as resolveExtension } from "@/project/extension-resolver.js";
import {
  readProjectTrust,
  removeProjectTrust,
  writeProjectTrust,
} from "@/project/trust.js";
import type {
  ProjectContext,
  ProjectDiscovery,
  ProjectExtensionContext,
  ProjectResourceHooks,
  ResolveProjectOptions,
  ResolvedProject,
  ResourceKind,
} from "@/project/types.js";
import { yukinoPath } from "@/storage/index.js";

export * from "@/project/types.js";
export * from "@/project/constants.js";

const liveContexts = new Map<string, Set<ResolvedProjectContext>>();
let resolverRegistered = false;
const ExtensionModuleSchema = z.object({
  activate: z.custom<(context: ProjectExtensionContext) => unknown>(
    (value) => typeof value === "function",
  ),
});
const ExtensionDisposerSchema = z.union([
  z.custom<() => void | Promise<void>>((value) => typeof value === "function"),
  z.object({
    dispose: z.custom<() => void | Promise<void>>(
      (value) => typeof value === "function",
    ),
  }),
]);

interface OwnerState {
  hooks: ProjectResourceHooks;
  names: Set<string>;
  pending: Set<Promise<void>>;
  closing: boolean;
  cleanup?: Promise<void>;
  dispose?: () => void | Promise<void>;
}

class ResolvedProjectContext implements ProjectContext {
  readonly cwd: string;
  readonly identity: string;
  readonly fingerprint: string;
  private authorized: boolean;
  private disposal?: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private extensionsLoaded = false;
  private serversLoaded = false;
  private readonly owners = new Map<string, OwnerState>();

  constructor(
    private readonly discovery: ProjectDiscovery,
    private readonly globalConfig: AppConfig,
    private readonly options: ResolveProjectOptions,
    readonly config: AppConfig,
    private readonly sources: ReturnType<typeof mergeProjectConfig>["sources"],
    private readonly projectServers: MCPServerConfig[],
    trusted: boolean,
  ) {
    this.cwd = discovery.cwd;
    this.identity = discovery.identity;
    this.fingerprint = discovery.fingerprint;
    this.authorized = trusted;
    const contexts =
      liveContexts.get(this.identity) ?? new Set<ResolvedProjectContext>();
    contexts.add(this);
    liveContexts.set(this.identity, contexts);
  }

  get trusted(): boolean {
    return this.authorized && !this.disposal;
  }

  get manifest() {
    return Object.freeze(
      this.discovery.manifest.map((entry) => Object.freeze({ ...entry })),
    );
  }

  getSources() {
    return this.sources.map((source) => ({ ...source }));
  }

  getResourcePaths(kind: ResourceKind): string[] {
    return this.trusted ? [...this.discovery.resources[kind]] : [];
  }

  private async assertCurrent(): Promise<void> {
    if (!this.trusted) {
      throw new ConfigError(PROJECT_NOT_TRUSTED_ERROR);
    }
    try {
      const current = await discoverProject(this.cwd);
      if (current.fingerprint !== this.fingerprint) {
        throw new ConfigError(PROJECT_CHANGED_ERROR);
      }
    } catch {
      this.authorized = false;
      void this.dispose().catch(() => undefined);
      throw new ConfigError(PROJECT_CHANGED_ERROR);
    }
  }

  async loadCommands() {
    const globalPaths = this.options.overrides?.prompts?.paths ??
      this.globalConfig.prompts?.paths ?? [yukinoPath(PROMPTS_DIR_NAME)];
    if (!this.trusted) {
      return loadPromptCommands(
        globalPaths,
        this.options.overrides?.prompts?.disabled ??
          this.globalConfig.prompts?.disabled,
      );
    }
    try {
      await this.assertCurrent();
    } catch (error) {
      await this.dispose();
      throw error;
    }
    const settings = this.options.overrides?.prompts;
    const paths = settings?.paths ?? [
      ...globalPaths,
      ...this.discovery.resources.prompts,
    ];
    const disabled = settings?.disabled ?? [
      ...(this.globalConfig.prompts?.disabled ?? []),
      ...(this.discovery.config.prompts?.disabled ?? []),
    ];
    return loadPromptCommands(paths, disabled);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private createOwner(hooks: ProjectResourceHooks): string {
    const owner = `project:${randomUUID()}`;
    this.owners.set(owner, {
      hooks,
      names: new Set(),
      pending: new Set(),
      closing: false,
    });
    return owner;
  }

  private trackOwnerOperation(
    state: OwnerState,
    operation: () => Promise<void>,
  ): Promise<void> {
    const result = operation();
    state.pending.add(result);
    void result
      .finally(() => state.pending.delete(result))
      .catch(() => undefined);
    return result;
  }

  private extensionContext(
    owner: string,
    source: string,
  ): ProjectExtensionContext {
    const state = this.owners.get(owner);
    if (!state) {
      throw new ConfigError(PROJECT_NOT_TRUSTED_ERROR);
    }
    return Object.freeze({
      registerMcpServer: (server: MCPServerConfig) =>
        this.trackOwnerOperation(state, async () => {
          if (state.closing) {
            throw new ConfigError(PROJECT_NOT_TRUSTED_ERROR);
          }
          await this.assertCurrent();
          if (state.closing) {
            throw new ConfigError(PROJECT_NOT_TRUSTED_ERROR);
          }
          if (
            state.names.has(server.name) ||
            this.config.mcp_servers.some(
              (existing) => existing.name === server.name,
            ) ||
            [...this.owners.values()].some((entry) =>
              entry.names.has(server.name),
            )
          ) {
            throw new ConfigError(PROJECT_ERRORS.extensionNameConflict);
          }
          const prepared = prepareProjectMcpServer(
            server,
            this.cwd,
            this.discovery.config.env,
          );
          if (prepared.enabled === false) {
            throw new ConfigError(PROJECT_ERRORS.extensionDisabled);
          }
          // Reserve before awaiting the host so concurrent registrations cannot race.
          state.names.add(prepared.name);
          try {
            await state.hooks.registerMcpServer(prepared, {
              owner,
              source,
              scope: "project",
            });
          } catch (error) {
            await state.hooks.unregisterMcpServer(prepared.name, owner);
            state.names.delete(prepared.name);
            throw error;
          }
          if (!this.trusted || state.closing) {
            await state.hooks.unregisterMcpServer(prepared.name, owner);
            state.names.delete(prepared.name);
            throw new ConfigError(PROJECT_NOT_TRUSTED_ERROR);
          }
        }),
      unregisterMcpServer: (name: string) =>
        this.trackOwnerOperation(state, async () => {
          if (!state.names.has(name)) {
            throw new ConfigError(PROJECT_ERRORS.extensionOwnership);
          }
          await state.hooks.unregisterMcpServer(name, owner);
          state.names.delete(name);
        }),
    });
  }

  registerMcpServers(hooks: ProjectResourceHooks): Promise<void> {
    if (!this.trusted) {
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      await this.assertCurrent();
      if (this.serversLoaded) {
        return;
      }
      const owner = this.createOwner(hooks);
      const state = this.owners.get(owner);
      if (!state) {
        throw new ConfigError(PROJECT_NOT_TRUSTED_ERROR);
      }
      try {
        for (const server of this.projectServers) {
          state.names.add(server.name);
          await hooks.registerMcpServer(server, {
            owner,
            source:
              this.discovery.mcpSources.get(server.name) ??
              this.discovery.configPath,
            scope: "project",
          });
          if (!this.trusted) {
            throw new ConfigError(PROJECT_NOT_TRUSTED_ERROR);
          }
        }
        this.serversLoaded = true;
      } catch (error) {
        await this.cleanupOwner(owner);
        throw error;
      }
    }).catch(async (error: unknown) => {
      if (!this.authorized) {
        await this.dispose();
      }
      throw error;
    });
  }

  loadExtensions(hooks: ProjectResourceHooks): Promise<void> {
    if (!this.trusted) {
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      await this.assertCurrent();
      if (this.extensionsLoaded) {
        return;
      }
      const activated: string[] = [];
      try {
        for (const extension of this.discovery.extensions) {
          if (!resolverRegistered) {
            registerHooks({ resolve: resolveExtension });
            resolverRegistered = true;
          }
          await this.assertCurrent();
          const owner = this.createOwner(hooks);
          activated.push(owner);
          const raw: unknown = await import(
            `${pathToFileURL(extension.path).href}?yukinoReload=${this.fingerprint}`
          );
          const module = ExtensionModuleSchema.safeParse(raw);
          if (!module.success) {
            throw new ConfigError(PROJECT_ERRORS.activateRequired);
          }
          const result: unknown = await module.data.activate(
            this.extensionContext(owner, extension.path),
          );
          const disposer = ExtensionDisposerSchema.safeParse(result);
          if (!disposer.success) {
            throw new ConfigError(PROJECT_ERRORS.disposeRequired);
          }
          const state = this.owners.get(owner);
          if (state && disposer.data) {
            const value = disposer.data;
            state.dispose =
              typeof value === "function" ? value : () => value.dispose();
          }
          if (state) {
            await Promise.all([...state.pending]);
          }
          await this.assertCurrent();
        }
        this.extensionsLoaded = true;
      } catch (error) {
        await Promise.all(activated.map((owner) => this.cleanupOwner(owner)));
        throw error;
      }
    }).catch(async (error: unknown) => {
      if (!this.authorized) {
        await this.dispose();
      }
      throw error;
    });
  }

  private cleanupOwner(owner: string): Promise<void> {
    const state = this.owners.get(owner);
    if (!state) {
      return Promise.resolve();
    }
    if (state.cleanup) {
      return state.cleanup;
    }
    state.closing = true;
    state.cleanup = (async () => {
      await Promise.allSettled([...state.pending]);
      const errors: unknown[] = [];
      try {
        await state.dispose?.();
      } catch (error) {
        errors.push(error);
      }
      await Promise.allSettled([...state.pending]);
      for (const name of [...state.names]) {
        try {
          await state.hooks.unregisterMcpServer(name, owner);
          state.names.delete(name);
        } catch (error) {
          errors.push(error);
        }
      }
      this.owners.delete(owner);
      if (errors.length) {
        throw new AggregateError(errors, PROJECT_ERRORS.cleanupFailed);
      }
    })();
    return state.cleanup;
  }

  async reload(options: ResolveProjectOptions = {}): Promise<ResolvedProject> {
    const authorizedProject = this.trusted
      ? { identity: this.identity, fingerprint: this.fingerprint }
      : undefined;
    await this.dispose();
    return resolveProjectConfig(this.cwd, this.globalConfig, {
      ...this.options,
      trust: this.options.trust === "deny" ? "deny" : undefined,
      authorizedProject,
      ...options,
    });
  }

  async revoke(): Promise<void> {
    try {
      await removeProjectTrust(this.identity);
    } finally {
      await Promise.all(
        [...(liveContexts.get(this.identity) ?? [])].map((context) =>
          context.dispose(),
        ),
      );
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) {
      return this.disposal;
    }
    this.authorized = false;
    let baseline: ReturnType<typeof mergeProjectConfig>;
    try {
      baseline = mergeProjectConfig(
        this.globalConfig,
        this.discovery,
        this.options.overrides ?? {},
        false,
      );
    } catch {
      // A call-level selection can name a provider removed by revocation.
      baseline = mergeProjectConfig(
        this.globalConfig,
        this.discovery,
        {},
        false,
      );
    }
    for (const key of Object.keys(this.config)) {
      Reflect.deleteProperty(this.config, key);
    }
    Object.assign(this.config, baseline.config);
    this.sources.splice(0, this.sources.length, ...baseline.sources);
    this.disposal = (async () => {
      await this.queue;
      const results = await Promise.allSettled(
        [...this.owners.keys()].map((owner) => this.cleanupOwner(owner)),
      );
      const contexts = liveContexts.get(this.identity);
      contexts?.delete(this);
      if (!contexts?.size) {
        liveContexts.delete(this.identity);
      }
      const errors: unknown[] = [];
      for (const result of results) {
        if (result.status === "rejected") {
          const reason: unknown = result.reason;
          errors.push(reason);
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, PROJECT_ERRORS.cleanupFailed);
      }
    })();
    return this.disposal;
  }
}

export async function resolveProjectConfig(
  cwd: string,
  globalConfig: AppConfig,
  options: ResolveProjectOptions = {},
): Promise<ResolvedProject> {
  let discovery: ProjectDiscovery;
  try {
    discovery = await discoverProject(cwd, options.disabled);
  } catch (error) {
    const canonicalCwd = await realpath(resolve(cwd)).catch(() => resolve(cwd));
    await Promise.all(
      [...(liveContexts.get(digest(canonicalCwd)) ?? [])].map((context) =>
        context.dispose(),
      ),
    );
    throw error;
  }
  for (const context of liveContexts.get(discovery.identity) ?? []) {
    if (
      context.fingerprint !== discovery.fingerprint ||
      options.disabled ||
      options.trust === "deny"
    ) {
      await context.dispose();
    }
  }
  const record =
    options.disabled || options.trust === "deny"
      ? undefined
      : await readProjectTrust(discovery.identity);
  const persisted =
    record?.cwd === discovery.cwd &&
    record.identity === discovery.identity &&
    record.fingerprint === discovery.fingerprint;
  const approved = options.authorizedProject;
  const bound =
    approved?.identity === discovery.identity &&
    approved.fingerprint === discovery.fingerprint;
  // Invocation approval is consumed once; rebuilds may only reuse its exact grant.
  let decision =
    options.disabled || options.trust === "deny"
      ? "deny"
      : approved
        ? bound
          ? "once"
          : undefined
        : options.trust;
  if (decision === undefined && persisted) {
    decision = "once";
  }
  if (
    decision === undefined &&
    discovery.manifest.length &&
    options.onTrustRequest
  ) {
    decision = await options.onTrustRequest({
      cwd: discovery.cwd,
      identity: discovery.identity,
      fingerprint: discovery.fingerprint,
      manifest: discovery.manifest.map((entry) => ({ ...entry })),
      changed:
        Boolean(record && !persisted) ||
        (approved?.identity === discovery.identity && !bound),
    });
  }
  const trusted = decision === "once" || decision === "persistent";
  // Close the approval TOCTOU window before applying any project settings.
  let current: ProjectDiscovery;
  try {
    current = await discoverProject(discovery.cwd, options.disabled);
    if (current.fingerprint !== discovery.fingerprint) {
      throw new ConfigError(PROJECT_CHANGED_ERROR);
    }
  } catch (error) {
    await Promise.all(
      [...(liveContexts.get(discovery.identity) ?? [])].map((context) =>
        context.dispose(),
      ),
    );
    throw error;
  }
  const merged = mergeProjectConfig(
    globalConfig,
    current,
    options.overrides ?? {},
    trusted,
  );
  if (decision === "persistent") {
    await writeProjectTrust(current.cwd, current.identity, current.fingerprint);
  }
  const project = new ResolvedProjectContext(
    current,
    cloneAppConfig(globalConfig),
    {
      ...options,
      overrides: options.overrides && structuredClone(options.overrides),
    },
    merged.config,
    merged.sources,
    merged.projectServers,
    trusted,
  );
  return { config: merged.config, project };
}
