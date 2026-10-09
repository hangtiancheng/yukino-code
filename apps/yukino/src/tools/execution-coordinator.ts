import type { ToolContext, ToolResult } from "./types.js";

import { isSafeCommand } from "@/permissions/index.js";
import { canonicalPath } from "@/utils/paths.js";

interface Waiter {
  start: () => void;
}

interface WorkspaceQueue {
  running: boolean;
  pending: Waiter[];
}

const workspaces = new Map<string, WorkspaceQueue>();

export function acquireWorkspaceMutation(
  cwd: string,
  signal?: AbortSignal,
): Promise<() => void> {
  signal?.throwIfAborted();
  const key = canonicalPath(cwd);
  const queue = workspaces.get(key) ?? { running: false, pending: [] };
  workspaces.set(key, queue);
  return new Promise((resolve, reject) => {
    const cancel = () => {
      queue.pending = queue.pending.filter((entry) => entry !== waiter);
      signal?.removeEventListener("abort", cancel);
      reject(new Error("Tool execution was cancelled before it started."));
    };
    const waiter: Waiter = {
      start: () => {
        signal?.removeEventListener("abort", cancel);
        queue.running = true;
        let released = false;
        resolve(() => {
          if (released) {
            return;
          }
          released = true;
          const next = queue.pending.shift();
          if (next) {
            next.start();
          } else {
            queue.running = false;
            workspaces.delete(key);
          }
        });
      },
    };
    if (queue.running) {
      queue.pending.push(waiter);
      signal?.addEventListener("abort", cancel, { once: true });
    } else {
      waiter.start();
    }
  });
}

export function acquireCommandExecution(
  cwd: string,
  command: string,
  signal?: AbortSignal,
): Promise<() => void> {
  signal?.throwIfAborted();
  return isSafeCommand(command)
    ? Promise.resolve(() => undefined)
    : acquireWorkspaceMutation(cwd, signal);
}

export function checkExecutionPermission(
  ctx: ToolContext,
  toolName: string,
  args: Record<string, unknown>,
): ToolResult | undefined {
  const checker = ctx.permissionChecker;
  if (!checker) {
    return;
  }
  const decision = checker.check(
    toolName,
    toolName === "Bash" || toolName === "PowerShell" ? "command" : "write",
    args,
  );
  if (
    decision.effect === "deny" ||
    (decision.effect === "ask" &&
      ctx.approvedPermissionMode !== undefined &&
      ctx.approvedPermissionMode !== checker.mode)
  ) {
    return {
      output: `Permission changed while waiting: ${decision.reason}. Request approval again before retrying.`,
      isError: true,
    };
  }
}

export async function withCommandExecution(
  ctx: ToolContext,
  toolName: string,
  args: Record<string, unknown>,
  command: string,
  run: (started: (done: Promise<void>) => void) => Promise<ToolResult>,
): Promise<ToolResult> {
  let release: (() => void) | undefined;
  let done: Promise<void> | undefined;
  try {
    release = await acquireCommandExecution(ctx.cwd, command, ctx.abortSignal);
    const blocked = checkExecutionPermission(ctx, toolName, args);
    if (blocked) {
      return blocked;
    }
    return await run((completion) => {
      done = completion;
    });
  } catch (error) {
    if (ctx.abortSignal?.aborted) {
      return { output: "Error: command interrupted", isError: true };
    }
    throw error;
  } finally {
    if (done) {
      void done.then(release, release);
    } else {
      release?.();
    }
  }
}

export async function withWorkspaceMutation(
  ctx: ToolContext,
  toolName: string,
  args: Record<string, unknown>,
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const release = await acquireWorkspaceMutation(ctx.cwd, ctx.abortSignal);
  try {
    return checkExecutionPermission(ctx, toolName, args) ?? (await run());
  } finally {
    release();
  }
}
