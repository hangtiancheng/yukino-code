import type { FileOperations } from "@/session/file-operations.js";
import type {
  ToolResultContentBlock,
  ToolSchema,
  ToolResult,
} from "@/tools/types.js";

export interface CodeModeDeclaration {
  name: string;
  description: string;
  schema: ToolSchema;
  namespace?: string;
  source?: { kind: string; id?: string; scope?: string };
}

export interface CodeModeCall {
  id: number;
  name: string;
  args: Record<string, unknown>;
}

export interface CodeModeToolValue {
  output: string;
  contentBlocks?: ToolResultContentBlock[];
  structuredContent?: unknown;
  rawContent?: unknown[];
  artifact?: {
    id: string;
    path?: string;
    mimeType?: string;
    size?: number;
    hash?: string;
  };
  isError?: boolean;
}

export interface CodeModeResult extends ToolResult {
  artifact?: CodeModeToolValue["artifact"];
}

export type CodeModeOutcome =
  | { ok: true; value: CodeModeToolValue }
  | { ok: false; error: string; fileOperations?: FileOperations };

export interface WorkflowVmConfig {
  args: unknown;
  budgetTotal: number | null;
  budgetSpent: number;
  maxItems: number;
}
export interface WorkflowVmStart extends CodeModeStart {
  workflow: WorkflowVmConfig;
}
export type WorkflowVmOutcome =
  | { ok: true; value: { data: unknown; budgetSpent: number } }
  | { ok: false; error: string; budgetSpent: number };
export type VmLane = "codemode" | "workflowRoot" | "workflowChild";

export interface CodeModeStart {
  code: string;
  tools: CodeModeDeclaration[];
  store: Record<string, unknown>;
  seed: number;
  startedAt: number;
  deadline: number;
  maxOutputTokens: number;
}

export interface CodeModeVmResult {
  ok: boolean;
  output: ToolResultContentBlock[];
  value?: unknown;
  error?: string;
  store?: Record<string, unknown>;
  during: { seq: number; issued: number };
  shutdown?: boolean;
}

export interface VmRun<T> {
  result: Promise<CodeModeVmResult>;
  deliver(seq: number, now: number, id: number, outcome: T): void;
  close(): Promise<void>;
}
export type CodeModeRun = VmRun<CodeModeOutcome>;
export type WorkflowVmRun = VmRun<WorkflowVmOutcome>;

export interface CodeModeRunOptions {
  signal?: AbortSignal;
  onCall(call: CodeModeCall): void;
  onIdle(seq: number, issued: number): void;
}

export interface CodeModeHost {
  stateKey: object;
  sessionId: string;
  transcriptPath: string;
  tools(): CodeModeDeclaration[];
  execute(
    calls: {
      toolUseId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }[],
    signal: AbortSignal,
    before: (id: string) => void,
  ): AsyncIterable<CodeModeToolValue & { toolId: string; isError: boolean }>;
  progress?(text: string): void;
}

export interface CodeModeSavedRun {
  id: string;
  start: CodeModeStart;
  fingerprint: string;
  calls: CodeModeCall[];
  started: number[];
  journal: {
    id: number;
    now: number;
    outcome: CodeModeOutcome;
    issued: number;
  }[];
  firstIssued?: number;
  result?: CodeModeResult;
  store?: Record<string, unknown>;
}
