import { createChildLogger } from "@/logger/index.js";
import {
  LEADER_NAME,
  MSG_PLAN_APPROVAL_RESPONSE,
  MSG_SHUTDOWN_REQUEST,
  MSG_SHUTDOWN_RESPONSE,
  MSG_TEXT,
} from "@/teams/constants.js";
import type { TeamManager, Team } from "@/teams/index.js";
import {
  LIST_TEAMS_TOOL_DESCRIPTION,
  SEND_MESSAGE_TOOL_DESCRIPTION,
  TEAM_CREATE_TOOL_DESCRIPTION,
  TEAM_DELETE_TOOL_DESCRIPTION,
} from "@/teams/prompts.js";
import { shutdownRequest, shutdownResponse } from "@/teams/protocol.js";
import { getNameRegistry } from "@/teams/registry.js";
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
          team_name: { type: "string", description: "Name for the team" },
          description: {
            type: "string",
            description: "What this team will work on",
          },
        },
        required: ["team_name"],
      },
    };
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const requested = strArg(args, "team_name");
    if (!requested) {
      return Promise.resolve({
        output: "Error: team_name is required",
        isError: true,
      });
    }
    try {
      sanitizeTeamName(requested);
    } catch (error) {
      return { output: asErrorString(error), isError: true };
    }

    // Single-team semantics: at most one team exists at any moment. Creating a
    // team sweeps every other team — running ones are stopped, and residuals
    // from previous sessions are removed from disk — so the requested name is
    // always free and no suffix disambiguation is needed.
    await this.mgr.deleteAll();

    const description = strArg(args, "description");
    const team = this.mgr.create(requested, {
      leaderAgentId: LEADER_NAME,
      description,
    });
    return {
      output:
        `Team '${team.name}' created. ` +
        `Use Agent tool with team_name='${team.name}' to add teammates.`,
      isError: false,
    };
  }
}

export class SendMessageTool implements Tool {
  name = "SendMessage";
  description = SEND_MESSAGE_TOOL_DESCRIPTION;
  category = "command" as const;
  constructor(
    private mgr: TeamManager,
    private senderName = LEADER_NAME,
  ) {}

  // Infer the sender's team: a teammate can look itself up in the roster; the Leader is
  // not in the roster, so fall back to the current team (only one is active at a time).
  private senderTeam(): Team | undefined {
    const teams = this.mgr.list();
    for (const t of teams) {
      if (t.getMember(this.senderName)) {
        return t;
      }
    }
    return teams[0];
  }

  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description:
              "Teammate name, 'leader' for the coordinator, or '*' to broadcast",
          },
          content: {
            type: "string",
            description:
              "Message content, shutdown reason, or the leader's plan review feedback.",
          },
          type: {
            type: "string",
            enum: [
              MSG_TEXT,
              MSG_SHUTDOWN_REQUEST,
              MSG_SHUTDOWN_RESPONSE,
              ...(this.mgr.coordinatorMode ? [MSG_PLAN_APPROVAL_RESPONSE] : []),
            ],
            description:
              "Message kind, defaults to 'text'. Use 'shutdown_request' to ask a teammate " +
              "to wrap up (it replies with shutdown_response). " +
              (this.mgr.coordinatorMode
                ? "The leader must review each plan_approval_request and reply with plan_approval_response, approve, request_id, and substantive feedback in content."
                : "Teammate plans are automatically approved by the runtime."),
          },
          request_id: {
            type: "string",
            description:
              "Copy the requestId from the shutdown or plan approval request when responding.",
          },
          approve: {
            type: "boolean",
            description:
              "Required for shutdown_response and plan_approval_response: whether the request was accepted.",
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
    const t = this.senderTeam();
    if (!t) {
      return { output: "No active team found for this sender.", isError: true };
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
              output: "Only the leader can approve or reject teammate plans.",
              isError: true,
            };
          }
          if (!requestId || approve === undefined || !message.trim()) {
            return {
              output:
                "plan_approval_response requires request_id, approve, and review feedback in content.",
              isError: true,
            };
          }
          try {
            t.respondToPlan(to, requestId, approve, message);
            return {
              output: `Plan ${approve ? "approval" : "revision feedback"} sent to '${to}'.`,
              isError: false,
            };
          } catch (error) {
            return { output: asErrorString(error), isError: true };
          }
        case MSG_SHUTDOWN_REQUEST:
          if (this.senderName !== LEADER_NAME) {
            return {
              output: "Only the leader can request teammate shutdown.",
              isError: true,
            };
          }
          structured = shutdownRequest(this.senderName, message);
          break;
        case MSG_SHUTDOWN_RESPONSE:
          if (approve === undefined) {
            return {
              output: "shutdown_response requires 'approve'.",
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
            output: `Unsupported message type ${msgType}.`,
            isError: true,
          };
      }
      const target =
        to === LEADER_NAME ? t.leaderMailbox : t.getMember(to)?.mailbox;
      if (!target) {
        return { output: `Teammate '${to}' not found.`, isError: true };
      }
      await target.send(this.senderName, structured.text, structured);
      return { output: `${msgType} sent to '${to}'.`, isError: false };
    }
    if (to === "*") {
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
        output: `Message broadcast to ${String(count)} teammate(s).`,
        isError: false,
      };
    }

    // The leader is not a registered member (it runs in the parent process and
    // only reads its own mailbox), so route plain text to it directly —
    // mirroring the structured-message path above.
    if (to === LEADER_NAME) {
      await t.leaderMailbox.send(this.senderName, message);
      return { output: `Message sent to '${to}'.`, isError: false };
    }

    const recipient =
      t.getMember(to)?.name ??
      t.listMembers().find((member) => member.agentId === to)?.name ??
      getNameRegistry().resolve(to) ??
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
      output: `Message sent to '${to}'.`,
      isError: false,
    };
  }
}

export class ListTeamsTool implements Tool {
  name = "ListTeams";
  description = LIST_TEAMS_TOOL_DESCRIPTION;
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
    if (teams.length === 0) {
      return Promise.resolve({
        output: "No teams.",
        isError: false,
      });
    }
    const lines = teams.map((t) => {
      const members =
        t
          .listMembers()
          .map((m) => `${m.name}${m.active ? " (active)" : ""}`)
          .join(", ") || "(no members)";
      return `${t.name}: ${members}`;
    });
    return Promise.resolve({
      output: lines.join("\n"),
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
          name: { type: "string" },
        },
        required: ["name"],
      },
    };
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const name = strArg(args, "name");
    await this.mgr.delete(name);
    return { output: `Team '${name}' deleted.`, isError: false };
  }
}
