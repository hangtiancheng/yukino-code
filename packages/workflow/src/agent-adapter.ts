import type { HostHandle } from "./ports.js";
import type {
  AgentProgressUpdate,
  AgentRunParams,
  AgentRunResult,
} from "./types.js";

export interface AgentAdapterCapabilities {
  structuredOutput: boolean;

  tools?: boolean;

  stream?: boolean;
}

export interface AgentAdapterContext {
  host: HostHandle;

  signal: AbortSignal;

  runId: string;

  agentId: number;

  onProgress?: (update: AgentProgressUpdate) => void;
}

export interface AgentAdapter {
  readonly id: string;

  readonly capabilities: AgentAdapterCapabilities;

  run(
    params: AgentRunParams,
    ctx: AgentAdapterContext,
  ): Promise<AgentRunResult>;

  initialize?(): Promise<void>;

  dispose?(): Promise<void>;
}

export type AdapterRouteRule =
  | { kind: "agentType"; agentType: string; adapter: string }
  | { kind: "model"; pattern: string; adapter: string }
  | {
      kind: "custom";
      match: (params: AgentRunParams) => boolean;
      adapter: string;
    };

export class AdapterNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterNotFoundError";
  }
}

export class AgentAdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly rules: AdapterRouteRule[] = [];
  private defaultId: string | null = null;

  register(adapter: AgentAdapter): this {
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  default(adapterId: string): this {
    this.defaultId = adapterId;
    return this;
  }

  route(rule: AdapterRouteRule): this {
    this.rules.push(rule);
    return this;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  resolve(params: AgentRunParams): AgentAdapter {
    for (const rule of this.rules) {
      if (matchRule(rule, params)) {
        const hit = this.adapters.get(rule.adapter);
        if (hit) {
          return hit;
        }
      }
    }
    if (this.defaultId) {
      const fallback = this.adapters.get(this.defaultId);
      if (fallback) {
        return fallback;
      }
    }
    throw new AdapterNotFoundError(
      `No adapter matched (rules=${this.rules.length}, default=${this.defaultId ?? "none"})`,
    );
  }

  async initializeAll(): Promise<void> {
    for (const a of this.adapters.values()) {
      await a.initialize?.();
    }
  }

  async disposeAll(): Promise<void> {
    for (const a of this.adapters.values()) {
      await a.dispose?.();
    }
  }
}

function matchRule(rule: AdapterRouteRule, params: AgentRunParams): boolean {
  if (rule.kind === "agentType") {
    return params.agentType === rule.agentType;
  }
  if (rule.kind === "model") {
    return (
      typeof params.model === "string" && params.model.startsWith(rule.pattern)
    );
  }
  return rule.match(params); // custom rule
}
