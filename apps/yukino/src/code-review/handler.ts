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

import type { CodeReviewManager } from "./manager.js";
import { asCriticEvaluation, type ReviewSession } from "./session.js";

import type { CommandContext } from "@/commands/commands.js";
import { createChildLogger } from "@/logger/index.js";

const log = createChildLogger({ module: "code-review" });

export function handleCodeReviewCommand(
  ctx: CommandContext,
  manager: CodeReviewManager,
  session: ReviewSession,
): string {
  const args = ctx.args.trim().split(/\s+/);
  const command = args[0]?.toLowerCase();
  const params = args.slice(1).join(" ");

  try {
    switch (command) {
      case "create":
        return handleCreate(manager, params);
      case "add":
        return handleAddMember(manager, params);
      case "remove":
        return handleRemoveMember(manager, params);
      case "list":
        return handleListTeams(manager);
      case "status":
        return handleTeamStatus(manager, params);
      case "activate":
        return handleActivateMember(manager, params);
      case "deactivate":
        return handleDeactivateMember(manager, params);
      case "request":
        return handleCreateRequest(session, params);
      case "requests":
        return handleListRequests(session);
      case "comment":
        return handleAddComment(session, params);
      case "accept":
        return handleAcceptComment(session, params);
      case "reject":
        return handleRejectComment(session, params);
      case "report":
        return handleGenerateReport(session, params);
      case "approve":
        return handleApproveRequest(session, params);
      case "reject-request":
        return handleRejectRequest(session, params);
      case "critic":
        return handleCriticEvaluate(session, params);
      case "critic-summary":
        return handleCriticSummary(session, params);
      case "add-critic":
        return handleAddCritic(manager, params);
      default:
        return showCodeReviewHelp();
    }
  } catch (err) {
    log.error({ err }, "code-review operation failed");
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function handleCreate(manager: CodeReviewManager, params: string): string {
  const args = params.split(/\s+/);
  const name = args[0];

  if (!name) {
    return "Usage: /code-review create <team-name> [member1,member2,member3]";
  }

  // Create 3-person review team
  const members = [
    {
      name: args[1] || "reviewer1",
      email: `${args[1] || "reviewer1"}@yukino.dev`,
      role: "lead" as const,
      expertise: ["architecture", "security", "performance"],
    },
    {
      name: args[2] || "reviewer2",
      email: `${args[2] || "reviewer2"}@yukino.dev`,
      role: "reviewer" as const,
      expertise: ["testing", "code-quality", "documentation"],
    },
    {
      name: args[3] || "reviewer3",
      email: `${args[3] || "reviewer3"}@yukino.dev`,
      role: "reviewer" as const,
      expertise: ["typescript", "frontend", "ux"],
    },
  ];

  /** const team = */ manager.createTeam(name, members);
  return (
    `Created code review team '${name}' with 3 members:\n` +
    `  - ${members[0].name} (Lead)\n` +
    `  - ${members[1].name} (Reviewer)\n` +
    `  - ${members[2].name} (Reviewer)`
  );
}

function handleAddMember(manager: CodeReviewManager, params: string): string {
  const args = params.split(/\s+/);
  const [teamName, name, role = "reviewer"] = args;

  if (!teamName || !name) {
    return "Usage: /code-review add <team-name> <member-name> [role]";
  }

  const member = {
    name,
    email: `${name}@yukino.dev`,
    role: role === "lead" ? ("lead" as const) : ("reviewer" as const),
    expertise: ["general"],
  };

  manager.addMember(teamName, member);
  return `Added member '${name}' to team '${teamName}'`;
}

function handleRemoveMember(
  manager: CodeReviewManager,
  params: string,
): string {
  const args = params.split(/\s+/);
  const [teamName, memberName] = args;

  if (!teamName || !memberName) {
    return "Usage: /code-review remove <team-name> <member-name>";
  }

  manager.removeMember(teamName, memberName);
  return `Removed member '${memberName}' from team '${teamName}'`;
}

function handleListTeams(manager: CodeReviewManager): string {
  const teams = manager.listTeams();
  if (teams.length === 0) {
    return "No code review teams found. Use /code-review create to create one.";
  }

  return teams
    .map((team) => {
      const activeMembers = team.members.filter((m) => m.active).length;
      return `Team: ${team.name} (${String(activeMembers)}/${String(team.members.length)} active)`;
    })
    .join("\n");
}

function handleTeamStatus(manager: CodeReviewManager, params: string): string {
  const teamName = params.trim();
  if (!teamName) {
    return "Usage: /code-review status <team-name>";
  }

  return manager.getTeamSummary(teamName);
}

function handleActivateMember(
  manager: CodeReviewManager,
  params: string,
): string {
  const args = params.split(/\s+/);
  const [teamName, memberName] = args;

  if (!teamName || !memberName) {
    return "Usage: /code-review activate <team-name> <member-name>";
  }

  manager.activateMember(teamName, memberName);
  return `Activated member '${memberName}' in team '${teamName}'`;
}

function handleDeactivateMember(
  manager: CodeReviewManager,
  params: string,
): string {
  const args = params.split(/\s+/);
  const [teamName, memberName] = args;

  if (!teamName || !memberName) {
    return "Usage: /code-review deactivate <team-name> <member-name>";
  }

  manager.deactivateMember(teamName, memberName);
  return `Deactivated member '${memberName}' in team '${teamName}'`;
}

function handleCreateRequest(session: ReviewSession, params: string): string {
  const args = params.split(/\s+/);
  const [teamName, title, ...descParts] = args;
  const description = descParts.join(" ");

  if (!teamName || !title) {
    return "Usage: /code-review request <team-name> <title> [description]";
  }

  const request = session.createReviewRequest(
    teamName,
    title,
    description || "No description provided",
    "current-user",
    "main",
    ["src/"],
  );

  return (
    `Created review request '${request.id}'\n` +
    `Title: ${title}\n` +
    `Reviewers: ${request.reviewers.join(", ")}\n` +
    `Status: ${request.status}`
  );
}

function handleListRequests(session: ReviewSession): string {
  const requests = session.getPendingRequests();
  if (requests.length === 0) {
    return "No pending review requests.";
  }

  return requests
    .map((req) => `${req.id}: ${req.title} - ${req.status}`)
    .join("\n");
}

function handleAddComment(session: ReviewSession, params: string): string {
  const args = params.split(/\s+/);
  const [requestId, ...contentParts] = args;
  const content = contentParts.join(" ");

  if (!requestId || !content) {
    return "Usage: /code-review comment <request-id> <comment-text>";
  }

  const comment = session.addComment(requestId, "current-user", content);
  return `Added comment ${JSON.stringify(comment)} to request '${requestId}'`;
}

function handleApproveRequest(session: ReviewSession, params: string): string {
  const requestId = params.trim();
  if (!requestId) {
    return "Usage: /code-review approve <request-id>";
  }

  session.updateRequestStatus(requestId, "approved");
  return `Approved request '${requestId}'`;
}

function handleRejectRequest(session: ReviewSession, params: string): string {
  const requestId = params.trim();
  if (!requestId) {
    return "Usage: /code-review reject-request <request-id>";
  }

  session.updateRequestStatus(requestId, "rejected");
  return `Rejected request '${requestId}'`;
}

function handleAcceptComment(session: ReviewSession, params: string): string {
  const args = params.split(/\s+/);
  const [requestId, commentId, ...responseParts] = args;
  const response = responseParts.join(" ");

  if (!requestId || !commentId) {
    return "Usage: /code-review accept <request-id> <comment-id> [author-response]";
  }

  session.acceptComment(requestId, commentId, response || undefined);
  return `Accepted comment '${commentId}' in request '${requestId}'`;
}

function handleRejectComment(session: ReviewSession, params: string): string {
  const args = params.split(/\s+/);
  const [requestId, commentId, ...responseParts] = args;
  const response = responseParts.join(" ");

  if (!requestId || !commentId) {
    return "Usage: /code-review reject <request-id> <comment-id> [author-response]";
  }

  session.rejectComment(requestId, commentId, response || undefined);
  return `Rejected comment '${commentId}' in request '${requestId}'`;
}

function handleGenerateReport(session: ReviewSession, params: string): string {
  const requestId = params.trim();
  if (!requestId) {
    return "Usage: /code-review report <request-id>";
  }

  const summary = session.generateFinalReport(requestId);
  return session.formatFinalReport(summary);
}

function handleCriticEvaluate(session: ReviewSession, params: string): string {
  const args = params.split(/\s+/);
  const [requestId, commentId, evaluation, ...reasoningParts] = args;
  const reasoning = reasoningParts.join(" ");

  if (!requestId || !commentId || !evaluation) {
    return "Usage: /code-review critic <request-id> <comment-id> <reasonable|unreasonable|partially-reasonable> [reasoning]";
  }

  const validEvaluations = [
    "reasonable",
    "unreasonable",
    "partially-reasonable",
  ];
  if (!validEvaluations.includes(evaluation.toLowerCase())) {
    return `Invalid evaluation. Must be one of: ${validEvaluations.join(", ")}`;
  }

  // For now, use a default critic name
  const criticName = "critic-1";
  const assessment = session.addCriticAssessment(
    requestId,
    commentId,
    criticName,
    asCriticEvaluation(evaluation.toLowerCase()),
    reasoning || "No reasoning provided",
  );

  return (
    `Added critic evaluation from '${criticName}':\n` +
    `  Comment: ${commentId}\n` +
    `  Evaluation: ${assessment.evaluation}\n` +
    `  Reasoning: ${assessment.reasoning}`
  );
}

function handleCriticSummary(session: ReviewSession, params: string): string {
  const requestId = params.trim();
  if (!requestId) {
    return "Usage: /code-review critic-summary <request-id>";
  }

  return session.getCriticSummary(requestId);
}

function handleAddCritic(manager: CodeReviewManager, params: string): string {
  const args = params.split(/\s+/);
  const [teamName, name, ...expertiseParts] = args;
  const expertise =
    expertiseParts.length > 0
      ? expertiseParts
      : ["code-review", "quality-assurance"];

  if (!teamName || !name) {
    return "Usage: /code-review add-critic <team-name> <critic-name> [expertise1,expertise2,...]";
  }

  const member = {
    name,
    email: `${name}@yukino.dev`,
    role: "critic" as const,
    expertise,
  };

  manager.addMember(teamName, member);
  return `Added critic '${name}' to team '${teamName}' with expertise: ${expertise.join(", ")}`;
}

function showCodeReviewHelp(): string {
  return `Code Review Commands:
  /code-review create <team-name> [member1,member2,member3] - Create 3-person review team
  /code-review add <team-name> <member-name> [role] - Add member to team
  /code-review add-critic <team-name> <critic-name> [expertise] - Add critic to team
  /code-review remove <team-name> <member-name> - Remove member from team
  /code-review list - List all teams
  /code-review status <team-name> - Show team status
  /code-review activate <team-name> <member-name> - Activate member
  /code-review deactivate <team-name> <member-name> - Deactivate member
  /code-review request <team-name> <title> [description] - Create review request
  /code-review requests - List pending requests
  /code-review comment <request-id> <comment> - Add comment to request
  /code-review critic <request-id> <comment-id> <evaluation> [reasoning] - Evaluate comment as critic
  /code-review critic-summary <request-id> - Show critic evaluation summary
  /code-review accept <request-id> <comment-id> [response] - Accept suggestion
  /code-review reject <request-id> <comment-id> [response] - Reject suggestion
  /code-review report <request-id> - Generate final review report
  /code-review approve <request-id> - Approve request
  /code-review reject-request <request-id> - Reject request`;
}
