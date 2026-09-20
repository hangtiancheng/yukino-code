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

// Plan Mode full reminder: displayed on the first iteration and every reminderInterval iterations
const planModeFullReminder = `# Plan mode
Read-only except the declared plan file. You MUST NOT make any edits elsewhere, run mutating tools, change configs, or commit. Do not begin implementation before the runtime approval gate allows it.

%PLAN_FILE_INFO%

## Context
Inspect relevant code and reusable patterns. Clarify material unknowns with AskUserQuestion. Delegate bounded read-only research only when useful; at most 3 independent explore agents, with no mandatory plan agent.

## Approach
Write only the recommended approach in the plan file, starting with Context. Include the files to change, constraints, and a Verification section with concrete checks. Keep the plan proportional to the task and refine it as evidence arrives.

## Approval
When the plan is ready, call ExitPlanMode for approval. End with AskUserQuestion only for needed clarification, or ExitPlanMode for the handoff. Never request approval through prose or AskUserQuestion; wait for the runtime to exit plan mode.`;

// Plan Mode sparse reminder: only key rules are displayed during intermediate iterations
const planModeSparseReminder = `Plan mode still active. Read-only except plan file (%PLAN_PATH%). Keep Context, Approach, files, and Verification current. Use AskUserQuestion for clarification; call ExitPlanMode for approval, never prose or AskUserQuestion. Do not implement before the runtime approval gate allows it.`;

// Prompt for exiting Plan Mode
const planModeExitTemplate = `## Exited Plan Mode

Plan mode has ended. Proceed within the approved scope and current permissions.%EXTRA%`;

// Prompt for re-entering Plan Mode: reminds the model that a plan file already exists and can be continued
const planModeReentryTemplate = `Plan mode is active again. Review the existing plan at %PLAN_PATH%; refine or replace it as needed. Stay read-only except that file, and use ExitPlanMode for approval before implementation.`;

// How many iterations before repeating the full reminder
const reminderInterval = 5;

/**
 * Builds the Plan Mode reminder, switching between full and sparse reminders based on the iteration count.
 * Shows the full reminder on the first iteration and every `reminderInterval` iterations thereafter;
 * returns the sparse reminder for other iterations to save tokens.
 */
export function buildPlanModeReminder(
  planPath: string,
  planExist: boolean,
  iteration: number,
): string {
  // Construct the plan file info section
  let planFileInfo = `Plan file: ${planPath}`;
  if (planExist) {
    planFileInfo += `\nA plan file already exists at ${planPath}. You can read it and make incremental edits using the EditFile tool.`;
  } else {
    planFileInfo += `\nNo plan file exists yet. You should create your plan at ${planPath} using the WriteFile tool.`;
  }

  // Send the full reminder on the first iteration and every `reminderInterval` iterations thereafter:
  // resending it every iteration is too token-expensive, but sending it only once causes gradual drift;
  // periodic repetition strikes a balance between the two
  if ((iteration - 1) % reminderInterval === 0) {
    return planModeFullReminder.replace("%PLAN_FILE_INFO%", () => planFileInfo);
  }

  // Use the sparse reminder for intermediate iterations
  return planModeSparseReminder.replace("%PLAN_PATH%", () => planPath);
}

/**
 * Builds the reminder displayed after exiting Plan Mode.
 * If a plan file exists, prompts the model to reference the file path.
 */
export function buildPlanModeExitReminder(
  planPath: string,
  planExists: boolean,
): string {
  let extra = "";
  if (planExists) {
    extra = ` The plan file is located at ${planPath} if you need to reference it.`;
  }
  return planModeExitTemplate.replace("%EXTRA%", () => extra);
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
  return planModeReentryTemplate.replace("%PLAN_PATH%", () => planPath);
}
