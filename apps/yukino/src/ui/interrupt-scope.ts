import type { SubagentProgress } from "./agent-tool-progress.js";
import type { PermissionAction } from "./permission-dialog.js";

/**
 * Whether a single Ctrl+C / Esc has anything to interrupt. Only foreground
 * execution counts: the streaming agent loop, compaction, and synchronous
 * (run_in_background=false) subagents — tracked progress entries without a
 * taskId. Background shell tasks, background subagents (whose progress entry
 * carries the background task id) and teammates are deliberately excluded:
 * they survive a single interrupt and are stopped only when the TUI exits
 * (double Ctrl+C).
 */
export function isForegroundBusy(
  isStreaming: boolean,
  isCompacting: boolean,
  subagents: readonly SubagentProgress[],
): boolean {
  return (
    isStreaming ||
    isCompacting ||
    subagents.some((s) => s.status === "running" && !s.taskId)
  );
}

export interface InterruptDeps {
  /** Controller of the in-flight agent loop; its signal also feeds synchronous tool calls and sync subagents. */
  abortControllerRef: { current: AbortController | null };
  permissionResolveRef: {
    current: ((decision: PermissionAction) => void) | null;
  };
  setPermissionRequest: (request: null) => void;
  askResolveRef: {
    current: ((answers: Record<string, string>) => void) | null;
  };
  setAskRequest: (request: null) => void;
  /** Background tasks (Bash/PowerShell/background agents). Only stopped on exit. */
  backgroundTasks: { stopAll(): Promise<void> };
  /** Teammates. Only stopped on exit. */
  teams: { stopAll(): Promise<void> };
}

export interface InterruptHandlers {
  /**
   * Stop only the foreground execution: abort the in-flight agent loop (which
   * carries synchronous tool calls and run_in_background=false subagents with
   * it) and dismiss pending permission/ask prompts. Background tasks,
   * background subagents and teammates own separate abort controllers and are
   * deliberately left running — a single Ctrl+C or Esc must not kill them.
   */
  interruptForeground: () => void;
  /**
   * Full teardown when the TUI exits (double Ctrl+C, /quit): the foreground
   * interrupt plus every background task and teammate.
   */
  interruptAll: () => void;
}

export function createInterruptHandlers(
  deps: InterruptDeps,
): InterruptHandlers {
  const interruptForeground = () => {
    deps.abortControllerRef.current?.abort();
    deps.permissionResolveRef.current?.("deny");
    deps.permissionResolveRef.current = null;
    deps.setPermissionRequest(null);
    deps.askResolveRef.current?.({});
    deps.askResolveRef.current = null;
    deps.setAskRequest(null);
  };
  const interruptAll = () => {
    interruptForeground();
    void deps.backgroundTasks.stopAll();
    void deps.teams.stopAll();
  };
  return { interruptForeground, interruptAll };
}
