import { createHash } from "node:crypto";

import {
  CODE_MODE_EXCLUDED_TOOLS,
  CODE_MODE_TOOL_NAME,
} from "@/code-mode/constants.js";
import type { MCPExposure } from "@/mcp/config.js";
import { MCP_TOOL_PREFIX } from "@/mcp/constants.js";
import { policyAllows } from "@/mcp/policy.js";
import type {
  RegistryPolicy,
  ToolAuthorization,
  ToolInvocationEntry,
} from "@/mcp/policy.js";
import {
  assertBoundedJson,
  SessionToolDeclarationSchema,
  SessionToolDeclarationsSchema,
  visitJson,
  type SessionToolDeclaration,
} from "@/session/records.js";
import type {
  AnthropicToolSchema,
  McpLoadingMode,
  OpenAICompatToolSchema,
  OpenAIResponsesToolSchema,
  ProviderToolSchema,
  Tool,
  ToolProtocol,
  ToolSchema,
} from "@/tools/types.js";

const owners = new WeakMap<Tool, ToolRegistry>();

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private owned = new Set<Tool>();
  private borrowed = new Map<string, ToolRegistry>();
  private disposal?: Promise<void>;
  private cleanup = new Set<() => void | Promise<void>>();
  private discovered = new Set<string>();
  private listeners = new Set<() => void>();
  private parent?: ToolRegistry;
  private sourceSubscriptions = new Set<ToolRegistry>();
  private policy: RegistryPolicy = {};
  private revision = 0;
  mcpLoadingMode: McpLoadingMode = "eager";
  exposeToolSearch = false;
  exposeMcpCall = false;

  get generation(): number {
    return this.revision;
  }
  get cacheVersion(): number {
    return this.revision;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(): void {
    this.revision++;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observers cannot veto registry commits. */
      }
    }
  }
  setPolicy(policy: RegistryPolicy): void {
    this.policy = {
      ...policy,
      allowlist: policy.allowlist && [...policy.allowlist],
      denylist: policy.denylist && [...policy.denylist],
    };
    this.changed();
  }
  getPolicy(): RegistryPolicy {
    return {
      ...this.policy,
      allowlist: this.policy.allowlist && [...this.policy.allowlist],
      denylist: this.policy.denylist && [...this.policy.denylist],
    };
  }
  copyLoadingStateFrom(registry: ToolRegistry): void {
    this.parent = registry;
    const update = () => {
      this.mcpLoadingMode = registry.mcpLoadingMode;
      this.exposeToolSearch = registry.exposeToolSearch;
      this.exposeMcpCall = registry.exposeMcpCall;
      for (const [name, source] of this.borrowed) {
        if (source.get(name) !== this.tools.get(name)) {
          this.tools.delete(name);
          this.borrowed.delete(name);
          this.discovered.delete(name);
        }
      }
      this.changed();
    };
    this.discovered = new Set(registry.discovered);
    update();
    this.addCleanup(registry.subscribe(update));
  }
  private checkRegistration(tool: Tool): void {
    if (this.disposal) {
      throw new Error("Cannot register tools on a disposed registry");
    }
    if (this.tools.has(tool.name) && this.tools.get(tool.name) !== tool) {
      throw new Error(`Tool name collision: ${tool.name}`);
    }
  }
  register(tool: Tool): void {
    this.checkRegistration(tool);
    this.tools.set(tool.name, tool);
    this.owned.add(tool);
    owners.set(tool, this);
    this.changed();
  }
  registerBorrowed(tool: Tool): void {
    this.checkRegistration(tool);
    this.tools.set(tool.name, tool);
    const source = this.parent ?? owners.get(tool);
    if (source && source !== this) {
      this.borrowed.set(tool.name, source);
      if (source !== this.parent && !this.sourceSubscriptions.has(source)) {
        this.sourceSubscriptions.add(source);
        this.addCleanup(
          source.subscribe(() => {
            for (const [name, owner] of this.borrowed) {
              if (
                owner === source &&
                owner.get(name) !== this.tools.get(name)
              ) {
                this.tools.delete(name);
                this.borrowed.delete(name);
                this.discovered.delete(name);
              }
            }
            this.changed();
          }),
        );
      }
    }
    this.changed();
  }
  /** Validate the whole replacement before publishing one revocation/cache generation. */
  replaceTools(remove: readonly string[], add: readonly Tool[]): void {
    if (this.disposal) {
      throw new Error("Cannot register tools on a disposed registry");
    }
    const names = new Set<string>();
    const removed = new Set(remove);
    for (const tool of add) {
      if (
        names.has(tool.name) ||
        (this.tools.has(tool.name) && !removed.has(tool.name))
      ) {
        throw new Error(`Tool name collision: ${tool.name}`);
      }
      names.add(tool.name);
    }
    for (const name of remove) {
      this.tools.delete(name);
      this.borrowed.delete(name);
      this.discovered.delete(name);
    }
    for (const tool of add) {
      this.tools.set(tool.name, tool);
      this.owned.add(tool);
      owners.set(tool, this);
    }
    this.changed();
  }
  takeOwnershipFrom(source: ToolRegistry): void {
    if (this.disposal || source.disposal) {
      throw new Error("Cannot transfer tools from or to a disposed registry");
    }
    for (const tool of this.listTools()) {
      if (source.owned.delete(tool)) {
        this.owned.add(tool);
        this.borrowed.delete(tool.name);
        owners.set(tool, this);
      }
    }
  }
  addCleanup(cleanup: () => void | Promise<void>): void {
    if (this.disposal) {
      throw new Error("Cannot add cleanup to a disposed registry");
    }
    this.cleanup.add(cleanup);
  }
  dispose(): Promise<void> {
    if (!this.disposal) {
      const owned = [...this.owned];
      this.tools.clear();
      this.borrowed.clear();
      this.discovered.clear();
      this.disposal = Promise.resolve().then(async () => {
        const results = await Promise.allSettled([
          ...[...this.cleanup].map((fn) => Promise.resolve().then(fn)),
          ...owned.map(async (tool) => tool.dispose?.()),
        ]);
        this.cleanup.clear();
        this.owned.clear();
        this.listeners.clear();
        const errors: unknown[] = [];
        for (const result of results) {
          if (result.status === "rejected") {
            errors.push(result.reason);
          }
        }
        if (errors.length) {
          throw new AggregateError(errors, "Tool cleanup failed");
        }
      });
      this.changed();
    }
    return this.disposal;
  }
  unregister(name: string): void {
    if (!this.tools.delete(name)) {
      return;
    }
    this.borrowed.delete(name);
    this.discovered.delete(name);
    this.changed();
  }
  get(name: string): Tool | undefined {
    const tool = this.tools.get(name);
    const source = this.borrowed.get(name);
    return source && source.get(name) !== tool ? undefined : tool;
  }
  getInstanceOf<T extends Tool>(
    name: string,
    ctor: abstract new (...args: never[]) => T,
  ): T | undefined {
    const tool = this.get(name);
    return tool instanceof ctor ? tool : undefined;
  }
  listTools(): Tool[] {
    return [...this.tools.values()].filter(
      (tool) => this.get(tool.name) === tool,
    );
  }
  exposure(name: string): MCPExposure {
    const tool = this.get(name);
    if (
      tool &&
      "exposure" in tool &&
      (tool.exposure === "direct" ||
        tool.exposure === "deferred" ||
        tool.exposure === "codemode" ||
        tool.exposure === "hidden")
    ) {
      return tool.exposure;
    }
    return tool?.deferred ? "deferred" : "direct";
  }
  private allowsInherited(name: string): boolean {
    return (
      policyAllows(this.policy, name) &&
      (!this.parent || this.parent.allowsInherited(name))
    );
  }
  canInvoke(name: string, entry: ToolInvocationEntry): boolean {
    const tool = this.get(name);
    if (!tool || this.disposal || !this.allowsInherited(name)) {
      return false;
    }
    if (tool.isAvailable && !tool.isAvailable()) {
      return false;
    }
    const source = this.borrowed.get(name);
    if (source && !source.canInvoke(name, entry)) {
      return false;
    }
    const exposure = this.exposure(name);
    if (exposure === "hidden") {
      return false;
    }
    if (entry === "app" && "appVisible" in tool && tool.appVisible === false) {
      return false;
    }
    if (
      entry !== "app" &&
      entry !== "resource" &&
      "modelVisible" in tool &&
      tool.modelVisible === false
    ) {
      return false;
    }
    if (entry === "codemode") {
      return (
        (this.policy.codeModeEnabled ??
          this.parent?.getPolicy().codeModeEnabled) === true
      );
    }
    if (exposure === "codemode") {
      return false;
    }
    if (entry === "dispatch") {
      return exposure === "deferred";
    }
    if (entry === "direct" || entry === "host") {
      if (
        name === CODE_MODE_TOOL_NAME &&
        this.policy.codeModeEnabled === false
      ) {
        return false;
      }
      if (
        entry === "direct" &&
        this.policy.codeModeMode === "only" &&
        name !== CODE_MODE_TOOL_NAME &&
        !CODE_MODE_EXCLUDED_TOOLS.has(name)
      ) {
        return false;
      }
      return (
        exposure === "direct" ||
        (exposure === "deferred" &&
          this.isDiscovered(name) &&
          (!name.startsWith(MCP_TOOL_PREFIX) ||
            this.mcpLoadingMode === "native"))
      );
    }
    return true;
  }
  captureAuthorization(
    name: string,
    entry: ToolInvocationEntry,
  ): ToolAuthorization {
    if (!this.canInvoke(name, entry)) {
      throw new Error(`Tool unavailable at ${entry}: ${name}`);
    }
    return { name, entry, generation: this.generation, role: this.policy.role };
  }
  validateAuthorization(authorization: ToolAuthorization): boolean {
    return (
      authorization.generation === this.generation &&
      authorization.role === this.policy.role &&
      this.canInvoke(authorization.name, authorization.entry)
    );
  }
  getAllSchemas(): ToolSchema[];
  getAllSchemas(
    protocol: "anthropic",
    filter?: (name: string) => boolean,
  ): AnthropicToolSchema[];
  getAllSchemas(
    protocol: "openai",
    filter?: (name: string) => boolean,
  ): OpenAIResponsesToolSchema[];
  getAllSchemas(
    protocol: "openai-compat",
    filter?: (name: string) => boolean,
  ): OpenAICompatToolSchema[];
  getAllSchemas(
    protocol: ToolProtocol,
    filter?: (name: string) => boolean,
  ): ProviderToolSchema[];
  getAllSchemas(
    protocol?: ToolProtocol,
    filter?: (name: string) => boolean,
  ): ProviderToolSchema[] {
    const resolved = protocol ?? "anthropic";
    const native = this.mcpLoadingMode === "native" && resolved === "anthropic";
    const schemas: ProviderToolSchema[] = [];
    for (const tool of this.listTools()) {
      if (!this.isToolVisible(tool, native, filter)) {
        continue;
      }
      const deferred =
        this.exposure(tool.name) === "deferred" &&
        (native || !this.isDiscovered(tool.name));
      const s = tool.schema();
      if (resolved === "openai") {
        schemas.push({
          strict: s.strict ?? false,
          type: "function",
          name: s.name,
          description: s.description,
          parameters: s.input_schema,
        });
      } else if (resolved === "openai-compat") {
        schemas.push({
          type: "function",
          function: {
            name: s.name,
            description: s.description,
            parameters: s.input_schema,
            strict: s.strict ?? false,
          },
        });
      } else {
        schemas.push({
          ...s,
          type: "custom",
          ...(deferred ? { defer_loading: true } : {}),
        });
      }
    }
    return schemas;
  }
  private isToolVisible(
    tool: Tool,
    native: boolean,
    filter?: (name: string) => boolean,
  ): boolean {
    if (
      filter?.(tool.name) === false ||
      !policyAllows(this.policy, tool.name)
    ) {
      return false;
    }
    if (
      (tool.name === "ToolSearch" && !this.exposeToolSearch) ||
      (tool.name === "McpCall" && !this.exposeMcpCall)
    ) {
      return false;
    }
    return (
      this.canInvoke(tool.name, "direct") || (native && this.isSearchable(tool))
    );
  }
  listVisibleToolNames(
    protocol?: ToolProtocol,
    filter?: (name: string) => boolean,
  ): string[] {
    return this.listTools()
      .filter((tool) =>
        this.isToolVisible(
          tool,
          this.mcpLoadingMode === "native" &&
            (protocol ?? "anthropic") === "anthropic",
          filter,
        ),
      )
      .map((tool) => tool.name);
  }
  private isSearchable(tool: Tool): boolean {
    return (
      this.canInvoke(tool.name, "dispatch") && !this.isDiscovered(tool.name)
    );
  }
  getDeferredToolNames(): string[] {
    return this.getDeferredTools()
      .map((tool) => tool.name)
      .sort();
  }
  getDeferredTools(): Tool[] {
    return this.listTools().filter((tool) => this.isSearchable(tool));
  }
  searchDeferred(query: string, maxResults = 5): Tool[] {
    const lower = query.toLowerCase();
    return this.getDeferredTools()
      .filter(
        (tool) =>
          tool.name.toLowerCase().includes(lower) ||
          tool.description.toLowerCase().includes(lower),
      )
      .slice(0, Math.max(1, Math.min(maxResults, 50)));
  }
  findDeferredByNames(names: string[]): Tool[] {
    const selected = new Set(names.map((name) => name.toLowerCase()));
    return this.getDeferredTools()
      .filter((tool) => selected.has(tool.name.toLowerCase()))
      .slice(0, 50);
  }
  private snapshotDeclaration(
    tool: Tool,
    sourceFingerprintForTool: (tool: Tool) => string,
  ): SessionToolDeclaration {
    const schema = tool.schema();
    assertBoundedJson(schema, true);
    const canonical = visitJson(schema, (value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          )
        : value,
    );
    return SessionToolDeclarationSchema.parse({
      name: tool.name,
      schemaFingerprint: createHash("sha256")
        .update(JSON.stringify(canonical))
        .digest("hex"),
      sourceFingerprint: sourceFingerprintForTool(tool),
    });
  }
  snapshotDeclarations(
    sourceFingerprintForTool: (tool: Tool) => string,
  ): SessionToolDeclaration[] {
    return SessionToolDeclarationsSchema.parse(
      this.listTools()
        .filter(
          (tool) =>
            this.canInvoke(tool.name, "direct") ||
            this.canInvoke(tool.name, "dispatch") ||
            this.canInvoke(tool.name, "codemode"),
        )
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((tool) =>
          this.snapshotDeclaration(tool, sourceFingerprintForTool),
        ),
    );
  }
  restoreDiscovered(
    snapshots: readonly SessionToolDeclaration[],
    sourceFingerprintForTool: (tool: Tool) => string,
  ): string[] {
    let declarations: SessionToolDeclaration[];
    try {
      assertBoundedJson(snapshots);
      declarations = SessionToolDeclarationsSchema.parse(snapshots);
    } catch (error) {
      this.discovered = new Set();
      this.changed();
      throw error;
    }
    const restored = new Set<string>();
    const dropped: string[] = [];
    for (const snapshot of declarations) {
      try {
        const tool = this.get(snapshot.name);
        if (tool && this.canInvoke(snapshot.name, "dispatch")) {
          const current = this.snapshotDeclaration(
            tool,
            sourceFingerprintForTool,
          );
          if (
            current.schemaFingerprint === snapshot.schemaFingerprint &&
            current.sourceFingerprint === snapshot.sourceFingerprint &&
            this.get(snapshot.name) === tool &&
            this.canInvoke(snapshot.name, "dispatch")
          ) {
            restored.add(snapshot.name);
            continue;
          }
        }
      } catch {
        dropped.push(snapshot.name);
        continue;
      }
      dropped.push(snapshot.name);
    }
    this.discovered = restored;
    this.changed();
    return dropped;
  }
  markDiscovered(name: string): void {
    if (this.canInvoke(name, "dispatch") && !this.discovered.has(name)) {
      this.discovered.add(name);
      this.changed();
    }
  }
  isDiscovered(name: string): boolean {
    return this.discovered.has(name);
  }
  invalidate(): void {
    this.changed();
  }
}
