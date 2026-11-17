package teams

import (
	"context"
	"fmt"

	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/plan_file"
)

// startInProcessMember mirrors Team.spawnTeammate: it reuses an existing
// inactive member (adding one when absent), rejects active members, and
// starts the teammate loop on the injected RunAgent while keeping the
// member's identity.
func startInProcessMember(ctx context.Context, cfg TeammateSpawnConfig) error {
	team, memberName := cfg.Team, cfg.MemberName
	member := team.GetMember(memberName)
	if member == nil {
		var err error
		if member, err = team.AddMember(memberName); err != nil {
			return err
		}
	}
	team.mu.Lock()
	if member.Active {
		team.mu.Unlock()
		return fmt.Errorf("Teammate '%s' is already running", memberName)
	}
	team.setMemberMeta(memberName, cfg.AgentType, cfg.Model, "")
	checkerReadOnly := cfg.Checker != nil && cfg.Checker.ReadOnly
	member.PlanApprovalRequired = !checkerReadOnly && cfg.PlanApprovalRequired
	member.PendingPlan = nil
	if cfg.Checker != nil && cfg.Checker.Teammate {
		cfg.Checker.RequiresLeaderPlanApproval = team.RequiresLeaderPlanApproval
	}
	if cfg.Checker != nil && cfg.Checker.Mode() == permissions.ModePlan && cfg.Checker.CurrentPlanPath() == "" {
		if _, err := plan_file.GetOrCreatePlanPath(cfg.Checker); err != nil {
			team.mu.Unlock()
			return err
		}
	}
	member.Active = true
	if cfg.Workdir != team.Cwd {
		member.WorktreePath = cfg.Workdir
	}
	team.persist()
	member.Checker = cfg.Checker
	member.Progress = NewTeammateProgress(memberName, team.Name, TeammateSpinnerVerb)
	if cfg.OriginToolCallID != "" {
		member.Progress.SetOriginToolCallID(cfg.OriginToolCallID)
	}
	memberCtx, cancel := context.WithCancel(ctx)
	member.Cancel = cancel
	member.Done = make(chan struct{})
	done := member.Done
	GetNameRegistry().Register(memberName, memberName)
	team.mu.Unlock()

	go func() {
		defer close(done)
		var runErr error
		defer func() {
			team.mu.Lock()
			member.Active = false
			member.PendingPlan = nil
			GetNameRegistry().Unregister(memberName)
			team.mu.Unlock()
			if cfg.Cleanup != nil {
				cfg.Cleanup()
			}
			team.releaseMemberTasks(memberName)
			reason := "stopped"
			if runErr != nil && memberCtx.Err() == nil {
				reason = "failed"
			}
			notification := CreateIdleNotification(memberName, reason)
			if reason == "failed" {
				notification.Text += ": " + runErr.Error()
			}
			_ = team.MailBox.Send(LeadName, notification)
			if member.Progress != nil {
				member.Progress.ClearActivity()
			}
			team.mu.Lock()
			member.Checker = nil
			member.Cancel = nil
			member.Done = nil
			team.persist()
			team.pruneTerminatedMembers()
			team.mu.Unlock()
		}()
		runErr = RunInProcessTeammate(memberCtx, team, member, cfg.RunAgent, cfg.Task)
	}()
	return nil
}
