import type { Command } from "@/commands/commands.js";
import type { AppConfigOverrides } from "@/config/index.js";
import type { AppConfig, ProjectConfig } from "@/config/index.js";
import type { MCPServerConfig } from "@/mcp/config.js";

export type TrustDecision = "once" | "persistent" | "deny";
export type ResourceKind = "prompts" | "skills" | "workflow";
export interface ProjectSource {
  field: string;
  scope: "default" | "global" | "project" | "override";
  path?: string;
}
export interface ProjectManifestEntry {
  kind: "config" | "mcp" | "extension" | ResourceKind;
  path: string;
  digest: string;
}
export interface ProjectTrustRequest {
  cwd: string;
  identity: string;
  fingerprint: string;
  manifest: readonly ProjectManifestEntry[];
  changed: boolean;
}
export interface AuthorizedProject {
  readonly identity: string;
  readonly fingerprint: string;
}
export interface ResolveProjectOptions {
  trust?: TrustDecision;
  authorizedProject?: AuthorizedProject;
  onTrustRequest?: (request: ProjectTrustRequest) => Promise<TrustDecision>;
  overrides?: AppConfigOverrides;
  disabled?: boolean;
}
export interface ProjectMcpRegistration {
  owner: string;
  source: string;
  scope: "project";
}
export interface ProjectResourceHooks {
  registerMcpServer: (
    config: MCPServerConfig,
    registration: ProjectMcpRegistration,
  ) => void | Promise<void>;
  unregisterMcpServer: (name: string, owner: string) => void | Promise<void>;
}
export interface ProjectExtensionContext {
  registerMcpServer: (config: MCPServerConfig) => Promise<void>;
  unregisterMcpServer: (name: string) => Promise<void>;
}
export interface ProjectContext {
  readonly cwd: string;
  readonly identity: string;
  readonly fingerprint: string;
  readonly trusted: boolean;
  readonly manifest: readonly ProjectManifestEntry[];
  getSources(): ProjectSource[];
  getResourcePaths(kind: ResourceKind): string[];
  loadCommands(): Promise<Command[]>;
  registerMcpServers(hooks: ProjectResourceHooks): Promise<void>;
  loadExtensions(hooks: ProjectResourceHooks): Promise<void>;
  reload(options?: ResolveProjectOptions): Promise<ResolvedProject>;
  revoke(): Promise<void>;
  dispose(): Promise<void>;
}
export interface ResolvedProject {
  config: AppConfig;
  project: ProjectContext;
}
export interface ProjectDiscovery {
  cwd: string;
  identity: string;
  fingerprint: string;
  manifest: ProjectManifestEntry[];
  configPath: string;
  config: ProjectConfig;
  mcpServers: MCPServerConfig[];
  mcpSources: Map<string, string>;
  resources: Record<ResourceKind, string[]>;
  extensions: { name: string; path: string }[];
}
