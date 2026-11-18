package teams

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestFileMailBoxRoundTrip(t *testing.T) {
	dir := t.TempDir()
	mb := NewFileMailBox(dir)

	if err := mb.Send("alice", FileMailMessage{From: "bob", Text: "hi"}); err != nil {
		t.Fatalf("send: %v", err)
	}
	if err := mb.Send("alice", FileMailMessage{From: "carol", Text: "hello"}); err != nil {
		t.Fatalf("send: %v", err)
	}

	unread, err := mb.ReadUnread("alice")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(unread) != 2 {
		t.Fatalf("expected 2 unread, got %d", len(unread))
	}

	if err := mb.MarkAllRead("alice"); err != nil {
		t.Fatalf("mark read: %v", err)
	}
	unread2, _ := mb.ReadUnread("alice")
	if len(unread2) != 0 {
		t.Errorf("expected 0 unread after MarkAllRead, got %d", len(unread2))
	}
}

func TestFileMailBoxConcurrentSends(t *testing.T) {
	dir := t.TempDir()
	mb := NewFileMailBox(dir)

	const n = 20
	var wg sync.WaitGroup
	sendErrs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := mb.Send("dest", FileMailMessage{From: "sender", Text: "msg"}); err != nil {
				sendErrs <- err
			}
		}(i)
	}
	wg.Wait()
	close(sendErrs)
	for err := range sendErrs {
		t.Errorf("send failed: %v", err)
	}

	got, err := mb.ReadUnread("dest")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(got) != n {
		t.Errorf("expected %d messages after concurrent sends, got %d", n, len(got))
	}
}

func TestTeamManagerCRUD(t *testing.T) {
	useTempHome(t)
	tm := NewTeamManager(t.TempDir())

	team := createTestTeam(t, tm, "alpha")
	if team == nil {
		t.Fatal("CreateTeam returned nil")
	}
	if got := tm.GetTeam("alpha"); got != team {
		t.Errorf("Get should return same team instance")
	}
	if names := tm.ListTeams(); len(names) != 1 || names[0] != "alpha" {
		t.Errorf("ListTeams = %v, want [alpha]", names)
	}
	tm.DeleteTeam("alpha")
	if got := tm.GetTeam("alpha"); got != nil {
		t.Error("DeleteTeam did not remove team")
	}
}

func TestSendMessageToolRoutesToLead(t *testing.T) {
	useTempHome(t)
	tm := NewTeamManager(t.TempDir())
	team := createTestTeam(t, tm, "demo")
	if _, err := team.AddMember("alice"); err != nil {
		t.Fatal(err)
	}

	tool := &SendMessageTool{TeamMgr: tm, SenderName: "alice"}
	res := tool.Execute(context.Background(), map[string]any{
		"to":      LeadName,
		"content": "here is the README summary",
	})
	if res.IsError {
		t.Fatalf("SendMessage to lead errored: %s", res.Output)
	}
	if !strings.Contains(res.Output, LeadName) {
		t.Errorf("expected confirmation mentioning %q, got %q", LeadName, res.Output)
	}

	msgs, err := team.MailBox.ReadUnread(LeadName)
	if err != nil {
		t.Fatalf("read lead inbox: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message in lead inbox, got %d", len(msgs))
	}
	if msgs[0].From != "alice" || msgs[0].Text != "here is the README summary" {
		t.Errorf("unexpected message: %+v", msgs[0])
	}
}

func TestSendMessageToolUnknownSenderToLead(t *testing.T) {
	useTempHome(t)
	tm := NewTeamManager(t.TempDir())
	createTestTeam(t, tm, "demo")

	tool := &SendMessageTool{TeamMgr: tm, SenderName: "ghost"}
	res := tool.Execute(context.Background(), map[string]any{
		"to":      LeadName,
		"content": "anyone?",
	})
	if !res.IsError {
		t.Fatalf("expected error when sender has no team, got: %s", res.Output)
	}
}

var _ = filepath.Join
var _ = os.Getwd

func TestRemoveMemberRejectsActiveTeammate(t *testing.T) {
	mgr := newTestTeamManager(t)
	team := createTestTeam(t, mgr, "removal")
	member, err := team.AddMember("worker")
	if err != nil {
		t.Fatal(err)
	}
	member.Active = true
	err = team.RemoveMember("worker")
	if err == nil || err.Error() != "Stop teammate 'worker' before removing it" {
		t.Fatalf("expected stop-before-removing error, got %v", err)
	}
	if team.GetMember("worker") == nil {
		t.Fatal("active member was removed")
	}
}

