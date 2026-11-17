package teams

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/storage"
)

var mailboxMemberPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

type FileMailBox struct{ baseDir string }
type FileMailMessage struct {
	From      string `json:"from"`
	Text      string `json:"text"`
	Timestamp string `json:"timestamp"`
	Read      bool   `json:"read,omitempty"`
	Type      string `json:"type,omitempty"`
	RequestID string `json:"requestId,omitempty"`
	Approve   *bool  `json:"approve,omitempty"`
}

func NewFileMailMessage(from, text string) FileMailMessage {
	return FileMailMessage{From: from, Text: text, Timestamp: isoTimestamp()}
}

// isoTimestamp renders the current time exactly like JavaScript's
// Date.toISOString(): UTC with three millisecond digits.
func isoTimestamp() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}
func NewFileMailBox(baseDir string) *FileMailBox {
	_ = storage.MkdirPrivateSync(baseDir)
	return &FileMailBox{baseDir: baseDir}
}
func (mb *FileMailBox) inboxPath(agentID string) string {
	return filepath.Join(mb.baseDir, agentID+".json")
}
func (mb *FileMailBox) Send(recipient string, msg FileMailMessage) error {
	return mb.withLock(recipient, func(messages []FileMailMessage) ([]FileMailMessage, error) {
		msg.Read = false
		if msg.Timestamp == "" {
			msg.Timestamp = isoTimestamp()
		}
		return append(messages, msg), nil
	})
}
func (mb *FileMailBox) ReadUnread(agentID string) ([]FileMailMessage, error) {
	if !mailboxMemberPattern.MatchString(agentID) {
		return nil, fmt.Errorf("Invalid mailbox member name")
	}
	messages, err := mb.readInbox(agentID)
	if err != nil {
		return nil, err
	}
	unread := []FileMailMessage{}
	for _, m := range messages {
		if !m.Read {
			unread = append(unread, m)
		}
	}
	return unread, nil
}
func (mb *FileMailBox) MarkAllRead(agentID string) error {
	_, err := mb.ReceiveMatching(agentID, func(FileMailMessage) bool { return true })
	return err
}
func (mb *FileMailBox) ReceiveMatching(agentID string, match func(FileMailMessage) bool) ([]FileMailMessage, error) {
	if !mailboxMemberPattern.MatchString(agentID) {
		return nil, fmt.Errorf("Invalid mailbox member name")
	}
	received := []FileMailMessage{}
	err := storage.WithFileSyncLock(mb.inboxPath(agentID), func() error {
		messages, err := mb.readInbox(agentID)
		if err != nil {
			return err
		}
		for i := range messages {
			if !messages[i].Read && match(messages[i]) {
				messages[i].Read = true
				received = append(received, messages[i])
			}
		}
		// The reference skips the write when nothing matched, so an empty
		// receive is a true no-op on disk.
		if len(received) == 0 {
			return nil
		}
		return mb.writeInbox(agentID, pruneReadMessages(messages))
	})
	return received, err
}
func (mb *FileMailBox) Requeue(agentID string, messages []FileMailMessage) error {
	if len(messages) == 0 {
		return nil
	}
	return mb.withLock(agentID, func(all []FileMailMessage) ([]FileMailMessage, error) {
		for _, m := range messages {
			m.Read = false
			all = append(all, m)
		}
		return all, nil
	})
}
func (mb *FileMailBox) withLock(agentID string, fn func([]FileMailMessage) ([]FileMailMessage, error)) error {
	if !mailboxMemberPattern.MatchString(agentID) {
		return fmt.Errorf("Invalid mailbox member name")
	}
	return storage.WithFileSyncLock(mb.inboxPath(agentID), func() error {
		messages, err := mb.readInbox(agentID)
		if err != nil {
			return err
		}
		messages, err = fn(messages)
		if err != nil {
			return err
		}
		return mb.writeInbox(agentID, pruneReadMessages(messages))
	})
}
func (mb *FileMailBox) readInbox(agentID string) ([]FileMailMessage, error) {
	data, err := storage.ReadPrivateFileSync(mb.inboxPath(agentID))
	if os.IsNotExist(err) {
		return []FileMailMessage{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("Cannot load an unreadable teammate mailbox; original contents were preserved: %w", err)
	}
	var raw []map[string]json.RawMessage
	if err = json.Unmarshal(data, &raw); err == nil && raw != nil {
		for _, fields := range raw {
			for _, key := range []string{"from", "text", "timestamp"} {
				var value string
				if len(fields[key]) == 0 || string(fields[key]) == "null" || json.Unmarshal(fields[key], &value) != nil {
					err = fmt.Errorf("invalid %s", key)
					break
				}
			}
			if err != nil {
				break
			}
			for _, key := range []string{"type", "requestId"} {
				if value, ok := fields[key]; ok {
					var s string
					if string(value) == "null" || json.Unmarshal(value, &s) != nil {
						err = fmt.Errorf("invalid %s", key)
						break
					}
				}
			}
			for _, key := range []string{"read", "approve"} {
				if value, ok := fields[key]; ok {
					var b bool
					if string(value) == "null" || json.Unmarshal(value, &b) != nil {
						err = fmt.Errorf("invalid %s", key)
						break
					}
				}
			}
			if err != nil {
				break
			}
		}
	} else if err == nil {
		err = fmt.Errorf("expected message array")
	}
	if err != nil {
		return nil, fmt.Errorf("Cannot load an unreadable teammate mailbox; original contents were preserved: %w", err)
	}
	var messages []FileMailMessage
	err = json.Unmarshal(data, &messages)
	return messages, err
}

// MaxReadMessages mirrors MAX_READ_MESSAGES: the cap on read messages retained
// on disk; unread messages are never dropped.
const MaxReadMessages = 500

func pruneReadMessages(messages []FileMailMessage) []FileMailMessage {
	excess := -MaxReadMessages
	for _, m := range messages {
		if m.Read {
			excess++
		}
	}
	result := make([]FileMailMessage, 0, len(messages))
	for _, m := range messages {
		if excess > 0 && m.Read {
			excess--
			continue
		}
		result = append(result, m)
	}
	return result
}
func (mb *FileMailBox) writeInbox(agentID string, messages []FileMailMessage) error {
	path := mb.inboxPath(agentID)
	data, err := json.MarshalIndent(messages, "", "  ")
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.%s.tmp", path, os.Getpid(), randomHex(8))
	defer os.Remove(tmp)
	if err = storage.WritePrivateFileSync(tmp, data, os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
