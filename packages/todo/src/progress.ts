import type { Task } from "./index.js";

export function taskProgress(tasks: readonly Task[]): {
  completed: number;
  total: number;
  label: string;
} {
  const completed = tasks.filter((task) => task.status === "completed").length;
  return {
    completed,
    total: tasks.length,
    label: `TODO ${completed}/${tasks.length}`,
  };
}
