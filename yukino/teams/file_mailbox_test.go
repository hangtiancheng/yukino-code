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
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileMailBoxSendAndRead(t *testing.T) {
	dir := t.TempDir()
	inboxDir := filepath.Join(dir, "test-team", "inboxes")
	mb := NewFileMailBox(inboxDir)

	// Send message
	err := mb.Send("agent-b", FileMailMessage{From: "agent-a", Text: "Hello from A"})
	if err != nil {
		t.Fatal("Send failed:", err)
	}

	// Verify file
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

	unread := mb.ReadUnread("bob")
	if len(unread) != 2 {
		t.Fatalf("Expected 2 unread, got %d", len(unread))
	}
}

func TestFileMailBoxMarkAllRead(t *testing.T) {
	dir := t.TempDir()
	mb := NewFileMailBox(filepath.Join(dir, "inboxes"))

	mb.Send("bob", FileMailMessage{From: "alice", Text: "msg1"})
	mb.Send("bob", FileMailMessage{From: "carol", Text: "msg2"})

	mb.MarkAllRead("bob")

	unread := mb.ReadUnread("bob")
	if len(unread) != 0 {
		t.Fatalf("Expected 0 unread after mark, got %d", len(unread))
	}

	// Messages still in file
	data, _ := os.ReadFile(filepath.Join(dir, "inboxes", "bob.json"))
	var msgs []FileMailMessage
	json.Unmarshal(data, &msgs)
	if len(msgs) != 2 || !msgs[0].Read || !msgs[1].Read {
		t.Fatalf("Messages should be marked read: %+v", msgs)
	}
}

func TestFileMailBoxNonexistentAgent(t *testing.T) {
	dir := t.TempDir()
	mb := NewFileMailBox(filepath.Join(dir, "inboxes"))

	unread := mb.ReadUnread("nobody")
	if len(unread) != 0 {
		t.Fatalf("Expected empty for nonexistent, got %d", len(unread))
	}
}

