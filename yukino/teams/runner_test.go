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

package teams

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// TestMain points every teams test at a throwaway mailbox root so
// running the suite doesn't litter the repo with .yukino/teams/
// directories.
func TestMain(m *testing.M) {
	tmp, err := os.MkdirTemp("", "yukino-teams-test-")
	if err != nil {
		panic(err)
	}
	// The team directory is <home>/.yukino/teams; redirect the entire home
	// directory to a temp dir so all package tests land in the sandbox.
	// Windows reads USERPROFILE; other platforms read HOME.
	_ = os.Setenv("HOME", tmp)
	_ = os.Setenv("USERPROFILE", tmp)
	code := m.Run()
	_ = os.RemoveAll(tmp)
	os.Exit(code)
}

func TestIsShutdownRequest(t *testing.T) {
	cases := []struct {
		text string
		want bool
	}{
		{"[shutdown] please stop", true},
		{"  [shutdown]  ", true},
		{"shutdown", false},
		{"hello [shutdown] there", false},
		{"", false},
	}
	for _, c := range cases {
		if got := IsShutdownRequest(FileMailMessage{Text: c.text}); got != c.want {
			t.Errorf("IsShutdownRequest(%q) = %v, want %v", c.text, got, c.want)
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
	// TS joins the messages with "\n\n" — no trailing separator.
	if strings.HasSuffix(got, "\n\n") {
		t.Errorf("prompt must not carry a trailing separator: %q", got)
	}
}

// newTmpManager builds a TeamManager rooted at a fresh temp dir (baseDir and
// workDir coincide in tests).
func newTmpManager(t *testing.T) *TeamManager {
	t.Helper()
	dir := t.TempDir()
	return NewTeamManager(dir, dir)
}

// newWaitTestTeam builds a team with one active member for the idle-poll
// tests.
func newWaitTestTeam(t *testing.T) (*Team, *Member) {
	t.Helper()
	dir := t.TempDir()
	team := NewTeam(dir, dir, "x")
	member := team.AddMember("alice")
	team.mu.Lock()
	member.Active = true
	team.mu.Unlock()
	return team, member
}

func TestWaitForNextPromptOrShutdownShutdown(t *testing.T) {
	team, member := newWaitTestTeam(t)

	// Drop a shutdown message and verify the wait returns immediately
	// with the shutdown message.
	if err := team.MailBox.Send("alice", FileMailMessage{From: LeadName, Text: "[shutdown] done"}); err != nil {
		t.Fatalf("send: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	prompt, shutdown := team.waitForNextPromptOrShutdown(ctx, member)
	if shutdown == nil {
		t.Errorf("expected a shutdown message, got nil")
	}
	if prompt != "" {
		t.Errorf("expected empty prompt on shutdown, got %q", prompt)
	}
}

func TestWaitForNextPromptOrShutdownMessage(t *testing.T) {
	team, member := newWaitTestTeam(t)

	if err := team.MailBox.Send("alice", FileMailMessage{From: LeadName, Text: "do the thing"}); err != nil {
		t.Fatalf("send: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	prompt, shutdown := team.waitForNextPromptOrShutdown(ctx, member)
	if shutdown != nil {
		t.Error("unexpected shutdown message on regular message")
	}
	if !strings.Contains(prompt, "do the thing") {
		t.Errorf("prompt missing message body: %q", prompt)
	}

	// Inbox should have been drained.
	leftover := team.MailBox.ReadUnread("alice")
	if len(leftover) != 0 {
		t.Errorf("expected inbox drained, %d unread remain", len(leftover))
	}
}

// A cancelled ctx (or a deactivated member) yields the synthetic shutdown
// request whose acknowledgment mirrors the TS stop-during-idle path.
func TestWaitForNextPromptOrShutdownCancel(t *testing.T) {
	team, member := newWaitTestTeam(t)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, shutdown := team.waitForNextPromptOrShutdown(ctx, member)
	if shutdown == nil {
		t.Fatal("expected the synthetic shutdown request on cancel")
	}
	if !strings.Contains(shutdown.Text, "member deactivated") {
		t.Errorf("synthetic shutdown should carry the deactivation reason: %q", shutdown.Text)
	}
}

func TestDrainLeadMailbox(t *testing.T) {
	// Build teams with explicit mailbox dirs so we don't pollute the
	// repo root via teamsBaseDir().
	dir := t.TempDir()
	mgr := NewTeamManager(dir, dir)
	t1 := &Team{Name: "alpha", Mode: TeamModeInProcess, members: map[string]*Member{}, MailBox: NewFileMailBox(t.TempDir())}
	t2 := &Team{Name: "beta", Mode: TeamModeInProcess, members: map[string]*Member{}, MailBox: NewFileMailBox(t.TempDir())}
	mgr.CreateTeamWith(t1)
	mgr.CreateTeamWith(t2)

	_ = t1.MailBox.Send(LeadName, FileMailMessage{From: "ann", Text: "[idle] ann (reason: available)"})
	_ = t2.MailBox.Send(LeadName, FileMailMessage{From: "bob", Text: "[idle] bob (reason: failed)"})

	notes := DrainLeadMailbox(mgr)
	if len(notes) != 2 {
		t.Fatalf("expected 2 notes, got %d", len(notes))
	}
	joined := strings.Join(notes, "\n")
	// TS (index.ts drainLeads) wraps lead notifications in <task-notification>;
	// pin the tag so the coordinator prompt and the delivery format agree.
	if !strings.Contains(joined, "<task-notification team=\"alpha\"") || !strings.Contains(joined, "<task-notification team=\"beta\"") {
		t.Errorf("notes missing <task-notification> team labels: %s", joined)
	}
	if !strings.Contains(joined, "</task-notification>") {
		t.Errorf("notes missing closing tag: %s", joined)
	}
	if !strings.Contains(joined, "ann") || !strings.Contains(joined, "bob") {
		t.Errorf("notes missing senders: %s", joined)
	}

	// Second drain should yield nothing because messages are now read.
	if again := DrainLeadMailbox(mgr); len(again) != 0 {
		t.Errorf("expected empty drain after mark-read, got %d", len(again))
	}
}

func TestDrainLeadMailboxNilSafe(t *testing.T) {
	if got := DrainLeadMailbox(nil); got != nil {
		t.Errorf("nil manager should yield nil, got %v", got)
	}
}

// waitForDone blocks until the member's loop goroutine exits (or the timeout
// fires).
func waitForDone(t *testing.T, member *Member) {
	t.Helper()
	if member.Done == nil {
		return
	}
	select {
	case <-member.Done:
	case <-time.After(3 * time.Second):
		t.Fatal("teammate loop did not exit in time")
	}
}

// A teammate whose turn succeeds sends the idle notification and keeps
// polling; a shutdown request then ends the loop with the acknowledgment
// (TS spawnInProcess flow).
func TestSpawnTeammateIdleThenShutdown(t *testing.T) {
	dir := t.TempDir()
	team := NewTeam(dir, dir, "squad")

	turns := 0
	run := func(ctx context.Context, task string, onEvent AgentEventCallback) (string, error) {
		turns++
		return "report", nil
	}

	ctx := context.Background()
	team.SpawnTeammate(ctx, "scout", "first task", run, nil, "")
	member := team.GetMember("scout")
	if member == nil {
		t.Fatal("member not registered")
	}

	// Wait for the first idle notification.
	deadline := time.Now().Add(3 * time.Second)
	for {
		msgs := team.MailBox.ReadUnread(LeadName)
		if len(msgs) > 0 {
			if !strings.Contains(msgs[0].Text, "[idle] scout (reason: available)") {
				t.Fatalf("unexpected first notification: %q", msgs[0].Text)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no idle notification arrived")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if turns != 1 {
		t.Errorf("expected exactly one turn before idle, got %d", turns)
	}

	// Send a shutdown request; the loop must acknowledge it and exit.
	req := NewShutdownRequest(LeadName, "wrapping up")
	if err := team.MailBox.Send("scout", req); err != nil {
		t.Fatalf("send shutdown: %v", err)
	}
	waitForDone(t, member)

	msgs := team.MailBox.ReadUnread(LeadName)
	var acked bool
	for _, m := range msgs {
		if m.Type == MsgShutdownResponse && m.RequestID == req.RequestID && m.Approved() {
			acked = true
		}
	}
	if !acked {
		t.Errorf("expected an approved shutdown_response echoing the request id, got %+v", msgs)
	}
	if team.IsMemberActive("scout") {
		t.Error("member should be inactive after shutdown")
	}
}

// A stopped teammate must tell the lead it stopped (TS: spawnInProcess sends
// `[idle] name (reason: stopped)` when the abort signal fires); returning the
// ctx error silently would leave the lead waiting for a result that never
// comes.
func TestSpawnTeammateStoppedNotification(t *testing.T) {
	dir := t.TempDir()
	team := NewTeam(dir, dir, "squad")

	run := func(ctx context.Context, task string, onEvent AgentEventCallback) (string, error) {
		<-ctx.Done()
		return "", ctx.Err()
	}

	ctx, cancel := context.WithCancel(context.Background())
	team.SpawnTeammate(ctx, "scout", "do the thing", run, nil, "")
	member := team.GetMember("scout")
	if member == nil {
		t.Fatal("member not registered")
	}

	cancel()
	waitForDone(t, member)

	msgs := team.MailBox.ReadUnread(LeadName)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 stopped notification, got %d", len(msgs))
	}
	if want := "[idle] scout (reason: stopped)"; msgs[0].Text != want {
		t.Errorf("notification = %q, want %q", msgs[0].Text, want)
	}
	if msgs[0].From != "scout" {
		t.Errorf("From = %q, want scout", msgs[0].From)
	}
}

// A failing turn reports the failed idle reason (TS catch branch).
func TestSpawnTeammateFailedNotification(t *testing.T) {
	dir := t.TempDir()
	team := NewTeam(dir, dir, "squad")

	run := func(ctx context.Context, task string, onEvent AgentEventCallback) (string, error) {
		return "", context.Canceled
	}

	// Use a non-cancelled ctx so the error is classified "failed", not "stopped".
	team.SpawnTeammate(context.Background(), "scout", "doomed task", run, nil, "")
	member := team.GetMember("scout")
	waitForDone(t, member)

	msgs := team.MailBox.ReadUnread(LeadName)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 failed notification, got %d", len(msgs))
	}
	if want := "[idle] scout (reason: failed)"; msgs[0].Text != want {
		t.Errorf("notification = %q, want %q", msgs[0].Text, want)
	}
}

// Every turn's user message must be wrapped with the teammate identity and an
// <assignment> boundary (TS: runAgent(buildTeammatePrompt(...)) each turn).
func TestBuildTeammatePrompt(t *testing.T) {
	got := BuildTeammatePrompt("squad", "scout", "fix the bug")
	for _, want := range []string{
		`You are "scout", a persistent teammate in team "squad".`,
		"<assignment>\nfix the bug\n</assignment>",
		"SendMessage to communicate findings or blockers to the lead",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("prompt missing %q:\n%s", want, got)
		}
	}
}

// StopMember must wait for the loop goroutine to fully exit (TS: stopOne
// awaits member.done) so callers like DeleteTeam can safely wipe the team
// directory right after.
func TestStopMemberWaitsForDone(t *testing.T) {
	dir := t.TempDir()
	team := NewTeam(dir, dir, "t")
	member := team.AddMember("x")
	done := make(chan struct{})
	team.mu.Lock()
	member.Done = done
	member.Active = true
	team.mu.Unlock()

	stopped := make(chan struct{})
	go func() {
		team.StopMember("x")
		close(stopped)
	}()

	select {
	case <-stopped:
		t.Fatal("StopMember returned before the loop goroutine exited")
	case <-time.After(50 * time.Millisecond):
	}
	close(done)
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("StopMember did not return after Done closed")
	}
	if team.IsMemberActive("x") {
		t.Error("member should be inactive after StopMember")
	}
}
