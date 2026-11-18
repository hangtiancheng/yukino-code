package teams

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "yukino-teams-test-")
	if err != nil {
		panic(err)
	}
	_ = os.Setenv("HOME", tmp)
	_ = os.Setenv("USERPROFILE", tmp)
	code := m.Run()
	_ = os.RemoveAll(tmp)
	os.Exit(code)
}

func TestIsShutdownRequest(t *testing.T) {
	valid := NewShutdownRequest(LeadName, "stop")
	if !IsShutdownRequest(valid) {
		t.Fatal("structured request rejected")
	}
	for _, m := range []FileMailMessage{{Text: "[shutdown] stop"}, {From: "worker", Type: MsgShutdownRequest, RequestID: "req"}, {From: LeadName, Type: MsgShutdownRequest}} {
		if IsShutdownRequest(m) {
			t.Fatalf("accepted invalid shutdown: %+v", m)
		}
	}
}

func TestCreateIdleNotification(t *testing.T) {
	msg := CreateIdleNotification("alice", "available")
	if msg.From != "alice" {
		t.Errorf("From = %q, want alice", msg.From)
	}
	if !strings.Contains(msg.Text, "[idle]") {
		t.Errorf("Text missing [idle] marker: %q", msg.Text)
	}
	if !strings.Contains(msg.Text, "alice") {
		t.Errorf("Text missing member name: %q", msg.Text)
	}
	if !strings.Contains(msg.Text, "available") {
		t.Errorf("Text missing reason: %q", msg.Text)
	}
	if msg.Timestamp == "" {
		t.Error("Timestamp should be set")
	}
}

func TestFormatInboundAsPromptEmpty(t *testing.T) {
	if got := formatInboundAsPrompt(nil); got != "" {
		t.Errorf("empty input should yield empty prompt, got %q", got)
	}
}

func TestFormatInboundAsPromptMultiple(t *testing.T) {
	msgs := []FileMailMessage{
		{From: "lead", Text: "go review file X"},
		{From: "bob", Text: "I'll handle the tests"},
	}
	got := formatInboundAsPrompt(msgs)
	if !strings.Contains(got, "From lead: go review file X") {
		t.Errorf("missing first message: %q", got)
	}
	if !strings.Contains(got, "From bob: I'll handle the tests") {
		t.Errorf("missing second message: %q", got)
	}
	if !strings.Contains(got, "new messages from your team") {
		t.Errorf("missing header: %q", got)
	}
}

