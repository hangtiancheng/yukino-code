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
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	// lockAcquireTimeout is the total time limit for waiting on the file lock.
	// On timeout, return an error for the caller to handle — never silently
	// discard the message.
	lockAcquireTimeout = 5 * time.Second
	// staleLockAge: a lock file older than this duration is considered
	// abandoned by a crashed holder and may be forcibly taken over.
	staleLockAge = 10 * time.Second
	// maxLockBackoff caps the backoff to prevent unbounded growth under high
	// concurrency.
	maxLockBackoff = 80 * time.Millisecond
)

type FileMailBox struct {
	baseDir string
	// Intra-process concurrency is serialized with an in-memory lock; the file
	// lock only isolates teammates in separate processes. This avoids a round
	// of filesystem contention and prevents same-process goroutines from
	// exhausting each other's retry budget.
	mu sync.Mutex
}

type FileMailMessage struct {
	From      string `json:"from"`
	Text      string `json:"text"`
	Timestamp string `json:"timestamp"`
	Color     string `json:"color,omitempty"`

	// Three fields for structured messages; left empty for plain text messages.
	// Type: see the Msg* constants in protocol.go; RequestID: allows responses
	// to be matched to requests; Approve uses a pointer to distinguish "no
	// response" from "explicitly rejected".
	Type      string `json:"type,omitempty"`
	RequestID string `json:"requestId,omitempty"`
	Approve   *bool  `json:"approve,omitempty"`
	// Read sits last because TS assigns msg.read = false after spreading the
	// structured fields, so it is the final key on the wire.
	Read bool `json:"read"`
}

// NewFileMailMessage constructs a plain text message with an ISO-8601
// millisecond timestamp (TS: new Date().toISOString()).
func NewFileMailMessage(from, text string) FileMailMessage {
	return FileMailMessage{
		From:      from,
		Text:      text,
		Timestamp: isoTimestamp(time.Now()),
	}
}

// isoTimestamp renders t like JS Date.toISOString(): UTC, always three
// fractional digits, "Z" suffix.
func isoTimestamp(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

func NewFileMailBox(baseDir string) *FileMailBox {
	os.MkdirAll(baseDir, 0755)
	return &FileMailBox{baseDir: baseDir}
}

func (mb *FileMailBox) inboxPath(agentID string) string {
	return filepath.Join(mb.baseDir, agentID+".json")
}

func (mb *FileMailBox) lockPath(agentID string) string {
	return filepath.Join(mb.baseDir, agentID+".json.lock")
}

func (mb *FileMailBox) Send(recipient string, msg FileMailMessage) error {
	return mb.withLock(recipient, func(messages []FileMailMessage) []FileMailMessage {
		msg.Read = false
		if msg.Timestamp == "" {
			msg.Timestamp = isoTimestamp(time.Now())
		}
		return append(messages, msg)
	})
}

// ReadUnread returns the unread messages without consuming them. The TS
// readAll-based helpers never fail — a corrupted or unreadable mailbox
// degrades to empty (with a log) — so the Go port returns no error either.
func (mb *FileMailBox) ReadUnread(agentID string) []FileMailMessage {
	var unread []FileMailMessage
	for _, m := range mb.readInbox(agentID) {
		if !m.Read {
			unread = append(unread, m)
		}
	}
	return unread
}

// ReceiveSync reads the unread messages and marks the whole mailbox read in
// one locked pass (TS: FileMailbox.receiveSync). The file is rewritten only
// when unread messages existed (TS writes only in that case).
func (mb *FileMailBox) ReceiveSync(agentID string) ([]FileMailMessage, error) {
	var unread []FileMailMessage
	err := mb.withLock(agentID, func(messages []FileMailMessage) []FileMailMessage {
		for _, m := range messages {
			if !m.Read {
				unread = append(unread, m)
			}
		}
		if len(unread) == 0 {
			return nil // no write (TS: writeAll only when unread.length > 0)
		}
		for i := range messages {
			messages[i].Read = true
		}
		return messages
	})
	if err != nil {
		return nil, err
	}
	return unread, nil
}

// UnreadCount counts unread messages without consuming them (TS:
// FileMailbox.unreadCount).
func (mb *FileMailBox) UnreadCount(agentID string) int {
	count := 0
	for _, m := range mb.readInbox(agentID) {
		if !m.Read {
			count++
		}
	}
	return count
}

// MarkAllRead marks every message read; the file is rewritten only when
// something changed (TS: markAllRead's `changed` guard).
func (mb *FileMailBox) MarkAllRead(agentID string) error {
	return mb.withLock(agentID, func(messages []FileMailMessage) []FileMailMessage {
		changed := false
		for i := range messages {
			if !messages[i].Read {
				messages[i].Read = true
				changed = true
			}
		}
		if !changed {
			return nil
		}
		return messages
	})
}

// MarkRead marks the single message with the given timestamp as read, leaving
// other unread messages for the next turn. The file is rewritten only when a
// message actually changed.
func (mb *FileMailBox) MarkRead(agentID, timestamp string) error {
	return mb.withLock(agentID, func(messages []FileMailMessage) []FileMailMessage {
		changed := false
		for i := range messages {
			if messages[i].Timestamp == timestamp && !messages[i].Read {
				messages[i].Read = true
				changed = true
			}
		}
		if !changed {
			return nil
		}
		return messages
	})
}

// withLock acquires the file lock, reads the inbox, and applies the mutation.
// A nil slice returned by fn skips the write — the TS callers write only when
// they have a change.
func (mb *FileMailBox) withLock(agentID string, fn func([]FileMailMessage) []FileMailMessage) error {
	mb.mu.Lock()
	defer mb.mu.Unlock()

	lockFile := mb.lockPath(agentID)

	// Acquire the file lock: backoff grows exponentially with jitter to avoid
	// multiple processes waking at the same instant and colliding repeatedly.
	// If the lock cannot be acquired within the total time limit, return an
	// error so the caller knows the message was not written.
	var lockFd *os.File
	var err error
	deadline := time.Now().Add(lockAcquireTimeout)
	backoff := 5 * time.Millisecond
	for {
		lockFd, err = os.OpenFile(lockFile, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
		if err == nil {
			break
		}
		// TS acquireLock logs EVERY failed open — including EEXIST contention —
		// before deciding whether the error is a held lock or a real failure.
		log.Error("teams operation failed", "err", err)
		if !os.IsExist(err) {
			return err
		}
		// Lock is held by another process; check if it is stale enough to take
		// over. Only a successful removal retries immediately — TS falls
		// through to the deadline/backoff checks when the unlink fails, so a
		// lock we cannot delete cannot spin this loop hot.
		if info, statErr := os.Stat(lockFile); statErr == nil {
			if time.Since(info.ModTime()) > staleLockAge {
				if rmErr := os.Remove(lockFile); rmErr == nil {
					continue
				} else {
					log.Error("teams operation failed", "err", rmErr)
				}
			}
		} else {
			// TS: a stat failure (the file vanished between open and stat) is
			// logged and falls through to the deadline/backoff checks.
			log.Error("teams operation failed", "err", statErr)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("mailbox lock %s: timed out after %dms, message not written", lockFile, lockAcquireTimeout.Milliseconds())
		}
		time.Sleep(backoff + time.Duration(rand.Int63n(int64(backoff))))
		if backoff < maxLockBackoff {
			backoff *= 2
		}
	}
	lockFd.Close()
	defer func() {
		// TS releaseLock logs an unlink failure even when the file is already
		// gone ("best-effort — file may already be gone").
		if err := os.Remove(lockFile); err != nil {
			log.Error("teams operation failed", "err", err)
		}
	}()

	// Re-read inbox after acquiring lock
	messages := mb.readInbox(agentID)

	// Apply mutation; a nil result skips the write (see fn contract).
	updated := fn(messages)
	if updated == nil {
		return nil
	}
	return mb.writeInbox(agentID, updated)
}

// readInbox mirrors the TS readAll: an unreadable or corrupted file degrades
// to an empty mailbox with a `teams operation failed` log (TS catch); a
// non-array document silently yields nothing (TS Array.isArray guard); items
// failing the FileMailMessageSchema are silently skipped.
func (mb *FileMailBox) readInbox(agentID string) []FileMailMessage {
	path := mb.inboxPath(agentID)
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Error("teams operation failed", "err", err)
		}
		return nil
	}
	var rawAny any
	if err := json.Unmarshal(data, &rawAny); err != nil {
		log.Error("teams operation failed", "err", err)
		return nil
	}
	arr, ok := rawAny.([]any)
	if !ok {
		return nil // TS: Array.isArray(raw) is false → empty mailbox, no log
	}
	messages := make([]FileMailMessage, 0, len(arr))
	for _, item := range arr {
		m, ok := decodeMailMessage(item)
		if !ok {
			continue // TS: per-item safeParse failure is silent
		}
		messages = append(messages, m)
	}
	return messages
}

