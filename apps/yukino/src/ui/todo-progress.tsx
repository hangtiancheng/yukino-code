import { Box, Text } from "ink";
import { useEffect, useState } from "react";

import type { Task } from "@/todo/index.js";
import { taskProgress } from "@/todo/progress.js";
import { THEME } from "@/ui/styles.js";
import { plainTerminalLine } from "@/ui/terminal-text.js";

export function TodoProgress({ tasks }: { tasks: readonly Task[] }) {
  const { completed, label } = taskProgress(tasks);
  const completionKey =
    tasks.length > 0 && completed === tasks.length
      ? JSON.stringify(tasks.map((task) => task.id).sort())
      : undefined;
  const [hiddenCompletionKey, setHiddenCompletionKey] = useState<string>();

  useEffect(() => {
    setHiddenCompletionKey(undefined);
    if (completionKey === undefined) {
      return;
    }
    const timer = setTimeout(() => {
      setHiddenCompletionKey(completionKey);
    }, 5000);
    return () => {
      clearTimeout(timer);
    };
  }, [completionKey]);

  if (
    !tasks.length ||
    (completionKey !== undefined && completionKey === hiddenCompletionKey)
  ) {
    return null;
  }
  const cancelled = tasks.filter((task) => task.status === "cancelled").length;
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  const active = tasks.filter((task) => task.status === "in_progress");
  const current = active[0];
  return (
    <Box paddingLeft={1}>
      <Text color={THEME.dim} wrap="truncate-end">
        {label}
        {cancelled ? ` · ${String(cancelled)} cancelled` : ""}
        {blocked ? ` · ${String(blocked)} blocked` : ""}
        {current
          ? ` · ${plainTerminalLine(current.activeForm || current.subject)}`
          : ""}
        {active.length > 1 ? ` (+${String(active.length - 1)} active)` : ""}
      </Text>
    </Box>
  );
}
