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

import type { CodeReviewManager, CodeReviewMember } from "./manager.js";

import { createChildLogger } from "@/logger/index.js";

const log = createChildLogger({ module: "code-review" });

export interface ReviewRequest {
  id: string;
  title: string;
  description: string;
  author: string;
  branch: string;
  files: string[];
  status:
    "pending" | "in-review" | "approved" | "rejected" | "changes-requested";
  createdAt: string;
  updatedAt: string;
  reviewers: string[];
  comments: ReviewComment[];
}

export type CommentResolution =
  "accepted" | "rejected" | "pending" | "resolved";
export type CriticEvaluation =
  "reasonable" | "unreasonable" | "partially-reasonable";

export function isCriticEvaluation(str: string): str is CriticEvaluation {
  return (
    str === "reasonable" ||
    str === "unreasonable" ||
    str === "partially-reasonable"
  );
}

export function asCriticEvaluation(str: string): CriticEvaluation {
  if (isCriticEvaluation(str)) {
    return str;
  } else {
    log.error({ str }, "code-review operation failed");
    // return "partially-reasonable"; // best-effort
    throw new Error(str);
  }
}

export interface CriticAssessment {
  commentId: string;
  critic: string;
  evaluation: CriticEvaluation;
  reasoning: string;
  timestamp: string;
}

export interface ReviewComment {
  id: string;
  reviewer: string;
  file?: string;
  line?: number;
  content: string;
  timestamp: string;
  resolved: boolean;
  resolution?: CommentResolution;
  authorResponse?: string;
  resolutionTimestamp?: string;
  criticAssessments: CriticAssessment[];
}

export interface ReviewSummary {
  requestId: string;
  title: string;
  author: string;
  reviewers: string[];
  totalComments: number;
  acceptedSuggestions: number;
  rejectedSuggestions: number;
  pendingSuggestions: number;
  resolvedIssues: number;
  overallConclusion: "approved" | "rejected" | "changes-requested";
  keyFindings: string[];
  fileSpecificFeedback: Map<string, FileFeedback>;
  generatedAt: string;
}

export interface FileFeedback {
  fileName: string;
  totalComments: number;
  acceptedCount: number;
  rejectedCount: number;
  pendingCount: number;
  issues: CommentIssue[];
}

export interface CommentIssue {
  commentId: string;
  reviewer: string;
  line?: number;
  content: string;
  resolution: CommentResolution;
  authorResponse?: string;
}

export class ReviewSession {
  private requests = new Map<string, ReviewRequest>();
  private manager: CodeReviewManager;
  private workDir: string;
  private commentCounter = 0;

  constructor(workDir: string, manager: CodeReviewManager) {
    this.workDir = workDir;
    this.manager = manager;
    this.loadRequests();
  }

  private getCritics(teamName: string): CodeReviewMember[] {
    const team = this.manager.getTeam(teamName);
    if (!team) {
      throw new Error(`Team '${teamName}' not found`);
    }
    return team.members.filter((m) => m.active && m.role === "critic");
  }

  private loadRequests(): void {
    // Load from disk if needed
  }

  createReviewRequest(
    teamName: string,
    title: string,
    description: string,
    author: string,
    branch: string,
    files: string[],
  ): ReviewRequest {
    const team = this.manager.getTeam(teamName);
    if (!team) {
      throw new Error(`Team '${teamName}' not found`);
    }

    const reviewers = this.manager
      .getActiveReviewers(teamName)
      .map((r) => r.name);
    if (reviewers.length === 0) {
      throw new Error(`No active reviewers in team '${teamName}'`);
    }

    const request: ReviewRequest = {
      id: `review-${String(Date.now())}`,
      title,
      description,
      author,
      branch,
      files,
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reviewers,
      comments: [],
    };

    this.requests.set(request.id, request);
    return request;
  }

  getRequest(id: string): ReviewRequest | undefined {
    return this.requests.get(id);
  }

  updateRequestStatus(id: string, status: ReviewRequest["status"]): void {
    const request = this.requests.get(id);
    if (!request) {
      throw new Error(`Request '${id}' not found`);
    }
    request.status = status;
    request.updatedAt = new Date().toISOString();
  }

