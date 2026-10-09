import type { PermissionAction } from "./permission-dialog.js";

import type { PermissionRequestHandler } from "@/tools/types.js";
import { formatToolArgs } from "@/utils/index.js";

export interface PermissionRequest {
  agentName: string;
  cwd: string;
  requestId: string;
  toolName: string;
  argsSummary: string;
  reason: string;
}

interface QueuedPermission {
  present: () => void;
  deny: () => void;
}

export function createPermissionRequestHandler(deps: {
  resolver: { current: ((action: PermissionAction) => void) | null };
  queue: { current: QueuedPermission[] };
  present: (request: PermissionRequest | null) => void;
}): PermissionRequestHandler {
  let nextId = 0;
  return (toolName, args, decision, _toolCallId, signal, source) =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve("deny");
        return;
      }
      const requestId = `permission-${String(++nextId)}`;
      let settled = false;
      const finish = (action: PermissionAction) => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", cancel);
        resolve(action);
      };
      const entry = {
        present: () => {
          deps.resolver.current = finish;
          deps.present({
            agentName: source?.agentName ?? "main",
            cwd: source?.cwd ?? "",
            requestId,
            toolName,
            argsSummary: formatToolArgs(args),
            reason: decision.reason,
          });
        },
        deny: () => {
          finish("deny");
        },
      };
      const cancel = () => {
        const active = deps.resolver.current === finish;
        deps.queue.current = deps.queue.current.filter(
          (queued) => queued !== entry,
        );
        finish("deny");
        if (active) {
          deps.resolver.current = null;
          deps.present(null);
          deps.queue.current.shift()?.present();
        }
      };
      signal?.addEventListener("abort", cancel, { once: true });
      if (deps.resolver.current) {
        deps.queue.current.push(entry);
      } else {
        entry.present();
      }
    });
}
