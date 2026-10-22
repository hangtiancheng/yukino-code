export function buildFeedbackIssueRejectionReminder(
  titles: readonly string[],
): string {
  const list = titles.map((title) => `- ${title}`).join("\n");
  return `<feedback_issue_rejection>\nThe user rejected filing these /feedback issues and asked you not to re-file them:\n${list}\n</feedback_issue_rejection>`;
}

export function buildFeedbackRejectionPrompt(reason: string): string {
  return `Feedback on the rejected /feedback issues:\n\n${reason}`;
}

export function buildPlanExecutionPrompt(planContent: string): string {
  return `Execute this plan:\n\n${planContent}`;
}
