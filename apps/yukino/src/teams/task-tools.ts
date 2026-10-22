import { LEADER_NAME } from "@/teams/constants.js";
import type { Team, TeamManager } from "@/teams/index.js";
import { buildTaskAssignmentPrompt } from "@/teams/prompts.js";
import { PRIVATE_BOARD_ID_PREFIX } from "@/todo/constants.js";
import type {
  Task,
  TaskBoard,
  TaskList,
  TodoWriteInput,
} from "@/todo/index.js";
import { TodoWriteTool } from "@/todo/tools.js";

class TeamTaskBoard implements TaskBoard {
  constructor(
    private manager: TeamManager,
    private teamName: string | undefined,
    private agentName: string,
    private fallback?: TaskBoard,
  ) {}

  private board(): { team: Team } | { fallback: TaskBoard } {
    const team = this.teamName
      ? this.manager.get(this.teamName)
      : this.manager.list()[0];
    if (team) {
      return { team };
    }
    if (this.fallback) {
      return { fallback: this.fallback };
    }
    throw new Error("No active team task board");
  }

  get boardId(): string {
    const board = this.board();
    return "fallback" in board
      ? board.fallback.boardId
      : `team:${board.team.name}`;
  }

  write(input: TodoWriteInput): Task[] {
    const board = this.board();
    if ("fallback" in board) {
      return board.fallback.write(input);
    }
    const { team } = board;
    const store = this.manager.getTaskStore(team.name);
    const tasks = store.write(input, {
      actor: this.agentName === LEADER_NAME ? undefined : this.agentName,
      createdBy: this.agentName,
      validateOwner: (name) => {
        if (name === LEADER_NAME) {
          return;
        }
        const owner = team.getMember(name);
        if (!owner || (!owner.active && owner.uiState)) {
          throw new Error(`Teammate '${name}' is not available for assignment`);
        }
      },
    });
    const newCount =
      input.todos?.filter((todo) => todo.id === undefined).length ?? 0;
    const created = newCount ? tasks.slice(-newCount) : [];
    let newIndex = 0;
    for (const todo of input.todos ?? []) {
      const id = todo.id ?? created[newIndex++]?.id;
      const task = tasks.find((candidate) => candidate.id === id);
      if (
        todo.owner &&
        task?.owner &&
        task.owner !== LEADER_NAME &&
        task.owner !== this.agentName
      ) {
        team
          .getMember(task.owner)
          ?.mailbox.sendSync(this.agentName, buildTaskAssignmentPrompt(task));
      }
    }
    return tasks;
  }
}

export class TeamTodoWriteTool extends TodoWriteTool {
  constructor(
    manager: TeamManager,
    teamName?: string,
    agentName = LEADER_NAME,
    fallback?: TaskBoard,
  ) {
    super(new TeamTaskBoard(manager, teamName, agentName, fallback));
  }
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
    const boardId = team
      ? `team:${team.name}:${generation}`
      : `${PRIVATE_BOARD_ID_PREFIX}${generation}`;
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
