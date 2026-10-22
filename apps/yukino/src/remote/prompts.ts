export function buildPlanExecutionPrompt(planContent: string): string {
  return `Execute this plan:\n\n${planContent}`;
}