func TestWaitForNextPromptOrShutdownShutdown(t *testing.T) {
	dir := t.TempDir()
	team := &Team{
		Name:    "x",
		Members: map[string]*Member{},
		MailBox: NewFileMailBox(dir),
	}

	if err := team.MailBox.Send("alice", NewShutdownRequest(LeadName, "done")); err != nil {
		t.Fatalf("send: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	prompt, shutdown, err := waitForNextPromptOrShutdown(ctx, team, "alice")
	if err != nil {
		t.Fatalf("waitForNextPromptOrShutdown: %v", err)
	}
	if shutdown == nil {
		t.Errorf("expected a shutdown message, got nil")
	}
	if prompt != "" {
		t.Errorf("expected empty prompt on shutdown, got %q", prompt)
	}
}

func TestWaitForNextPromptOrShutdownMessage(t *testing.T) {
	dir := t.TempDir()
	team := &Team{
		Name:    "x",
		Members: map[string]*Member{},
		MailBox: NewFileMailBox(dir),
	}

	if err := team.MailBox.Send("alice", FileMailMessage{From: LeadName, Text: "do the thing"}); err != nil {
		t.Fatalf("send: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	prompt, shutdown, err := waitForNextPromptOrShutdown(ctx, team, "alice")
	if err != nil {
		t.Fatalf("waitForNextPromptOrShutdown: %v", err)
	}
	if shutdown != nil {
		t.Error("unexpected shutdown message on regular message")
	}
	if !strings.Contains(prompt, "do the thing") {
		t.Errorf("prompt missing message body: %q", prompt)
	}

	leftover, _ := team.MailBox.ReadUnread("alice")
	if len(leftover) != 0 {
		t.Errorf("expected inbox drained, %d unread remain", len(leftover))
	}
}

func TestWaitForNextPromptOrShutdownCancel(t *testing.T) {
	dir := t.TempDir()
	team := &Team{
		Name:    "x",
		Members: map[string]*Member{},
		MailBox: NewFileMailBox(dir),
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	// A member deactivated while idle surfaces a synthetic leader shutdown
	// request (reference parity) rather than an error, so the run loop can send
	// a shutdown acknowledgment before exiting.
	_, shutdown, err := waitForNextPromptOrShutdown(ctx, team, "alice")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if shutdown == nil || shutdown.Type != MsgShutdownRequest || shutdown.From != LeadName {
		t.Fatalf("expected a synthetic leader shutdown request, got %#v", shutdown)
	}
	if shutdown.RequestID == "" {
		t.Fatal("synthetic shutdown request must carry a request id for the ack")
	}
}

func TestDrainLeadMailbox(t *testing.T) {
	mgr := NewTeamManager(t.TempDir())
	t1 := &Team{Name: "alpha", Members: map[string]*Member{}, MailBox: NewFileMailBox(t.TempDir())}
	t2 := &Team{Name: "beta", Members: map[string]*Member{}, MailBox: NewFileMailBox(t.TempDir())}
	createTeamWith(mgr, t1)
	createTeamWith(mgr, t2)

	_ = t1.MailBox.Send(LeadName, FileMailMessage{From: "ann", Text: "[idle] ann (reason: available)"})
	_ = t2.MailBox.Send(LeadName, FileMailMessage{From: "bob", Text: "[idle] bob (reason: failed)"})

	notes := DrainLeadMailbox(mgr)
	if len(notes) != 2 {
		t.Fatalf("expected 2 notes, got %d", len(notes))
	}
	joined := strings.Join(notes, "\n")
	if !strings.Contains(joined, "team=\"alpha\"") || !strings.Contains(joined, "team=\"beta\"") {
		t.Errorf("notes missing team labels: %s", joined)
	}
	if !strings.Contains(joined, "ann") || !strings.Contains(joined, "bob") {
		t.Errorf("notes missing senders: %s", joined)
	}

	if again := DrainLeadMailbox(mgr); len(again) != 0 {
		t.Errorf("expected empty drain after mark-read, got %d", len(again))
	}
}

func TestDrainLeadMailboxNilSafe(t *testing.T) {
	if got := DrainLeadMailbox(nil); got != nil {
		t.Errorf("nil manager should yield nil, got %v", got)
	}
}

func TestSpawnTeammateValidation(t *testing.T) {
	useTempHome(t)
	ctx := context.Background()

	if err := SpawnTeammate(ctx, TeammateSpawnConfig{MemberName: "x"}); err == nil {
		t.Error("expected error when Team is nil")
	}

	team := NewTeam(t.TempDir(), "t")
	if err := SpawnTeammate(ctx, TeammateSpawnConfig{Team: team}); err == nil {
		t.Error("expected error when MemberName is empty")
	}

}

func TestHasLeaderNotifications(t *testing.T) {
	mgr := NewTeamManager(t.TempDir())
	if HasLeaderNotifications(mgr) {
		t.Fatal("expected no notifications for an empty manager")
	}
	if HasLeaderNotifications(nil) {
		t.Fatal("nil manager must report no notifications")
	}
	team := &Team{Name: "alpha", Members: map[string]*Member{}, MailBox: NewFileMailBox(t.TempDir())}
	createTeamWith(mgr, team)
	if HasLeaderNotifications(mgr) {
		t.Fatal("expected no notifications before any message")
	}
	if err := team.MailBox.Send(LeadName, NewFileMailMessage("member", "hello leader")); err != nil {
		t.Fatal(err)
	}
	if !HasLeaderNotifications(mgr) {
		t.Fatal("expected a leader notification after Send")
	}
	if notes := DrainLeadMailbox(mgr); len(notes) == 0 {
		t.Fatal("expected DrainLeadMailbox to return the message")
	}
	if HasLeaderNotifications(mgr) {
		t.Fatal("expected no notifications after draining")
	}
}
