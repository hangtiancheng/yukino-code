package teams

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestFileMailBoxSendAndRead(t *testing.T) {
	dir := t.TempDir()
	inboxDir := filepath.Join(dir, "test-team", "inboxes")
	mb := NewFileMailBox(inboxDir)

	err := mb.Send("agent-b", FileMailMessage{From: "agent-a", Text: "Hello from A"})
	if err != nil {
		t.Fatal("Send failed:", err)
	}

	data, err := os.ReadFile(filepath.Join(inboxDir, "agent-b.json"))
	if err != nil {
		t.Fatal("File not created:", err)
	}
	var msgs []FileMailMessage
	json.Unmarshal(data, &msgs)
	if len(msgs) != 1 || msgs[0].From != "agent-a" || msgs[0].Text != "Hello from A" || msgs[0].Read {
		t.Fatalf("Unexpected content: %+v", msgs)
	}
}

func TestFileMailBoxReadUnread(t *testing.T) {
	dir := t.TempDir()
	mb := NewFileMailBox(filepath.Join(dir, "inboxes"))

	mb.Send("bob", FileMailMessage{From: "alice", Text: "msg1"})
	mb.Send("bob", FileMailMessage{From: "carol", Text: "msg2"})

	unread, err := mb.ReadUnread("bob")
	if err != nil || len(unread) != 2 {
		t.Fatalf("Expected 2 unread, got %d, err=%v", len(unread), err)
	}
}

func TestFileMailBoxMarkAllRead(t *testing.T) {
	dir := t.TempDir()
	mb := NewFileMailBox(filepath.Join(dir, "inboxes"))

	mb.Send("bob", FileMailMessage{From: "alice", Text: "msg1"})
	mb.Send("bob", FileMailMessage{From: "carol", Text: "msg2"})

	mb.MarkAllRead("bob")

	unread, _ := mb.ReadUnread("bob")
	if len(unread) != 0 {
		t.Fatalf("Expected 0 unread after mark, got %d", len(unread))
	}

	data, _ := os.ReadFile(filepath.Join(dir, "inboxes", "bob.json"))
	var msgs []FileMailMessage
	json.Unmarshal(data, &msgs)
	if len(msgs) != 2 || !msgs[0].Read || !msgs[1].Read {
		t.Fatalf("Messages should be marked read: %+v", msgs)
	}
}

// TestFileMailBoxEmptyReceiveIsNoop pins the reference behavior that a
// receive matching nothing performs no write: the mailbox file must not be
// created or rewritten.
func TestFileMailBoxEmptyReceiveIsNoop(t *testing.T) {
	dir := t.TempDir()
	inboxDir := filepath.Join(dir, "test-team", "inboxes")
	mb := NewFileMailBox(inboxDir)

	messages, err := mb.ReceiveMatching("agent-b", func(FileMailMessage) bool { return true })
	if err != nil || len(messages) != 0 {
		t.Fatalf("empty receive = %v, %v", messages, err)
	}
	if _, err := os.Stat(filepath.Join(inboxDir, "agent-b.json")); !os.IsNotExist(err) {
		t.Fatalf("empty receive must not create the mailbox file, stat err = %v", err)
	}

	if err := mb.Send("agent-b", FileMailMessage{From: "agent-a", Text: "hi"}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(inboxDir, "agent-b.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := mb.ReceiveMatching("agent-b", func(FileMailMessage) bool { return false }); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(filepath.Join(inboxDir, "agent-b.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatalf("a receive matching nothing must not rewrite the file:\nbefore: %s\nafter: %s", before, after)
	}
}

func TestFileMailBoxNonexistentAgent(t *testing.T) {
	dir := t.TempDir()
	mb := NewFileMailBox(filepath.Join(dir, "inboxes"))

	unread, err := mb.ReadUnread("nobody")
	if err != nil || len(unread) != 0 {
		t.Fatalf("Expected empty for nonexistent, got %d, err=%v", len(unread), err)
	}
}

func TestTeamSendMessageIntegration(t *testing.T) {
	useTempHome(t)
	dir := t.TempDir()
	team := NewTeam(t.TempDir(), "test-team")
	team.MailBox = NewFileMailBox(filepath.Join(dir, "inboxes"))

	if _, err := team.AddMember("worker"); err != nil {
		t.Fatal(err)
	}
	if err := team.SendMessage("leader", "worker", "do task X"); err != nil {
		t.Fatal(err)
	}

	unread, _ := team.MailBox.ReadUnread("worker")
	if len(unread) != 1 || unread[0].From != "leader" || unread[0].Text != "do task X" {
		t.Fatalf("Unexpected: %+v", unread)
	}
}
