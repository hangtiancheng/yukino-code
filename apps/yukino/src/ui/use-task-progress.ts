import { useEffect, useState } from "react";

import type { TeamManager } from "@/teams/index.js";
import { subscribeLeaderTasks } from "@/teams/task-tools.js";
import { PRIVATE_BOARD_ID_PREFIX } from "@/todo/constants.js";
import type { TaskList } from "@/todo/index.js";

export function useTaskProgress(list: TaskList, manager: TeamManager) {
  const [progress, setProgress] = useState(() => ({
    tasks: list.list(),
    boardId: `${PRIVATE_BOARD_ID_PREFIX}0`,
  }));
  useEffect(
    () =>
      subscribeLeaderTasks(manager, list, (tasks, boardId) => {
        setProgress({ tasks, boardId });
      }),
    [list, manager],
  );
  return progress;
}