// decodeMailMessage applies the TS FileMailMessageSchema to one decoded item:
// from/text/timestamp are required strings; read/approve are optional booleans;
// type/requestId are optional strings; unknown keys are ignored (zod strip).
// The Go-only Color field is kept when it is a string (P4 extension; TS drops
// unknown keys).
func decodeMailMessage(item any) (FileMailMessage, bool) {
	obj, ok := item.(map[string]any)
	if !ok {
		return FileMailMessage{}, false
	}
	from, okFrom := obj["from"].(string)
	text, okText := obj["text"].(string)
	timestamp, okTimestamp := obj["timestamp"].(string)
	if !okFrom || !okText || !okTimestamp {
		return FileMailMessage{}, false
	}
	m := FileMailMessage{From: from, Text: text, Timestamp: timestamp}
	if v, present := obj["read"]; present {
		b, ok := v.(bool)
		if !ok {
			return FileMailMessage{}, false
		}
		m.Read = b
	}
	if v, present := obj["type"]; present {
		s, ok := v.(string)
		if !ok {
			return FileMailMessage{}, false
		}
		m.Type = s
	}
	if v, present := obj["requestId"]; present {
		s, ok := v.(string)
		if !ok {
			return FileMailMessage{}, false
		}
		m.RequestID = s
	}
	if v, present := obj["approve"]; present {
		b, ok := v.(bool)
		if !ok {
			return FileMailMessage{}, false
		}
		m.Approve = &b
	}
	if v, present := obj["color"]; present {
		if s, ok := v.(string); ok {
			m.Color = s
		}
	}
	return m, true
}

// writeInbox serializes like TS writeAll: JSON.stringify(messages, null, 2),
// which does not HTML-escape `<`/`>`/`&`.
func (mb *FileMailBox) writeInbox(agentID string, messages []FileMailMessage) error {
	path := mb.inboxPath(agentID)
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(messages); err != nil {
		return err
	}
	return os.WriteFile(path, bytes.TrimSuffix(buf.Bytes(), []byte("\n")), 0644)
}
