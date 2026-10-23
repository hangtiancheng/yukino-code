import { PLAN_AGENT_PROMPT } from "@yukino.js/subagent/prompts.js";

export function buildPlanPrompt(args: string): string {
  return args.trim()
    ? `${PLAN_AGENT_PROMPT}\n\nPlanning request: ${args}`
    : PLAN_AGENT_PROMPT;
}

export function buildReviewPrompt(args: string): string {
  return `You are an expert code reviewer. Review the requested pull request.

1. If no PR number or URL is provided, run \`gh pr list\` and return the open PRs so the user can choose one.
2. For the requested PR, run \`gh pr view <number-or-url>\` to get its details and \`gh pr diff <number-or-url>\` to get the diff.
3. Read relevant code and project instructions to understand the changes in context.
4. Provide a concise but thorough review covering what the PR does, code correctness, project conventions, performance, test coverage, and security. Report specific issues with file paths and line numbers, explain their impact, and suggest improvements. State any limitations or checks you could not complete.

Use clear sections and bullet points. Review only: do not modify files or publish a GitHub review. Return your findings directly.

PR number, URL, or additional review instructions: ${args}`;
}
