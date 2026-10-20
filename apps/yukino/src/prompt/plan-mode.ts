import {
  PLAN_MODE_ASK_USER_CLARIFICATION,
  PLAN_MODE_COORDINATOR_APPROVAL,
  PLAN_MODE_COORDINATOR_CLARIFICATION,
  PLAN_MODE_EXIT_FOR_APPROVAL,
  PLAN_MODE_FINISH_TURN_SUBMIT,
  PLAN_MODE_READONLY_APPROVAL,
  PLAN_MODE_READONLY_CONSTRAINT,
  PLAN_MODE_READ_ONLY_RUN,
  PLAN_MODE_REPORT_TO_LEADER_CLARIFICATION,
  PLAN_MODE_RETURN_TO_PARENT_CLARIFICATION,
  PLAN_MODE_SUBAGENT_EXIT_PLAN_MODE,
  PLAN_MODE_SUBAGENT_RETURN_PLAN,
  PLAN_MODE_TEAMMATE_AUTO_APPROVAL,
  PLAN_MODE_TEAMMATE_LEADER_REVIEW,
  PLAN_MODE_TEAMMATE_RETURN_PLAN,
  PLAN_MODE_TEAMMATE_SUBMIT_PLAN,
  PLAN_MODE_WRITABLE_CONSTRAINT,
} from "@/prompt/prompts.js";

interface PlanCapabilities {
  canAskUser?: boolean;
  canExitPlanMode?: boolean;
  canSendMessage?: boolean;
  canWriteFile?: boolean;
  canEditFile?: boolean;
  canDelegate?: boolean;
  isCoordinator?: boolean;
  isSubagent?: boolean;
  isTeammate?: boolean;
  requiresLeaderPlanApproval?: boolean;
  readOnly?: boolean;
}

export function buildPlanModeReminder(
  planPath: string,
  planExist: boolean,
  iteration: number,
  capabilities: PlanCapabilities = {},
): string {
  const {
    canAskUser = true,
    canExitPlanMode = true,
    canSendMessage = false,
    canWriteFile = true,
    canEditFile = true,
    canDelegate = true,
    isCoordinator = false,
    isSubagent = false,
    isTeammate = false,
    requiresLeaderPlanApproval = false,
    readOnly = false,
  } = capabilities;
  const writable = canWriteFile || (planExist && canEditFile);
  const constraint = writable
    ? PLAN_MODE_WRITABLE_CONSTRAINT
    : PLAN_MODE_READONLY_CONSTRAINT;
  const clarification = isCoordinator
    ? PLAN_MODE_COORDINATOR_CLARIFICATION
    : canAskUser
      ? PLAN_MODE_ASK_USER_CLARIFICATION
      : canSendMessage
        ? PLAN_MODE_REPORT_TO_LEADER_CLARIFICATION
        : PLAN_MODE_RETURN_TO_PARENT_CLARIFICATION;
  const approval = isCoordinator
    ? PLAN_MODE_COORDINATOR_APPROVAL
    : readOnly
      ? PLAN_MODE_READONLY_APPROVAL
      : isTeammate
        ? `${canExitPlanMode ? PLAN_MODE_TEAMMATE_SUBMIT_PLAN : PLAN_MODE_TEAMMATE_RETURN_PLAN} ${requiresLeaderPlanApproval ? PLAN_MODE_TEAMMATE_LEADER_REVIEW : PLAN_MODE_TEAMMATE_AUTO_APPROVAL}`
        : isSubagent
          ? `${canExitPlanMode ? PLAN_MODE_SUBAGENT_EXIT_PLAN_MODE : PLAN_MODE_SUBAGENT_RETURN_PLAN} ${PLAN_MODE_READ_ONLY_RUN}`
          : canExitPlanMode
            ? PLAN_MODE_EXIT_FOR_APPROVAL
            : canSendMessage
              ? PLAN_MODE_FINISH_TURN_SUBMIT
              : `${PLAN_MODE_SUBAGENT_RETURN_PLAN} ${PLAN_MODE_READ_ONLY_RUN}`;
  if (iteration > 1 && (iteration - 1) % 5 !== 0) {
    return `Plan mode still active. ${constraint} Plan file: ${planPath}. Keep Context, Approach, files, and Verification current. ${clarification} ${approval}`;
  }
  const fileInfo = [`Plan file: ${planPath}`];
  fileInfo.push(
    planExist ? "A plan file already exists." : "No plan file exists yet.",
  );
  if (writable) {
    fileInfo.push(
      planExist && canEditFile
        ? "Read it before updating it with EditFile."
        : "Write the recommended plan there with WriteFile.",
    );
  }
  return [
    "# Plan mode",
    `${constraint} Do not run mutating tools, change configs, or commit. ${readOnly ? "This role is permanently read-only; do not begin implementation." : "Do not begin implementation before the runtime approval gate allows it."}`,
    fileInfo.join("\n"),
    `## Context\n${isCoordinator ? "Synthesize code evidence from workers; do not inspect files or run commands yourself." : "Inspect relevant code and reusable patterns."} ${clarification}${canDelegate ? " Delegate bounded read-only research only when useful; at most 3 independent explore agents, with no mandatory plan agent." : ""}`,
    `## Approach\n${writable ? "Write" : "Return"} only the recommended approach, starting with Context. Include files to change, constraints, and a Verification section with concrete checks. Keep the plan proportional to the task; refine it as evidence arrives.`,
    `## Approval\n${approval}`,
  ].join("\n\n");
}

/**
 * Builds the reminder displayed after exiting Plan Mode.
 * If a plan file exists, includes its path in case the model needs to reference it.
 */
export function buildPlanModeExitReminder(
  planPath: string,
  planExists: boolean,
): string {
  return `## Exited Plan Mode\n\nPlan mode has ended. Proceed within the user's requested scope and current permissions.${planExists ? ` The plan file is located at ${planPath} if you need to reference it.` : ""}`;
}

/**
 * Builds the reminder displayed when re-entering Plan Mode.
 * Only returns non-empty content if a plan file already exists, reminding the model to continue editing the existing plan.
 */
export function buildPlanModeReentryReminder(
  planPath: string,
  planFileExists: boolean,
): string {
  if (!planFileExists) {
    return "";
  }
  return `Plan mode is active again. Review the existing plan at ${planPath}; refine or replace it as needed. Stay read-only except that file, and use the current runtime approval gate before implementation.`;
}
