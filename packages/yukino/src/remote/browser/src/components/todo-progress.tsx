import { useEffect, useState } from "react";

import { Progress } from "#/components/ui/progress.js";
import type { TodoUpdatePayload } from "#/types.js";

interface TodoProgressProps {
  todos: TodoUpdatePayload;
}

export function TodoProgress({ todos }: TodoProgressProps) {
  const tasks = todos.tasks;
  const completed = tasks.filter((task) => task.status === "completed").length;
  const cancelled = tasks.filter((task) => task.status === "cancelled").length;
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  const active = tasks.filter((task) => task.status === "in_progress");
  const current = active[0];
  const allDone = tasks.length > 0 && completed === tasks.length;

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
    <div className="mx-auto w-full max-w-5xl shrink-0 px-4 pt-3 pb-1.5 sm:px-8">
      <div className="flex w-full items-center gap-3">
        <Progress
          value={percent}
          aria-label="Task completion"
          className={`w-24 shrink-0 [&_[data-slot=progress-track]]:bg-border ${allDone ? "[&_[data-slot=progress-indicator]]:bg-success" : "[&_[data-slot=progress-indicator]]:bg-accent"}`}
        />
        <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim">
          <span className={allDone ? "text-success" : "text-accent"}>
            {`${String(completed)}/${String(tasks.length)} tasks`}
          </span>
          <span className="text-warning">
            {cancelled ? ` · ${String(cancelled)} cancelled` : ""}
            {blocked ? ` · ${String(blocked)} blocked` : ""}
          </span>
          <span className="text-muted">
            {current ? ` · ${current.subject}` : ""}
          </span>
          {active.length > 1 ? ` (+${String(active.length - 1)} active)` : ""}
        </p>
      </div>
    </div>
  );
}
