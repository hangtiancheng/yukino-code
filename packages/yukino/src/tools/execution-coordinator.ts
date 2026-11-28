import PQueue from "p-queue";

import { getExecutionContext } from "@/cost/context.js";
import { isSafeCommand } from "@/permissions/index.js";
import {
  acquireSessionRunLease,
  type SessionRunLeaseHandle,
} from "@/session/lease.js";
import { registeredSessionStorageTarget } from "@/subagent/task-manager.js";
import { COMMAND_INTERRUPTED_ERROR } from "@/tools/constants.js";
import type { ToolContext, ToolResult } from "@/tools/types.js";
import { acquireQueueSlot } from "@/utils/concurrency.js";
import { canonicalPath } from "@/utils/paths.js";

const workspaces = new Map<string, PQueue>();

export async function acquireWorkspaceMutation(
  cwd: string,
  signal?: AbortSignal,
): Promise<() => void> {
  const key = canonicalPath(cwd);
  const queue = workspaces.get(key) ?? new PQueue({ concurrency: 1 });
  workspaces.set(key, queue);
  try {
    const release = await acquireQueueSlot(queue, signal);
    return () => {
      release();
      void queue.onIdle().then(() => {
        if (workspaces.get(key) === queue && !queue.size && !queue.pending) {
          workspaces.delete(key);
        }
      });
    };
  } catch (error) {
    if (!queue.size && !queue.pending) {
      workspaces.delete(key);
    }
    throw error;
  }
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
  let lease: SessionRunLeaseHandle | undefined;
  try {
    ctx.abortSignal?.throwIfAborted();
    const executionContext = getExecutionContext();
    const target = executionContext
      ? registeredSessionStorageTarget(ctx, executionContext)
      : undefined;
    lease = target ? acquireSessionRunLease(target, "foreground") : undefined;
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
      return { output: COMMAND_INTERRUPTED_ERROR, isError: true };
    }
    throw error;
  } finally {
    const finish = () => {
      try {
        release?.();
      } finally {
        lease?.release();
      }
    };
    if (done) {
      void done.then(finish, finish);
    } else {
      finish();
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
