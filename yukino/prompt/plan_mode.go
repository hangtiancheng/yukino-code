// Copyright (c) 2026 hangtiancheng
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

package prompt

import "strings"

// planModeFullReminder is displayed on the first iteration and every reminderInterval iterations.
const planModeFullReminder = `# Plan mode
Read-only except the declared plan file. You MUST NOT make any edits elsewhere, run mutating tools, change configs, or commit. Do not begin implementation before the runtime approval gate allows it.

%PLAN_FILE_INFO%

## Context
Inspect relevant code and reusable patterns. Clarify material unknowns with AskUserQuestion. Delegate bounded read-only research only when useful; at most 3 independent explore agents, with no mandatory plan agent.

## Approach
Write only the recommended approach in the plan file, starting with Context. Include the files to change, constraints, and a Verification section with concrete checks. Keep the plan proportional to the task and refine it as evidence arrives.

## Approval
When the plan is ready, call ExitPlanMode for approval. End with AskUserQuestion only for needed clarification, or ExitPlanMode for the handoff. Never request approval through prose or AskUserQuestion; wait for the runtime to exit plan mode.`

// planModeSparseReminder shows only the key rules during intermediate iterations.
const planModeSparseReminder = `Plan mode still active. Read-only except plan file (%PLAN_PATH%). Keep Context, Approach, files, and Verification current. Use AskUserQuestion for clarification; call ExitPlanMode for approval, never prose or AskUserQuestion. Do not implement before the runtime approval gate allows it.`

// planModeExitTemplate is the reminder shown after exiting Plan Mode.
const planModeExitTemplate = `## Exited Plan Mode

Plan mode has ended. Proceed within the approved scope and current permissions.%EXTRA%`

// planModeReentryTemplate is the reminder for re-entering Plan Mode: it tells the model a plan
// file already exists and editing can continue from it.
const planModeReentryTemplate = `Plan mode is active again. Review the existing plan at %PLAN_PATH%; refine or replace it as needed. Stay read-only except that file, and use ExitPlanMode for approval before implementation.`

// reminderInterval is how many iterations before repeating the full reminder.
const reminderInterval = 5

// BuildPlanModeReminder builds the Plan Mode reminder, switching between full and sparse reminders
// based on the iteration count. Shows the full reminder on the first iteration and every
// reminderInterval iterations thereafter; returns the sparse reminder for other iterations to save
// tokens.
func BuildPlanModeReminder(planFilePath string, planExists bool, iteration int) string {
	planFileInfo := "Plan file: " + planFilePath
	if planExists {
		planFileInfo += "\nA plan file already exists at " + planFilePath + ". You can read it and make incremental edits using the EditFile tool."
	} else {
		planFileInfo += "\nNo plan file exists yet. You should create your plan at " + planFilePath + " using the WriteFile tool."
	}

	// Send the full reminder on the first iteration and every reminderInterval iterations thereafter:
	// resending it every iteration is too token-expensive, but sending it only once causes gradual
	// drift; periodic repetition strikes a balance between the two.
	if (iteration-1)%reminderInterval == 0 {
		return strings.Replace(planModeFullReminder, "%PLAN_FILE_INFO%", planFileInfo, 1)
	}

	// Use the sparse reminder for intermediate iterations.
	return strings.Replace(planModeSparseReminder, "%PLAN_PATH%", planFilePath, 1)
}

// BuildPlanModeExitReminder builds the reminder displayed after exiting Plan Mode. If a plan file
// exists, it prompts the model to reference the file path.
func BuildPlanModeExitReminder(planFilePath string, planExists bool) string {
	extra := ""
	if planExists {
		extra = " The plan file is located at " + planFilePath + " if you need to reference it."
	}
	return strings.Replace(planModeExitTemplate, "%EXTRA%", extra, 1)
}

// BuildPlanModeReentryReminder builds the reminder displayed when re-entering Plan Mode.
// Returns non-empty content only when a plan file already exists, reminding the model to continue
// editing the existing plan.
func BuildPlanModeReentryReminder(planFilePath string, planExists bool) string {
	if !planExists {
		return ""
	}
	return strings.Replace(planModeReentryTemplate, "%PLAN_PATH%", planFilePath, 1)
}