func TestRemoveMemberDeletesAndRewritesTeamFile(t *testing.T) {
	mgr := newTestTeamManager(t)
	team := createTestTeam(t, mgr, "removal")
	if _, err := team.AddMember("alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := team.AddMember("bob"); err != nil {
		t.Fatal(err)
	}
	GetNameRegistry().Register("bob", "bob")
	if err := team.RemoveMember("bob"); err != nil {
		t.Fatal(err)
	}
	if team.GetMember("bob") != nil || team.HasMember("bob") {
		t.Fatal("bob still present after removal")
	}
	members := team.ListMembers()
	if len(members) != 1 || members[0].Name != "alice" {
		t.Fatalf("unexpected members after removal: %+v", members)
	}
	tf := ReadTeamFile(team.Cwd, team.Name)
	if tf == nil {
		t.Fatal("team file missing after removal")
	}
	if len(tf.Members) != 1 || tf.Members[0].Name != "alice" {
		t.Fatalf("unexpected team file members: %+v", tf.Members)
	}
	if GetNameRegistry().Resolve("bob") != "" {
		t.Error("removed member is still resolvable in the name registry")
	}
	if err := team.RemoveMember("ghost"); err != nil {
		t.Fatalf("removing a nonexistent member should be a no-op, got %v", err)
	}
}

func TestSpawnTeammateRejectsActiveMember(t *testing.T) {
	mgr := newTestTeamManager(t)
	team := createTestTeam(t, mgr, "busy")
	member, err := team.AddMember("worker")
	if err != nil {
		t.Fatal(err)
	}
	member.Active = true
	err = SpawnTeammate(context.Background(), TeammateSpawnConfig{Team: team, MemberName: "worker"})
	if err == nil || err.Error() != "Teammate 'worker' is already running" {
		t.Fatalf("expected already-running error, got %v", err)
	}
}

func TestSpawnTeammateReusesInactiveMember(t *testing.T) {
	mgr := newTestTeamManager(t)
	team := createTestTeam(t, mgr, "reuse")
	existing, err := team.AddMember("worker")
	if err != nil {
		t.Fatal(err)
	}
	existing.AgentID = "custom-id"
	existing.JoinedAt = 123

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err = SpawnTeammate(ctx, TeammateSpawnConfig{Team: team, MemberName: "worker", Task: "noop", Workdir: t.TempDir(), AgentType: "general-purpose", Model: "test-model", OriginToolCallID: "call-1", RunAgent: func(runCtx context.Context, task string, onEvent func(TeammateProgressEvent)) (string, error) {
		return "", runCtx.Err()
	}})
	if err != nil {
		t.Fatal(err)
	}

	member := team.GetMember("worker")
	if member == nil {
		t.Fatal("reused member was removed")
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		team.mu.Lock()
		settled := !member.Active && member.Done == nil
		team.mu.Unlock()
		if settled {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if member.AgentID != "custom-id" || member.JoinedAt != 123 {
		t.Errorf("identity not preserved on reuse: %+v", member)
	}
	if member.AgentType != "general-purpose" || member.Model != "test-model" {
		t.Errorf("spawn meta not applied: %+v", member)
	}
	if member.Active {
		t.Error("member should be inactive after the run")
	}
	if member.Progress == nil || member.Progress.GetStatus() != "stopped" {
		t.Errorf("expected stopped progress after the run, got %+v", member.Progress)
	}
	if member.Progress.OriginToolCallID != "call-1" {
		t.Errorf("origin tool call id not recorded: %+v", member.Progress)
	}
	if member.Checker != nil || member.Cancel != nil || member.Done != nil {
		t.Error("runtime fields should be cleared after the run")
	}
	msgs, err := team.MailBox.ReceiveMatching(LeadName, func(FileMailMessage) bool { return true })
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range msgs {
		if strings.Contains(m.Text, "[idle] worker (reason: stopped)") {
			found = true
		}
	}
	if !found {
		t.Errorf("missing terminal idle notification: %+v", msgs)
	}
}

func TestDeleteAllRemovesInMemoryAndResidualTeams(t *testing.T) {
	useTempHome(t)
	mgr := NewTeamManager(t.TempDir())
	if _, err := mgr.CreateTeam("alpha", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := mgr.CreateTeam("beta", "", ""); err != nil {
		t.Fatal(err)
	}
	residual := teamDir(mgr.cwd, "gamma")
	if err := os.MkdirAll(residual, 0700); err != nil {
		t.Fatal(err)
	}
	mgr.DeleteAll()
	if len(mgr.ListTeams()) != 0 {
		t.Fatalf("in-memory teams survived DeleteAll: %v", mgr.ListTeams())
	}
	if names := ListTeamNames(mgr.cwd); len(names) != 0 {
		t.Fatalf("residual team directories survived DeleteAll: %v", names)
	}
}
