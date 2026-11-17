package prompt

import (
	"fmt"
	"strings"
)

const reminderInterval = 5

type PlanCapabilities struct {
	CanAskUser                 bool
	CanExitPlanMode            bool
	CanSendMessage             bool
	CanWriteFile               bool
	CanEditFile                bool
	CanDelegate                bool
	IsCoordinator              bool
	IsSubagent                 bool
	IsTeammate                 bool
	RequiresLeaderPlanApproval bool
	ReadOnly                   bool
}

func BuildPlanModeReminder(path string, exists bool, iteration int, c PlanCapabilities) string {
	writable := c.CanWriteFile || (exists && c.CanEditFile)
	constraint := PLAN_MODE_READONLY_CONSTRAINT
	if writable {
		constraint = PLAN_MODE_WRITABLE_CONSTRAINT
	}
	clarification := PLAN_MODE_RETURN_TO_PARENT_CLARIFICATION
	if c.IsCoordinator {
		clarification = PLAN_MODE_COORDINATOR_CLARIFICATION
	} else if c.CanAskUser {
		clarification = PLAN_MODE_ASK_USER_CLARIFICATION
	} else if c.CanSendMessage {
		clarification = PLAN_MODE_REPORT_TO_LEADER_CLARIFICATION
	}
	approval := PLAN_MODE_SUBAGENT_RETURN_PLAN + " " + PLAN_MODE_READ_ONLY_RUN
	switch {
	case c.IsCoordinator:
		approval = PLAN_MODE_COORDINATOR_APPROVAL
	case c.ReadOnly:
		approval = PLAN_MODE_READONLY_APPROVAL
	case c.IsTeammate:
		approval = PLAN_MODE_TEAMMATE_RETURN_PLAN
		if c.CanExitPlanMode {
			approval = PLAN_MODE_TEAMMATE_SUBMIT_PLAN
		}
		if c.RequiresLeaderPlanApproval {
			approval += " " + PLAN_MODE_TEAMMATE_LEADER_REVIEW
		} else {
			approval += " " + PLAN_MODE_TEAMMATE_AUTO_APPROVAL
		}
	case c.IsSubagent:
		if c.CanExitPlanMode {
			approval = PLAN_MODE_SUBAGENT_EXIT_PLAN_MODE + " " + PLAN_MODE_READ_ONLY_RUN
		}
	case c.CanExitPlanMode:
		approval = PLAN_MODE_EXIT_FOR_APPROVAL
	case c.CanSendMessage:
		approval = PLAN_MODE_FINISH_TURN_SUBMIT
	}
	if iteration > 1 && (iteration-1)%5 != 0 {
		return fmt.Sprintf("%s %s %s %s. %s %s %s", PLAN_MODE_STILL_ACTIVE, constraint, PLAN_MODE_FILE_LABEL, path, PLAN_MODE_KEEP_CURRENT, clarification, approval)
	}
	info := PLAN_MODE_FILE_LABEL + " " + path
	if exists {
		info += "\n" + PLAN_MODE_FILE_EXISTS
	} else {
		info += "\n" + PLAN_MODE_FILE_MISSING
	}
	if writable {
		if exists && c.CanEditFile {
			info += "\n" + PLAN_MODE_READ_BEFORE_EDIT
		} else {
			info += "\n" + PLAN_MODE_WRITE_WITH_WRITEFILE
		}
	}
	guard := PLAN_MODE_GATE_READONLY
	if c.ReadOnly {
		guard = PLAN_MODE_PERMANENT_READONLY
	}
	context := PLAN_MODE_INSPECT_CONTEXT
	if c.IsCoordinator {
		context = PLAN_MODE_COORDINATOR_CONTEXT
	}
	context += " " + clarification
	if c.CanDelegate {
		context += " " + PLAN_MODE_DELEGATE_CONTEXT
	}
	verb := PLAN_MODE_APPROACH_RETURN_VERB
	if writable {
		verb = PLAN_MODE_APPROACH_WRITE_VERB
	}
	return strings.Join([]string{PLAN_MODE_HEADER, constraint + " " + PLAN_MODE_NO_MUTATION + " " + guard, info, PLAN_MODE_CONTEXT_HEADER + "\n" + context, PLAN_MODE_APPROACH_HEADER + "\n" + verb + " " + PLAN_MODE_APPROACH_BODY, PLAN_MODE_APPROVAL_HEADER + "\n" + approval}, "\n\n")
}
func BuildPlanModeReentryReminder(path string, exists bool) string {
	if !exists {
		return ""
	}
	return "Plan mode is active again. Review the existing plan at " + path + "; refine or replace it as needed. Stay read-only except that file, and use the current runtime approval gate before implementation."
}
func BuildPlanModeExitReminder(path string, exists bool) string {
	result := PLAN_MODE_EXITED_HEADER + "\n\n" + PLAN_MODE_EXITED_BODY
	if exists {
		result += " The plan file is located at " + path + " if you need to reference it."
	}
	return result
}
