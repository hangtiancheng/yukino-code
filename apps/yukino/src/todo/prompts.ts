export const TASK_CREATE_DESCRIPTION =
  "Create a pending item on the current task board. This tracks work; it does not launch an Agent or a background task.";

export const TASK_GET_DESCRIPTION = "Get a task by its ID.";

export const TASK_LIST_DESCRIPTION = "List all tasks.";

export const TASK_UPDATE_DESCRIPTION =
  "Atomically update the current task board's fields and dependencies. Dependency IDs must already exist; self-dependencies, cycles, and starting blocked work are rejected. Teammates claim in_progress tasks under their own name. deleted removes the task and its links.";

export const TODO_WRITE_DESCRIPTION =
  "Replace this agent's entire private TODO list in one atomic update. Include all items to retain; reuse returned IDs to preserve metadata and dependency links. Returns todos with IDs and TODO completed/total progress. An empty array clears the list; completing all items retains them. Track complex work, not trivial requests; this tool never launches work.";
