import { createChildLogger } from "@/logger/index.js";
import {
  BROADCAST_TARGET,
  buildBroadcastSentMessage,
  buildMessageSentMessage,
  buildPlanResponseSentMessage,
  buildTeamCreatedMessage,
  buildTeamDeletedMessage,
  buildTeammateNotFoundError,
  buildTypedMessageSentMessage,
  buildUnsupportedMessageTypeError,
  LEADER_NAME,
  MSG_PLAN_APPROVAL_RESPONSE,
  MSG_SHUTDOWN_REQUEST,
  MSG_SHUTDOWN_RESPONSE,
  MSG_TEXT,
  NO_ACTIVE_TEAM_FOR_SENDER_ERROR,
  NO_ACTIVE_TEAM_MESSAGE,
  PLAN_APPROVAL_LEADER_ONLY_ERROR,
  PLAN_APPROVAL_RESPONSE_REQUIRED_ERROR,
  SHUTDOWN_LEADER_ONLY_ERROR,
  SHUTDOWN_RESPONSE_APPROVE_REQUIRED_ERROR,
  TEAM_SCOPE_ERROR,
} from "@/teams/constants.js";
import type { TeamManager, Team } from "@/teams/index.js";
import {
  buildSendMessageTypeDescription,
  LIST_TEAM_TOOL_DESCRIPTION,
  SEND_MESSAGE_APPROVE_DESCRIPTION,
  SEND_MESSAGE_CONTENT_DESCRIPTION,
  SEND_MESSAGE_REQUEST_ID_DESCRIPTION,
  SEND_MESSAGE_TO_DESCRIPTION,
  SEND_MESSAGE_TOOL_DESCRIPTION,
  TEAM_CREATE_NAME_PARAM_DESCRIPTION,
  TEAM_CREATE_TOOL_DESCRIPTION,
  TEAM_DELETE_TOOL_DESCRIPTION,
  TEAM_DESCRIPTION_PARAM_DESCRIPTION,
  TEAM_NAME_PARAM_DESCRIPTION,
} from "@/teams/prompts.js";
import { shutdownRequest, shutdownResponse } from "@/teams/protocol.js";
import { sanitizeTeamName } from "@/teams/team-file.js";
import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@/tools/types.js";
import { asErrorString, strArg } from "@/utils/index.js";

const log = createChildLogger({ module: "teams" });
export class TeamCreateTool implements Tool {
  name = "TeamCreate";
  description = TEAM_CREATE_TOOL_DESCRIPTION;
  category = "command" as const;
  constructor(private mgr: TeamManager) {}
  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: TEAM_CREATE_NAME_PARAM_DESCRIPTION,
          },
          description: {
            type: "string",
            description: TEAM_DESCRIPTION_PARAM_DESCRIPTION,
          },
        },
        required: [],
      },
    };
  }

  execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const name = strArg(args, "name").trim();
    const description = strArg(args, "description");
    try {
      const team = this.mgr.create(name || undefined, {
        leaderAgentId: LEADER_NAME,
        description,
      });
      return Promise.resolve({
        output: buildTeamCreatedMessage(team.name),
        isError: false,
      });
    } catch (error) {
      return Promise.resolve({ output: asErrorString(error), isError: true });
    }
  }
}

