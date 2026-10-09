import { LEADER_NAME } from "./protocol.js";

import type { Team, TeamManager } from "./index.js";

import type { Task, TaskBoard, TaskList, TaskUpdates } from "@/todo/index.js";
import {
  TaskCreateTool,
  TaskGetTool,
  TaskListTool,
  TaskUpdateTool,
  TodoWriteTool,
} from "@/todo/tools.js";
import type { ToolRegistry } from "@/tools/registry.js";

class TeamTaskBoard implements TaskBoard {
  constructor(
    private manager: TeamManager,
    private teamName: string | undefined,
    private agentName: string,
    private fallback?: TaskBoard,
  ) {}

  private board(): TaskBoard {
    const team = this.teamName
      ? this.manager.get(this.teamName)
      : this.manager.list()[0];
    if (!team) {
      if (this.fallback) {
        return this.fallback;
      }
      throw new Error("No active team task board");
    }
    const store = this.manager.getTaskStore(team.name);
    const actor = this.agentName === LEADER_NAME ? undefined : this.agentName;
    return {
      create: (subject, description, activeForm, metadata) =>
        store.create(
          subject,
          description,
          "",
          [],
          [],
          this.agentName,
          activeForm,
          metadata,
        ),
      get: (id) => store.get(id),
      list: () => store.listTasks(),
      update: (id, updates) => {
        if (updates.owner && updates.owner !== LEADER_NAME) {
          const owner = team.getMember(updates.owner);
          if (!owner || (!owner.active && owner.uiState)) {
            throw new Error(
              `Teammate '${updates.owner}' is not available for assignment`,
            );
          }
        }
        const task = store.update(id, updates, actor);
        if (
          updates.owner &&
          task?.owner &&
          task.owner !== LEADER_NAME &&
          task.owner !== this.agentName
        ) {
          team
            .getMember(task.owner)
            ?.mailbox.sendSync(
              this.agentName,
              `Task assignment: #${task.id} ${task.subject}\n${task.description}\nUse TaskGet to inspect dependencies, then TaskUpdate to claim it before starting.`,
            );
        }
        return task;
      },
      delete: (id) => store.delete(id, actor),
    };
  }

  create(
    subject: string,
    description: string,
    activeForm?: string,
    metadata?: Record<string, unknown>,
  ): Task {
    return this.board().create(subject, description, activeForm, metadata);
  }
  get(id: string): Task | undefined {
    return this.board().get(id);
  }
  list(): Task[] {
    return this.board().list();
  }
  update(id: string, updates: TaskUpdates): Task | undefined {
    return this.board().update(id, updates);
  }
  delete(id: string): boolean {
    return this.board().delete(id);
  }
}

export class TeamTaskCreateTool extends TaskCreateTool {
  constructor(
    manager: TeamManager,
    teamName?: string,
    agentName = LEADER_NAME,
    fallback?: TaskBoard,
  ) {
    super(new TeamTaskBoard(manager, teamName, agentName, fallback));
  }
}
export class TeamTaskGetTool extends TaskGetTool {
  constructor(
    manager: TeamManager,
    teamName?: string,
    agentName = LEADER_NAME,
    fallback?: TaskBoard,
  ) {
    super(new TeamTaskBoard(manager, teamName, agentName, fallback));
  }
}
export class TeamTaskListTool extends TaskListTool {
  constructor(
    manager: TeamManager,
    teamName?: string,
    agentName = LEADER_NAME,
    fallback?: TaskBoard,
  ) {
    super(new TeamTaskBoard(manager, teamName, agentName, fallback));
  }
}
export class TeamTaskUpdateTool extends TaskUpdateTool {
  constructor(
    manager: TeamManager,
    teamName?: string,
    agentName = LEADER_NAME,
    fallback?: TaskBoard,
  ) {
    super(new TeamTaskBoard(manager, teamName, agentName, fallback));
  }
}

export function registerLeaderTaskTools(
  registry: ToolRegistry,
  manager: TeamManager,
  fallback: TaskList,
  mode: "tasks" | "todos",
): void {
  const tools = [
    new TeamTaskCreateTool(manager, undefined, LEADER_NAME, fallback),
    new TeamTaskGetTool(manager, undefined, LEADER_NAME, fallback),
    new TeamTaskListTool(manager, undefined, LEADER_NAME, fallback),
    new TeamTaskUpdateTool(manager, undefined, LEADER_NAME, fallback),
  ];
  const todo = new TodoWriteTool(fallback);
  let currentMode: "tasks" | "todos" | undefined;
  const sync = () => {
    const nextMode =
      mode === "tasks" || manager.list().length ? "tasks" : "todos";
    if (nextMode === currentMode) {
      return;
    }
    currentMode = nextMode;
    if (nextMode === "tasks") {
      registry.unregister(todo.name);
      for (const tool of tools) {
        registry.register(tool);
      }
    } else {
      for (const tool of tools) {
        registry.unregister(tool.name);
      }
      registry.register(todo);
    }
  };
  registry.addCleanup(manager.subscribe(sync));
  sync();
}

export function subscribeLeaderTasks(
  manager: TeamManager,
  fallback: TaskList,
  listener: (tasks: Task[], boardId: string) => void,
): () => void {
  let team: Team | undefined;
  let unsubscribeStore: (() => void) | undefined;
  let signature = "";
  let generation = 0;
  let disposed = false;
  const refresh = () => {
    if (disposed) {
      return;
    }
    const nextTeam = manager.list()[0];
    if (nextTeam !== team) {
      unsubscribeStore?.();
      team = nextTeam;
      generation++;
      unsubscribeStore = team
        ? manager.getTaskStore(team.name).subscribe(refresh)
        : undefined;
    }
    const tasks = team
      ? manager.getTaskStore(team.name).listTasks()
      : fallback.list();
    const boardId = `${team ? `team:${team.name}` : "private"}:${generation}`;
    const nextSignature = JSON.stringify([boardId, tasks]);
    if (signature !== nextSignature) {
      signature = nextSignature;
      listener(tasks, boardId);
    }
  };
  const unsubscribePrivate = fallback.subscribe(refresh);
  const unsubscribeTeams = manager.subscribe(refresh);
  const timer = setInterval(refresh, 500);
  timer.unref();
  return () => {
    disposed = true;
    clearInterval(timer);
    unsubscribeStore?.();
    unsubscribePrivate();
    unsubscribeTeams();
  };
}
