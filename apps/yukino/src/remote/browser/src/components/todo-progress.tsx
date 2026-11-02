import { useEffect, useState } from "react";

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
    <div className="mx-auto w-full max-w-5xl shrink-0 px-3 pt-2 pb-1 sm:px-6">
      <div className="flex w-full items-center gap-2">
        <div className="h-1 w-12 sm:w-20 shrink-0 overflow-hidden rounded-full bg-border">
          <div
            className={`h-full rounded-full transition-[width] ${allDone ? "bg-green" : "bg-accent"}`}
            style={{ width: `${String(percent)}%` }}
          />
        </div>
        <p className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim">
          <span className={allDone ? "text-green" : "text-accent"}>
            {`${String(completed)}/${String(tasks.length)} tasks`}
          </span>
          <span className="text-yellow">
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