export class SendMessageTool implements Tool {
  name = "SendMessage";
  description = SEND_MESSAGE_TOOL_DESCRIPTION;
  category = "command" as const;
  constructor(
    private mgr: TeamManager,
    private senderName = LEADER_NAME,
    private teamName?: string,
  ) {}

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          team_name: {
            type: "string",
            description: TEAM_NAME_PARAM_DESCRIPTION,
          },
          to: {
            type: "string",
            description: SEND_MESSAGE_TO_DESCRIPTION,
          },
          content: {
            type: "string",
            description: SEND_MESSAGE_CONTENT_DESCRIPTION,
          },
          type: {
            type: "string",
            enum: [
              MSG_TEXT,
              MSG_SHUTDOWN_REQUEST,
              MSG_SHUTDOWN_RESPONSE,
              ...(this.mgr.coordinatorMode ? [MSG_PLAN_APPROVAL_RESPONSE] : []),
            ],
            description: buildSendMessageTypeDescription(
              this.mgr.coordinatorMode,
            ),
          },
          request_id: {
            type: "string",
            description: SEND_MESSAGE_REQUEST_ID_DESCRIPTION,
          },
          approve: {
            type: "boolean",
            description: SEND_MESSAGE_APPROVE_DESCRIPTION,
          },
        },
        required: ["to", "content"],
      },
    };
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const to = strArg(args, "to");
    const message = strArg(args, "content");
    const teamName = strArg(args, "team_name") || undefined;
    let t: Team | undefined;
    try {
      if (
        this.teamName &&
        teamName &&
        sanitizeTeamName(teamName) !== sanitizeTeamName(this.teamName)
      ) {
        return { output: TEAM_SCOPE_ERROR, isError: true };
      }
      t = this.mgr.resolveTeam(
        this.teamName ?? teamName,
        this.senderName === LEADER_NAME ? undefined : this.senderName,
      );
    } catch (error) {
      return { output: asErrorString(error), isError: true };
    }
    if (!t) {
      return { output: NO_ACTIVE_TEAM_FOR_SENDER_ERROR, isError: true };
    }

    // Structured messages use a dedicated channel: they carry a requestId and an
    // explicit stance. Embedding them in free-form text would force the recipient to
    // guess intent from natural language — regressing to "coordination by prose parsing".
    const msgType = typeof args.type === "string" ? args.type : MSG_TEXT;
    if (msgType !== MSG_TEXT) {
      const requestId =
        typeof args.request_id === "string" ? args.request_id : "";
      const approve =
        typeof args.approve === "boolean" ? args.approve : undefined;
      let structured;
      switch (msgType) {
        case MSG_PLAN_APPROVAL_RESPONSE:
          if (
            this.senderName !== LEADER_NAME ||
            ctx.permissionChecker?.teammate ||
            ctx.permissionChecker?.isSubagent
          ) {
            return {
              output: PLAN_APPROVAL_LEADER_ONLY_ERROR,
              isError: true,
            };
          }
          if (!requestId || approve === undefined || !message.trim()) {
            return {
              output: PLAN_APPROVAL_RESPONSE_REQUIRED_ERROR,
              isError: true,
            };
          }
          try {
            t.respondToPlan(to, requestId, approve, message);
            return {
              output: buildPlanResponseSentMessage(approve, to),
              isError: false,
            };
          } catch (error) {
            return { output: asErrorString(error), isError: true };
          }
        case MSG_SHUTDOWN_REQUEST:
          if (this.senderName !== LEADER_NAME) {
            return {
              output: SHUTDOWN_LEADER_ONLY_ERROR,
              isError: true,
            };
          }
          structured = shutdownRequest(this.senderName, message);
          break;
        case MSG_SHUTDOWN_RESPONSE:
          if (approve === undefined) {
            return {
              output: SHUTDOWN_RESPONSE_APPROVE_REQUIRED_ERROR,
              isError: true,
            };
          }
          structured = shutdownResponse(
            this.senderName,
            requestId,
            approve,
            message,
          );
          break;
        default:
          return {
            output: buildUnsupportedMessageTypeError(msgType),
            isError: true,
          };
      }
      const target =
        to === LEADER_NAME ? t.leaderMailbox : t.getMember(to)?.mailbox;
      if (!target) {
        return { output: buildTeammateNotFoundError(to), isError: true };
      }
      await target.send(this.senderName, structured.text, structured);
      return {
        output: buildTypedMessageSentMessage(msgType, to),
        isError: false,
      };
    }
    if (to === BROADCAST_TARGET) {
      let count = 0;
      for (const member of t.listMembers()) {
        if (member.name === this.senderName) {
          continue;
        }
        if (!member.active && member.uiState) {
          continue;
        }
        await t.sendMessage(this.senderName, member.name, message);
        count++;
      }
      return {
        output: buildBroadcastSentMessage(count),
        isError: false,
      };
    }

    // The leader is not a registered member (it runs in the parent process and
    // only reads its own mailbox), so route plain text to it directly —
    // mirroring the structured-message path above.
    if (to === LEADER_NAME) {
      await t.leaderMailbox.send(this.senderName, message);
      return { output: buildMessageSentMessage(to), isError: false };
    }

    const recipient =
      t.getMember(to)?.name ??
      t.listMembers().find((member) => member.agentId === to)?.name ??
      to;
    try {
      await t.sendMessage(this.senderName, recipient, message);
    } catch (err) {
      log.error({ err }, "teams operation failed");
      return {
        output: `Error: ${asErrorString(err)}`,
        isError: true,
      };
    }
    return {
      output: buildMessageSentMessage(to),
      isError: false,
    };
  }
}

export class TeamListTool implements Tool {
  name = "TeamList";
  description = LIST_TEAM_TOOL_DESCRIPTION;
  category = "read" as const;
  constructor(private mgr: TeamManager) {}
  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    };
  }

  execute(): Promise<ToolResult> {
    const teams = this.mgr.list();
    if (!teams.length) {
      return Promise.resolve({
        output: NO_ACTIVE_TEAM_MESSAGE,
        isError: false,
      });
    }
    const output = teams
      .map((team) => {
        const members =
          team
            .listMembers()
            .map(
              (member) => `${member.name}${member.active ? " (active)" : ""}`,
            )
            .join(", ") || "(no members)";
        return `${team.name}: ${members}`;
      })
      .join("\n");
    return Promise.resolve({
      output,
      isError: false,
    });
  }
}

export class TeamDeleteTool implements Tool {
  name = "TeamDelete";
  description = TEAM_DELETE_TOOL_DESCRIPTION;
  category = "command" as const;
  constructor(private mgr: TeamManager) {}
  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          team_name: {
            type: "string",
            description: TEAM_NAME_PARAM_DESCRIPTION,
          },
        },
        required: [],
      },
    };
  }

  async execute(
    _ctx?: ToolContext,
    args: Record<string, unknown> = {},
  ): Promise<ToolResult> {
    let team: Team | undefined;
    try {
      team = this.mgr.resolveTeam(strArg(args, "team_name") || undefined);
    } catch (error) {
      return { output: asErrorString(error), isError: true };
    }
    if (!team) {
      return { output: NO_ACTIVE_TEAM_MESSAGE, isError: false };
    }
    await this.mgr.delete(team.name);
    return { output: buildTeamDeletedMessage(team.name), isError: false };
  }
}