func TestTeamSendMessageIntegration(t *testing.T) {
	dir := t.TempDir()
	team := NewTeam(dir, dir, "test-team")
	team.MailBox = NewFileMailBox(filepath.Join(dir, "inboxes"))
	team.AddMember("worker")

	if err := team.SendMessage("leader", "worker", "do task X"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	unread := team.MailBox.ReadUnread("worker")
	if len(unread) != 1 || unread[0].From != "leader" || unread[0].Text != "do task X" {
		t.Fatalf("Unexpected: %+v", unread)
	}

	// TS Team.sendMessage throws for an unknown recipient.
	if err := team.SendMessage("leader", "ghost", "hi"); err == nil {
		t.Fatal("expected an error for an unknown recipient")
	}
}

// ReceiveSync returns the unread batch and marks the whole mailbox read in
// one pass (TS FileMailbox.receiveSync).
func TestFileMailBoxReceiveSync(t *testing.T) {
	dir := t.TempDir()
	mb := NewFileMailBox(filepath.Join(dir, "inboxes"))

	_ = mb.Send("bob", FileMailMessage{From: "alice", Text: "msg1"})
	_ = mb.Send("bob", FileMailMessage{From: "carol", Text: "msg2"})

	got, err := mb.ReceiveSync("bob")
	if err != nil || len(got) != 2 {
		t.Fatalf("expected 2 messages, got %d, err=%v", len(got), err)
	}
	if !strings.Contains(got[0].Text, "msg1") || !strings.Contains(got[1].Text, "msg2") {
		t.Fatalf("unexpected batch: %+v", got)
	}

	// Second receive: everything is already read.
	again, _ := mb.ReceiveSync("bob")
	if len(again) != 0 {
		t.Fatalf("expected empty second receive, got %d", len(again))
	}
	if n := mb.UnreadCount("bob"); n != 0 {
		t.Fatalf("expected 0 unread, got %d", n)
	}
}

// TS receiveSync only calls writeAll when unread messages exist: an empty
// mailbox must not gain a file (the old unconditional write even produced a
// "null" document for a never-used mailbox).
func TestFileMailBoxReceiveSyncDoesNotWriteWhenEmpty(t *testing.T) {
	dir := t.TempDir()
	inbox := filepath.Join(dir, "inboxes")
	mb := NewFileMailBox(inbox)

	if _, err := mb.ReceiveSync("nobody"); err != nil {
		t.Fatalf("ReceiveSync: %v", err)
	}
	if _, err := os.Stat(filepath.Join(inbox, "nobody.json")); !os.IsNotExist(err) {
		t.Fatalf("an empty receive must not create the mailbox file (stat err=%v)", err)
	}
	if err := mb.MarkAllRead("nobody"); err != nil {
		t.Fatalf("MarkAllRead: %v", err)
	}
	if _, err := os.Stat(filepath.Join(inbox, "nobody.json")); !os.IsNotExist(err) {
		t.Fatalf("a no-change MarkAllRead must not create the mailbox file (stat err=%v)", err)
	}
}

// A corrupted mailbox degrades to empty (TS readAll's catch) and the next
// send replaces it instead of failing (TS send appends to the empty readAll
// result).
func TestFileMailBoxCorruptFileDegradesToEmpty(t *testing.T) {
	dir := t.TempDir()
	inbox := filepath.Join(dir, "inboxes")
	mb := NewFileMailBox(inbox)
	path := filepath.Join(inbox, "bob.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}

	if got := mb.ReadUnread("bob"); len(got) != 0 {
		t.Fatalf("corrupt mailbox must read as empty, got %+v", got)
	}
	if err := mb.Send("bob", FileMailMessage{From: "alice", Text: "fresh"}); err != nil {
		t.Fatalf("send over a corrupt mailbox must succeed: %v", err)
	}
	var msgs []FileMailMessage
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &msgs); err != nil {
		t.Fatalf("mailbox must be a valid array after the overwrite: %v (%s)", err, data)
	}
	if len(msgs) != 1 || msgs[0].Text != "fresh" {
		t.Fatalf("unexpected mailbox content: %+v", msgs)
	}
}

// Per-item decoding mirrors the TS FileMailMessageSchema safeParse: items
// missing a required string key (from/text/timestamp) or carrying a wrong
// type are dropped silently while valid items survive.
func TestFileMailBoxSkipsInvalidItems(t *testing.T) {
	dir := t.TempDir()
	inbox := filepath.Join(dir, "inboxes")
	mb := NewFileMailBox(inbox)
	doc := `[
  {"from": "alice", "text": "ok", "timestamp": "2026-01-01T00:00:00.000Z", "read": false},
  {"text": "no from", "timestamp": "2026-01-01T00:00:01.000Z"},
  {"from": "bob", "text": 5, "timestamp": "2026-01-01T00:00:02.000Z"},
  {"from": "carol", "text": "no timestamp"},
  {"from": "dave", "text": "bad read", "timestamp": "2026-01-01T00:00:03.000Z", "read": "yes"},
  {"from": "erin", "text": "structured", "timestamp": "2026-01-01T00:00:04.000Z", "type": "shutdown_request", "requestId": "r1", "approve": true}
]`
	if err := os.WriteFile(filepath.Join(inbox, "bob.json"), []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}

	got := mb.ReadUnread("bob")
	if len(got) != 2 {
		t.Fatalf("expected the 2 valid items, got %+v", got)
	}
	if got[0].From != "alice" || got[0].Read {
		t.Errorf("first item wrong: %+v", got[0])
	}
	if got[1].From != "erin" || got[1].Type != "shutdown_request" || got[1].RequestID != "r1" || got[1].Approve == nil || !*got[1].Approve {
		t.Errorf("structured item lost fields: %+v", got[1])
	}
}

// Mailbox text persists like TS JSON.stringify: `<`/`>`/`&` stay literal.
func TestFileMailBoxNoHTMLEscaping(t *testing.T) {
	dir := t.TempDir()
	inbox := filepath.Join(dir, "inboxes")
	mb := NewFileMailBox(inbox)
	if err := mb.Send("bob", FileMailMessage{From: "alice", Text: "<task> a && b </task>"}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(inbox, "bob.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"<task> a && b </task>"`) {
		t.Fatalf("text must stay unescaped: %s", data)
	}
}
