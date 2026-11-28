import { REMINDER_INTERVAL } from "@/prompt/constants.js";
import {
  PLAN_MODE_APPROACH_BODY,
  PLAN_MODE_APPROACH_HEADER,
  PLAN_MODE_APPROACH_RETURN_VERB,
  PLAN_MODE_APPROACH_WRITE_VERB,
  PLAN_MODE_APPROVAL_HEADER,
  PLAN_MODE_ASK_USER_CLARIFICATION,
  PLAN_MODE_CONTEXT_HEADER,
  PLAN_MODE_COORDINATOR_APPROVAL,
  PLAN_MODE_COORDINATOR_CLARIFICATION,
  PLAN_MODE_COORDINATOR_CONTEXT,
  PLAN_MODE_DELEGATE_CONTEXT,
  PLAN_MODE_EXITED_BODY,
  PLAN_MODE_EXITED_HEADER,
  PLAN_MODE_EXIT_FOR_APPROVAL,
  PLAN_MODE_FILE_EXISTS,
  PLAN_MODE_FILE_LABEL,
  PLAN_MODE_FILE_MISSING,
  PLAN_MODE_FINISH_TURN_SUBMIT,
  PLAN_MODE_GATE_READONLY,
  PLAN_MODE_HEADER,
  PLAN_MODE_INSPECT_CONTEXT,
  PLAN_MODE_KEEP_CURRENT,
  PLAN_MODE_NO_MUTATION,
  PLAN_MODE_PERMANENT_READONLY,
  PLAN_MODE_READONLY_APPROVAL,
  PLAN_MODE_READONLY_CONSTRAINT,
  PLAN_MODE_READ_BEFORE_EDIT,
  PLAN_MODE_READ_ONLY_RUN,
  PLAN_MODE_REPORT_TO_LEADER_CLARIFICATION,
  PLAN_MODE_RETURN_TO_PARENT_CLARIFICATION,
  PLAN_MODE_STILL_ACTIVE,
  PLAN_MODE_SUBAGENT_EXIT_PLAN_MODE,
  PLAN_MODE_SUBAGENT_RETURN_PLAN,
  PLAN_MODE_TEAMMATE_AUTO_APPROVAL,
  PLAN_MODE_TEAMMATE_LEADER_REVIEW,
  PLAN_MODE_TEAMMATE_RETURN_PLAN,
  PLAN_MODE_TEAMMATE_SUBMIT_PLAN,
  PLAN_MODE_WRITABLE_CONSTRAINT,
  PLAN_MODE_WRITE_WITH_WRITEFILE,
  buildPlanModeExitFileNote,
  buildPlanModeReentryText,
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
  if (iteration > 1 && (iteration - 1) % REMINDER_INTERVAL !== 0) {
    return `${PLAN_MODE_STILL_ACTIVE} ${constraint} ${PLAN_MODE_FILE_LABEL} ${planPath}. ${PLAN_MODE_KEEP_CURRENT} ${clarification} ${approval}`;
  }
  const fileInfo = [`${PLAN_MODE_FILE_LABEL} ${planPath}`];
  fileInfo.push(planExist ? PLAN_MODE_FILE_EXISTS : PLAN_MODE_FILE_MISSING);
  if (writable) {
    fileInfo.push(
      planExist && canEditFile
        ? PLAN_MODE_READ_BEFORE_EDIT
        : PLAN_MODE_WRITE_WITH_WRITEFILE,
    );
  }
  return [
    PLAN_MODE_HEADER,
    `${constraint} ${PLAN_MODE_NO_MUTATION} ${readOnly ? PLAN_MODE_PERMANENT_READONLY : PLAN_MODE_GATE_READONLY}`,
    fileInfo.join("\n"),
    `${PLAN_MODE_CONTEXT_HEADER}\n${isCoordinator ? PLAN_MODE_COORDINATOR_CONTEXT : PLAN_MODE_INSPECT_CONTEXT} ${clarification}${canDelegate ? ` ${PLAN_MODE_DELEGATE_CONTEXT}` : ""}`,
    `${PLAN_MODE_APPROACH_HEADER}\n${writable ? PLAN_MODE_APPROACH_WRITE_VERB : PLAN_MODE_APPROACH_RETURN_VERB} ${PLAN_MODE_APPROACH_BODY}`,
    `${PLAN_MODE_APPROVAL_HEADER}\n${approval}`,
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
  return `${PLAN_MODE_EXITED_HEADER}\n\n${PLAN_MODE_EXITED_BODY}${planExists ? ` ${buildPlanModeExitFileNote(planPath)}` : ""}`;
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
  return buildPlanModeReentryText(planPath);
}
