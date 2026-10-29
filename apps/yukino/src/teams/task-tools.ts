import {
  buildTeammateUnavailableForAssignmentError,
  LEADER_NAME,
  LEADER_TASK_REFRESH_INTERVAL_MS,
  NO_TEAM_TASK_BOARD_ERROR,
  TEAM_BOARD_ID_PREFIX,
  TEAM_SCOPE_ERROR,
} from "@/teams/constants.js";
import type { Team, TeamManager } from "@/teams/index.js";
import {
  buildTaskAssignmentPrompt,
  TEAM_NAME_PARAM_DESCRIPTION,
  TEAM_TODO_WRITE_DESCRIPTION,
} from "@/teams/prompts.js";
import { sanitizeTeamName } from "@/teams/team-file.js";
import { PRIVATE_BOARD_ID_PREFIX } from "@/todo/constants.js";
import type {
  Task,
  TaskBoard,
  TaskList,
  TodoWriteInput,
} from "@/todo/index.js";
import { TodoWriteTool } from "@/todo/tools.js";
import type { ToolContext, ToolResult, ToolSchema } from "@/tools/types.js";
import { asErrorString, strArg } from "@/utils/index.js";

class TeamTaskBoard implements TaskBoard {
  constructor(
    private manager: TeamManager,
    private teamName: string | undefined,
    private agentName: string,
    private fallback?: TaskBoard,
  ) {}

  private board(): { team: Team } | { fallback: TaskBoard } {
    const team = this.manager.resolveTeam(this.teamName);
    if (team) {
      return { team };
    }
    if (this.fallback) {
      return { fallback: this.fallback };
    }
    throw new Error(NO_TEAM_TASK_BOARD_ERROR);
  }

  get boardId(): string {
    const board = this.board();
    return "fallback" in board
      ? board.fallback.boardId
      : `${TEAM_BOARD_ID_PREFIX}${board.team.name}`;
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
          throw new Error(buildTeammateUnavailableForAssignmentError(name));
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
    private manager: TeamManager,
    private teamName?: string,
    private agentName = LEADER_NAME,
    private fallback?: TaskBoard,
  ) {
    super(new TeamTaskBoard(manager, teamName, agentName, fallback));
    this.description += ` ${TEAM_TODO_WRITE_DESCRIPTION}`;
  }

  override schema(): ToolSchema {
    const schema = super.schema();
    schema.input_schema.properties.team_name = {
      type: "string",
      description: TEAM_NAME_PARAM_DESCRIPTION,
    };
    return schema;
  }

  override execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const { team_name: _teamName, ...input } = args;
    const teamName = strArg(args, "team_name") || undefined;
    if (!teamName) {
      return super.execute(ctx, input);
    }
    try {
      if (
        this.teamName &&
        sanitizeTeamName(teamName) !== sanitizeTeamName(this.teamName)
      ) {
        throw new Error(TEAM_SCOPE_ERROR);
      }
      return new TodoWriteTool(
        new TeamTaskBoard(
          this.manager,
          teamName,
          this.agentName,
          this.fallback,
        ),
      ).execute(ctx, input);
    } catch (error) {
      return Promise.resolve({ output: asErrorString(error), isError: true });
    }
  }
}

export function subscribeLeaderTasks(
  manager: TeamManager,
  fallback: TaskList,
  listener: (tasks: Task[], boardId: string) => void,
): () => void {
  let teams: Team[] = [];
  let unsubscribeStores: (() => void)[] = [];
  let signature = "";
  let generation = 0;
  let disposed = false;
  const refresh = () => {
    if (disposed) {
      return;
    }
    const nextTeams = manager.list();
    if (
      nextTeams.length !== teams.length ||
      nextTeams.some((team, index) => team !== teams[index])
    ) {
      for (const unsubscribe of unsubscribeStores) {
        unsubscribe();
      }
      teams = nextTeams;
      generation++;
      unsubscribeStores = teams.map((team) =>
        manager.getTaskStore(team.name).subscribe(refresh),
      );
    }
    const tasks = teams.length
      ? teams.flatMap((team) =>
          manager
            .getTaskStore(team.name)
            .listTasks()
            .map((task) =>
              teams.length === 1
                ? task
                : {
                    ...task,
                    id: JSON.stringify([team.name, task.id]),
                    subject: `[${team.name}] ${task.subject}`,
                    blocks: task.blocks.map((id) =>
                      JSON.stringify([team.name, id]),
                    ),
                    blockedBy: task.blockedBy.map((id) =>
                      JSON.stringify([team.name, id]),
                    ),
                  },
            ),
        )
      : fallback.list();
    const boardId = teams.length
      ? `${TEAM_BOARD_ID_PREFIX}${JSON.stringify(teams.map((team) => team.name))}:${generation}`
      : `${PRIVATE_BOARD_ID_PREFIX}${generation}`;
    const nextSignature = JSON.stringify([boardId, tasks]);
    if (signature !== nextSignature) {
      signature = nextSignature;
      listener(tasks, boardId);
    }
  };
  const unsubscribePrivate = fallback.subscribe(refresh);
  const unsubscribeTeams = manager.subscribe(refresh);
  const timer = setInterval(refresh, LEADER_TASK_REFRESH_INTERVAL_MS);
  timer.unref();
  return () => {
    disposed = true;
    clearInterval(timer);
    for (const unsubscribe of unsubscribeStores) {
      unsubscribe();
    }
    unsubscribePrivate();
    unsubscribeTeams();
  };
}
