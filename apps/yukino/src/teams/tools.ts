/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import {
  MSG_PLAN_APPROVAL_RESPONSE,
  MSG_SHUTDOWN_REQUEST,
  MSG_SHUTDOWN_RESPONSE,
  MSG_TEXT,
  planApprovalResponse,
  shutdownRequest,
  shutdownResponse,
} from "./protocol.js";
import { getNameRegistry } from "./registry.js";

import type { TeamManager, RunAgent, Team } from "./index.js";

import { createChildLogger } from "@/logger/index.js";
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
  description =
    "Create a team for coordinating multiple agents. At most one team exists at a time: creating a team deletes any other team, stopping its members.";
  category = "read" as const;
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

    // Single-team semantics: at most one team exists at any moment. Creating a
    // team sweeps every other team — running ones are stopped, and residuals
    // from previous sessions are removed from disk — so the requested name is
    // always free and no suffix disambiguation is needed.
    await this.mgr.deleteAll();

    const description = strArg(args, "description");
    const team = this.mgr.create(requested, undefined, {
      leadAgentId: "lead",
      description,
    });
    return {
      output:
        `Team '${team.name}' created (mode: ${team.mode}). ` +
        `Use Agent tool with team_name='${team.name}' to add teammates.`,
      isError: false,
    };
  }
}

export class SpawnTeammateTool implements Tool {
  name = "SpawnTeammate";
  description =
    "Spawn a teammate in a team to work on a task in the background. Its result is delivered back to you on the team channel when it finishes.";
  category = "read" as const;
  constructor(
    private mgr: TeamManager,
    private runAgent: RunAgent,
    private providerBaseUrl?: string,
  ) {}
  schema(): ToolSchema {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: "object",
        properties: {
          team: {
            type: "string",
            description: "Team name (created if missing)",
          },
          name: {
            type: "string",
            description: "Teammate name",
          },
          task: {
            type: "string",
            description: "The task for the teammate",
          },
        },
        required: ["team", "name", "task"],
      },
    };
  }

  async execute(
    ctx: ToolContext,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const team = strArg(args, "team");
    const name = strArg(args, "name");
    const task = strArg(args, "task");
    if (!team || !name || !task) {
      return Promise.resolve({
        output: "Error: team, name and task are required",
        isError: true,
      });
    }
    // Single-team invariant: creating a team sweeps every other team first,
    // matching TeamCreate semantics.
    let t = this.mgr.get(team);
    if (!t) {
      await this.mgr.deleteAll();
      t = this.mgr.create(team);
    }
    t.spawnTeammate(name, task, this.runAgent, undefined, this.providerBaseUrl);
    return Promise.resolve({
      output: `Teammate '${name}' spawned in team '${team}'. Its result will arrive on the team channel; keep working and watch for it.`,
      isError: false,
    });
  }
}

export class SendMessageTool implements Tool {
  name = "SendMessage";
  description =
    "Send a message to a teammate's mailbox. Use to='*' to broadcast to all teammates.";
  category = "read" as const;
  constructor(
    private mgr: TeamManager,
    private senderName = "lead",
  ) {}

  // Infer the sender's team: a teammate can look itself up in the roster; the Lead is
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
            description: "Teammate name, or '*' to broadcast",
          },
          content: {
            type: "string",
            description:
              "Message content. For shutdown_request this is the reason; for " +
              "plan_approval_response this is your feedback when rejecting.",
          },
          type: {
            type: "string",
            enum: [
              MSG_TEXT,
              MSG_SHUTDOWN_REQUEST,
              MSG_SHUTDOWN_RESPONSE,
              MSG_PLAN_APPROVAL_RESPONSE,
            ],
            description:
              "Message kind, defaults to 'text'. Use 'shutdown_request' to ask a teammate " +
              "to wrap up (it replies with shutdown_response). Use 'plan_approval_response' " +
              "to answer a teammate's plan, together with 'approve' and, when rejecting, " +
              "feedback in 'content'.",
          },
          request_id: {
            type: "string",
            description:
              "Required for plan_approval_response: copy the requestId from the teammate's " +
              "plan approval request so it knows which plan you are answering.",
          },
          approve: {
            type: "boolean",
            description:
              "Required for plan_approval_response: true to let the teammate start " +
              "executing, false to send it back to revise.",
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
        case MSG_SHUTDOWN_REQUEST:
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
        case MSG_PLAN_APPROVAL_RESPONSE:
          if (!requestId || approve === undefined) {
            return {
              output:
                "plan_approval_response requires both 'request_id' and 'approve'.",
              isError: true,
            };
          }
          structured = planApprovalResponse(
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
      const target = to === "lead" ? t.leadMailbox : t.getMember(to)?.mailbox;
      if (!target) {
        return { output: `Teammate '${to}' not found.`, isError: true };
      }
      await target.send(this.senderName, structured.text, structured);
      return { output: `${msgType} sent to '${to}'.`, isError: false };
    }
    // Broadcast: send to all members in the team except the sender
    if (to === "*") {
      let count = 0;
      for (const member of t.listMembers()) {
        if (member.name === this.senderName) {
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

    // The lead is not a registered member (it runs in the parent process and
    // only reads its own mailbox), so route plain text to it directly —
    // mirroring the structured-message path above.
    if (to === "lead") {
      await t.leadMailbox.send(this.senderName, message);
      return { output: `Message sent to '${to}'.`, isError: false };
    }

    // Resolve the recipient name to a delivery identifier via the global name registry; fall back to the original name if unresolved
    const recipient = getNameRegistry().resolve(to) ?? to;
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
  description = "List teams and their members.";
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
      return `${t.name} [${t.mode}]: ${members}`;
    });
    return Promise.resolve({
      output: lines.join("\n"),
      isError: false,
    });
  }
}

export class TeamDeleteTool implements Tool {
  name = "TeamDelete";
  description = "Delete a team and stop its members.";
  category = "read" as const;
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
