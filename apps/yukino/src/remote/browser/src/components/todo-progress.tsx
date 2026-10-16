import type { TodoUpdatePayload } from "@browser/types";
import { useEffect, useState } from "react";

interface TodoProgressProps {
  todos: TodoUpdatePayload;
}

/** Task-board progress line above the input (terminal TodoProgress parity). */
export function TodoProgress({ todos }: TodoProgressProps) {
  const tasks = todos.tasks;
  const completed = tasks.filter((task) => task.status === "completed").length;
  const cancelled = tasks.filter((task) => task.status === "cancelled").length;
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  const active = tasks.filter((task) => task.status === "in_progress");
  const current = active[0];
  const allDone = tasks.length > 0 && completed === tasks.length;

  // Hide the completed bar after a short grace period (terminal behavior).
  const completionKey = allDone
    ? `${todos.boardId}:${tasks
        .map((task) => task.id)
        .sort()
        .join(",")}`
    : "";
  const [hiddenKey, setHiddenKey] = useState("");
  useEffect(() => {
    setHiddenKey("");
    if (!completionKey) {
      return;
    }
    const timer = setTimeout(() => {
      setHiddenKey(completionKey);
    }, 5000);
    return () => {
      clearTimeout(timer);
    };
  }, [completionKey]);

  if (tasks.length === 0 || (completionKey && completionKey === hiddenKey)) {
    return null;
  }

  const percent = Math.round((completed / tasks.length) * 100);

  return (
    <div className="shrink-0 border-t border-border/60 bg-surface/60 px-3 py-1.5 sm:px-5">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-3">
        <div className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${String(percent)}%` }}
          />
        </div>
        <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim">
          {`${String(completed)}/${String(tasks.length)} tasks`}
          {cancelled ? ` · ${String(cancelled)} cancelled` : ""}
          {blocked ? ` · ${String(blocked)} blocked` : ""}
          {current ? ` · ${current.activeForm || current.subject}` : ""}
          {active.length > 1 ? ` (+${String(active.length - 1)} active)` : ""}
        </p>
      </div>
    </div>
  );
}
