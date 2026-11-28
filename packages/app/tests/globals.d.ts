import type { AgentControl } from "@shared/agent-types.ts";
import type { BridgeEvent, ProviderInput } from "@shared/ipc-types.ts";
import type {
  RuntimeAction,
  RuntimeSnapshot,
} from "@shared/workspace-types.ts";

declare global {
  interface Window {
    __emit: (event: BridgeEvent) => void;
    __changeFile: (text: string) => void;
    __saved: string[];
    __runtime: RuntimeSnapshot;
    __sent?: string;
    __action?: RuntimeAction;
    __control?: AgentControl;
    __command?: string;
    __provider?: ProviderInput;
    __permissionMode?: string;
    __rewind?: { id: string; mode: string };
    __permission?: { id: string; response: string };
    __answers?: Record<string, string>;
    __plan?: { id: string; choice: string; feedback?: string };
  }
}
