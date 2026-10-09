interface PlanCapabilities {
  canAskUser?: boolean;
  canExitPlanMode?: boolean;
  canSendMessage?: boolean;
  canWriteFile?: boolean;
  canEditFile?: boolean;
  canDelegate?: boolean;
  isCoordinator?: boolean;
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
  } = capabilities;
  const writable = canWriteFile || (planExist && canEditFile);
  const constraint = writable
    ? "Read-only except the declared plan file."
    : "Read-only. Return the plan in your final response; do not create or edit files.";
  const clarification = isCoordinator
    ? "State material unknowns in your user-facing response; teammate messages are not user clarification or approval."
    : canAskUser
      ? "Use AskUserQuestion only for needed clarification, never approval."
      : canSendMessage
        ? "Report material unknowns to the leader with SendMessage."
        : "Return material unknowns to the parent in your final response.";
  const approval = isCoordinator
    ? "Return the synthesized plan to the user. Stay read-only until the user leaves plan mode with Shift+Tab. Do not submit your own plan to a teammate or treat a worker report as approval."
    : canExitPlanMode
      ? "When the plan is ready, call ExitPlanMode for approval; never request approval through prose. Wait for the runtime approval gate before implementation."
      : canSendMessage
        ? "When the plan is ready, finish the turn. The runtime will submit and automatically approve the plan, then resume execution under the current tool permissions. Do not ask the leader to approve it through SendMessage."
        : "When the plan is ready, return it to the parent. This read-only run cannot enter implementation mode.";
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
    `${constraint} Do not run mutating tools, change configs, or commit. Do not begin implementation before the runtime approval gate allows it.`,
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