  addComment(
    requestId: string,
    reviewer: string,
    content: string,
    file?: string,
    line?: number,
  ): ReviewComment {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Request '${requestId}' not found`);
    }

    const comment: ReviewComment = {
      id: `comment-${String(Date.now())}-${String(++this.commentCounter)}`,
      reviewer,
      file,
      line,
      content,
      timestamp: new Date().toISOString(),
      resolved: false,
      criticAssessments: [],
    };

    request.comments.push(comment);
    request.updatedAt = new Date().toISOString();
    return comment;
  }

  resolveComment(requestId: string, commentId: string): void {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Request '${requestId}' not found`);
    }
    const comment = request.comments.find((c) => c.id === commentId);
    if (!comment) {
      throw new Error(`Comment '${commentId}' not found`);
    }
    comment.resolved = true;
    comment.resolution = "resolved";
    comment.resolutionTimestamp = new Date().toISOString();
    request.updatedAt = new Date().toISOString();
  }

  acceptComment(
    requestId: string,
    commentId: string,
    authorResponse?: string,
  ): void {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Request '${requestId}' not found`);
    }
    const comment = request.comments.find((c) => c.id === commentId);
    if (!comment) {
      throw new Error(`Comment '${commentId}' not found`);
    }
    comment.resolved = true;
    comment.resolution = "accepted";
    comment.authorResponse = authorResponse;
    comment.resolutionTimestamp = new Date().toISOString();
    request.updatedAt = new Date().toISOString();
  }

  rejectComment(
    requestId: string,
    commentId: string,
    authorResponse?: string,
  ): void {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Request '${requestId}' not found`);
    }
    const comment = request.comments.find((c) => c.id === commentId);
    if (!comment) {
      throw new Error(`Comment '${commentId}' not found`);
    }
    comment.resolved = true;
    comment.resolution = "rejected";
    comment.authorResponse = authorResponse;
    comment.resolutionTimestamp = new Date().toISOString();
    request.updatedAt = new Date().toISOString();
  }

  addCriticAssessment(
    requestId: string,
    commentId: string,
    critic: string,
    evaluation: CriticEvaluation,
    reasoning: string,
  ): CriticAssessment {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Request '${requestId}' not found`);
    }
    const comment = request.comments.find((c) => c.id === commentId);
    if (!comment) {
      throw new Error(`Comment '${commentId}' not found`);
    }

    const assessment: CriticAssessment = {
      commentId,
      critic,
      evaluation,
      reasoning,
      timestamp: new Date().toISOString(),
    };

    comment.criticAssessments.push(assessment);
    request.updatedAt = new Date().toISOString();
    return assessment;
  }

  evaluateCommentByCritic(
    requestId: string,
    commentId: string,
    criticName: string,
    isReasonable: boolean,
    reasoning: string,
  ): CriticAssessment {
    const evaluation: CriticEvaluation = isReasonable
      ? "reasonable"
      : "unreasonable";
    return this.addCriticAssessment(
      requestId,
      commentId,
      criticName,
      evaluation,
      reasoning,
    );
  }

  getCriticSummary(requestId: string): string {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Request '${requestId}' not found`);
    }

    let summary = `> CRITIC EVALUATION SUMMARY\n`;
    summary += `═════════════════════════════════════════════════════════════════\n\n`;
    summary += `Request: ${request.title}\n`;
    summary += `Total Comments: ${String(request.comments.length)}\n\n`;

    let reasonableCount = 0;
    let unreasonableCount = 0;
    let partiallyReasonableCount = 0;
    let notEvaluatedCount = 0;

    for (const comment of request.comments) {
      if (comment.criticAssessments.length === 0) {
        notEvaluatedCount++;
        continue;
      }

      summary += `* Comment by ${comment.reviewer}\n`;
      if (comment.file) {
        summary += `   File: ${comment.file}${comment.line ? `:${String(comment.line)}` : ""}\n`;
      }
      summary += `   "${comment.content.substring(0, 80)}${comment.content.length > 80 ? "..." : ""}"\n\n`;

      for (const assessment of comment.criticAssessments) {
        const icon =
          assessment.evaluation === "reasonable"
            ? "Y"
            : assessment.evaluation === "unreasonable"
              ? "N"
              : "!";
        summary += `   ${icon} Critic: ${assessment.critic}\n`;
        summary += `   Verdict: ${assessment.evaluation.toUpperCase()}\n`;
        summary += `   Reasoning: ${assessment.reasoning}\n`;
        summary += `   Time: ${new Date(assessment.timestamp).toLocaleString()}\n\n`;

        if (assessment.evaluation === "reasonable") {
          reasonableCount++;
        } else if (assessment.evaluation === "unreasonable") {
          unreasonableCount++;
        } else {
          partiallyReasonableCount++;
        }
      }
      summary += `─────────────────────────────────────────────────────────────────\n\n`;
    }

    summary += `> EVALUATION STATISTICS\n`;
    summary += `═════════════════════════════════════════════════════════════════\n`;
    summary += `* Reasonable: ${String(reasonableCount)}\n`;
    summary += `* Unreasonable: ${String(unreasonableCount)}\n`;
    summary += `* Partially Reasonable: ${String(partiallyReasonableCount)}\n`;
    summary += `* Not Evaluated: ${String(notEvaluatedCount)}\n`;

    const totalEvaluated =
      reasonableCount + unreasonableCount + partiallyReasonableCount;
    if (totalEvaluated > 0) {
      const reasonablePercentage = (
        (reasonableCount / totalEvaluated) *
        100
      ).toFixed(1);
      summary += `* Reasonable Rate: ${reasonablePercentage}%\n`;
    }

    return summary;
  }

  generateFinalReport(requestId: string): ReviewSummary {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error(`Request '${requestId}' not found`);
    }

    const acceptedCount = request.comments.filter(
      (c) => c.resolution === "accepted",
    ).length;
    const rejectedCount = request.comments.filter(
      (c) => c.resolution === "rejected",
    ).length;
    const pendingCount = request.comments.filter(
      (c) => !c.resolution || c.resolution === "pending",
    ).length;
    const resolvedCount = request.comments.filter((c) => c.resolved).length;

    // Determine overall conclusion
    let overallConclusion: "approved" | "rejected" | "changes-requested";
    if (rejectedCount > acceptedCount && rejectedCount >= 3) {
      overallConclusion = "rejected";
    } else if (pendingCount > 0 || (acceptedCount > 0 && rejectedCount > 0)) {
      overallConclusion = "changes-requested";
    } else {
      overallConclusion = "approved";
    }

    // Extract key findings from comments
    const keyFindings = request.comments
      .filter((c) => c.resolution === "accepted" || c.resolution === "pending")
      .map(
        (c) =>
          `[${c.reviewer}] ${c.content.substring(0, 100)}${c.content.length > 100 ? "..." : ""}`,
      );

    // Group feedback by file
    const fileFeedback = new Map<string, FileFeedback>();
    for (const comment of request.comments) {
      if (!comment.file) {
        continue;
      }

      const fileName = comment.file;
      if (!fileFeedback.has(fileName)) {
        fileFeedback.set(fileName, {
          fileName,
          totalComments: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          pendingCount: 0,
          issues: [],
        });
      }

      const feedback = fileFeedback.get(fileName);
      if (!feedback) {
        continue;
      }
      feedback.totalComments++;

      if (comment.resolution === "accepted") {
        feedback.acceptedCount++;
      } else if (comment.resolution === "rejected") {
        feedback.rejectedCount++;
      } else {
        feedback.pendingCount++;
      }

      feedback.issues.push({
        commentId: comment.id,
        reviewer: comment.reviewer,
        line: comment.line,
        content: comment.content,
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
        resolution: comment.resolution || "pending",
        authorResponse: comment.authorResponse,
      });
    }

    return {
      requestId: request.id,
      title: request.title,
      author: request.author,
      reviewers: request.reviewers,
      totalComments: request.comments.length,
      acceptedSuggestions: acceptedCount,
      rejectedSuggestions: rejectedCount,
      pendingSuggestions: pendingCount,
      resolvedIssues: resolvedCount,
      overallConclusion,
      keyFindings,
      fileSpecificFeedback: fileFeedback,
      generatedAt: new Date().toISOString(),
    };
  }

  formatFinalReport(summary: ReviewSummary): string {
    const conclusionColors = {
      approved: "Y",
      rejected: "N",
      "changes-requested": "!",
    };

    let report = `
╔════════════════════════════════════════════════════════════════╗
║                    CODE REVIEW FINAL REPORT                    ║
╚════════════════════════════════════════════════════════════════╝

> REVIEW INFORMATION
─────────────────────────────────────────────────────────────────
Request ID:     ${summary.requestId}
Title:          ${summary.title}
Author:         ${summary.author}
Reviewers:      ${summary.reviewers.join(", ")}
Generated:      ${new Date(summary.generatedAt).toLocaleString()}

> SUMMARY STATISTICS
─────────────────────────────────────────────────────────────────
Total Comments:          ${String(summary.totalComments)}
* Accepted Suggestions:  ${String(summary.acceptedSuggestions)}
* Rejected Suggestions:  ${String(summary.rejectedSuggestions)}
* Pending Suggestions:   ${String(summary.pendingSuggestions)}
* Resolved Issues:       ${String(summary.resolvedIssues)}

* OVERALL CONCLUSION: ${conclusionColors[summary.overallConclusion]} ${summary.overallConclusion.toUpperCase()}
─────────────────────────────────────────────────────────────────

> KEY FINDINGS
─────────────────────────────────────────────────────────────────
`;

    if (summary.keyFindings.length === 0) {
      report += "No key findings identified.\n";
    } else {
      summary.keyFindings.forEach((finding, index) => {
        report += `${String(index + 1)}. ${finding}\n`;
      });
    }

    report += `
> FILE-SPECIFIC FEEDBACK
─────────────────────────────────────────────────────────────────
`;

    if (summary.fileSpecificFeedback.size === 0) {
      report += "No file-specific feedback available.\n";
    } else {
      for (const [fileName, feedback] of summary.fileSpecificFeedback) {
        report += `
File: ${fileName}
${"─".repeat(60)}
Total Comments: ${String(feedback.totalComments)}
  Y Accepted: ${String(feedback.acceptedCount)}
  N Rejected: ${String(feedback.rejectedCount)}
  ... Pending:  ${String(feedback.pendingCount)}

`;
        if (feedback.issues.length > 0) {
          feedback.issues.forEach((issue, idx) => {
            const resolutionIcon = {
              accepted: "Y",
              rejected: "N",
              pending: "...",
              resolved: "OK",
            }[issue.resolution];

            report += `  ${String(idx + 1)}. ${resolutionIcon} [${issue.reviewer}]`;
            if (issue.line) {
              report += ` (Line ${String(issue.line)})`;
            }
            report += `\n     "${issue.content}"\n`;

            if (issue.authorResponse) {
              report += `     → Author response: "${issue.authorResponse}"\n`;
            }
            report += `\n`;
          });
        }
      }
    }

    report += `
═════════════════════════════════════════════════════════════════
                    END OF REPORT
═════════════════════════════════════════════════════════════════
`;

    return report;
  }

  getPendingRequests(): ReviewRequest[] {
    return [...this.requests.values()].filter(
      (r) => r.status === "pending" || r.status === "in-review",
    );
  }

  getRequestSummary(id: string): string {
    const request = this.requests.get(id);
    if (!request) {
      throw new Error(`Request '${id}' not found`);
    }

    const resolvedComments = request.comments.filter((c) => c.resolved).length;
    return (
      `Review: ${request.title} (${request.id})\n` +
      `Author: ${request.author}\n` +
      `Branch: ${request.branch}\n` +
      `Status: ${request.status}\n` +
      `Reviewers: ${request.reviewers.join(", ")}\n` +
      `Files: ${String(request.files.length)}\n` +
      `Comments: ${String(request.comments.length)} (${String(resolvedComments)} resolved)\n` +
      `Created: ${new Date(request.createdAt).toLocaleString()}`
    );
  }
}
