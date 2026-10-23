interface DependencyNode {
  id: string;
  blocks: readonly string[];
  blockedBy: readonly string[];
}

export function unresolvedTaskDependencies(
  task: DependencyNode,
  nodes: Iterable<DependencyNode & { status: string }>,
): string[] {
  const completed = new Set(
    [...nodes]
      .filter((node) => node.status === "completed")
      .map((node) => node.id),
  );
  return task.blockedBy.filter((id) => !completed.has(id));
}

export function validateTaskDependencies(
  nodes: Iterable<DependencyNode>,
): void {
  const tasks = new Map<string, DependencyNode>();
  for (const task of nodes) {
    if (tasks.has(task.id)) {
      throw new Error(`Duplicate task ID: ${task.id}`);
    }
    tasks.set(task.id, task);
  }
  for (const task of tasks.values()) {
    for (const [ids, reciprocal] of [
      [task.blocks, "blockedBy"],
      [task.blockedBy, "blocks"],
    ] as const) {
      if (new Set(ids).size !== ids.length) {
        throw new Error(`Duplicate dependencies for task #${task.id}`);
      }
      for (const id of ids) {
        if (id === task.id) {
          throw new Error(`Task #${id} cannot depend on itself`);
        }
        const other = tasks.get(id);
        if (!other) {
          throw new Error(`Unknown dependency: task #${id} does not exist`);
        }
        if (!other[reciprocal].includes(task.id)) {
          throw new Error(
            `Inconsistent dependency between task #${task.id} and #${id}`,
          );
        }
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (task: DependencyNode): void => {
    if (visiting.has(task.id)) {
      throw new Error("Task dependencies contain a cycle");
    }
    if (visited.has(task.id)) {
      return;
    }
    visiting.add(task.id);
    for (const id of task.blocks) {
      const blocked = tasks.get(id);
      if (blocked) {
        visit(blocked);
      }
    }
    visiting.delete(task.id);
    visited.add(task.id);
  };
  for (const task of tasks.values()) {
    visit(task);
  }
}
