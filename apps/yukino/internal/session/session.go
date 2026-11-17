package session

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"errors"
	"fmt"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/history"
	"github.com/yukino-js/yukino/yukino/internal/logger"
	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

// log mirrors the reference's createChildLogger({ module: "session" }).
var log = logger.CreateChildLogger("session")

const (
	TypeCompactBoundary = "compact_boundary"
	// GoalRecord marks goal-state lines, which are not conversation messages.
	GoalRecord = "goal_state"

	SessionFileExtension = ".jsonl"
	SessionExpiryDays    = 30

	FirstMessagePreviewChars = 100
)

var rewindTempPattern = regexp.MustCompile(`\.\d+\.rewind-tmp$`)

var sessionIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type CompactBoundary struct {
	Summary string        `json:"summary"`
	Keep    []KeepMessage `json:"keep"`
}

// SaveCompactBoundary appends a compaction boundary to the session transcript,
// mirroring saveCompactBoundary in the reference.
func SaveCompactBoundary(workDir, sessionID, summary string, keep []KeepMessage) error {
	if err := history.RegisterProject(workDir); err != nil {
		return err
	}
	path := SessionFilePath(workDir, sessionID)
	if path == "" {
		return errors.New(storage.InvalidSessionIDError)
	}
	return SaveTranscriptCompactBoundary(path, summary, keep)
}

// SaveTranscriptCompactBoundary appends a compaction boundary to a specific
// transcript path, mirroring saveTranscriptCompactBoundary in the reference.
// The summary and the verbatim kept tail are inlined into one COMPACT_BOUNDARY
// record; this is append-only, so pre-boundary messages stay in the file but
// are not replayed on resume (see RebuildFromSession).
func SaveTranscriptCompactBoundary(filePath, summary string, keep []KeepMessage) error {
	if keep == nil {
		keep = []KeepMessage{}
	}
	blob, err := json.Marshal(CompactBoundary{Summary: summary, Keep: keep})
	if err != nil {
		return err
	}
	return SaveTranscriptMessage(filePath, Message{
		Role:      "system",
		Type:      TypeCompactBoundary,
		Content:   string(blob),
		Timestamp: time.Now().Unix(),
	})
}

func FindLastCompactBoundary(msgs []Message) (boundary CompactBoundary, after []Message, ok bool) {
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Type != TypeCompactBoundary {
			continue
		}
		var raw map[string]json.RawMessage
		if json.Unmarshal([]byte(msgs[i].Content), &raw) != nil || raw["summary"] == nil || raw["keep"] == nil {
			continue
		}
		var candidate CompactBoundary
		if json.Unmarshal([]byte(msgs[i].Content), &candidate) != nil || strings.TrimSpace(candidate.Summary) == "" || candidate.Keep == nil {
			continue
		}
		for _, message := range msgs[i+1:] {
			if message.Type != TypeCompactBoundary {
				after = append(after, message)
			}
		}
		return candidate, after, true
	}
	return CompactBoundary{}, nil, false
}

func RebuildFromSession(saved []Message, includeExcludedUserBash bool) []conversation.Message {
	boundary, after, compacted := FindLastCompactBoundary(saved)
	var messages []Message
	if compacted {
		summary := fmt.Sprintf("The conversation history before this point was compacted into the following summary:\n\n<summary>\n%s\n</summary>", boundary.Summary)
		if len(boundary.Keep) > 0 {
			summary += "\n\nRecent messages have been preserved verbatim."
		}
		messages = append(messages, Message{Role: "user", Content: summary})
		for _, kept := range boundary.Keep {
			messages = append(messages, Message(kept))
		}
		messages = append(messages, after...)
	} else {
		messages = saved
	}
	var restored []conversation.Message
	for _, message := range messages {
		if message.Type == TypeCompactBoundary || message.Role != "user" && message.Role != "assistant" || message.Empty() {
			continue
		}
		if message.UserBash != nil && message.UserBash.ExcludeFromContext && !includeExcludedUserBash {
			continue
		}
		restored = append(restored, message.ToConversation())
	}
	return restored
}

type SessionInfo struct {
	ID           string
	FirstMessage string
	MessageCount int
	FileSize     int64
	ModTime      time.Time
	// LastUserMessageTime is the newest user input timestamp; nil when the
	// session holds no user messages.
	LastUserMessageTime *time.Time
}

// ProjectSessionInfo is a SessionInfo annotated with its owning project, as
// returned by ListAllSessions.
type ProjectSessionInfo struct {
	SessionInfo
	Cwd        string
	ProjectKey string
}

func NewID() string {
	timestamp := strconv.FormatInt(time.Now().UnixMilli(), 36)
	buf := make([]byte, 4)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return timestamp + "-" + hex.EncodeToString(buf)
}

func SessionFilePath(workDir, id string) string {
	if !sessionIDRe.MatchString(id) {
		return ""
	}
	dir, err := storage.GetSessionsDir(workDir)
	if err != nil {
		return ""
	}
	return filepath.Join(dir, id+SessionFileExtension)
}

func SaveMessage(workDir, sessionID string, msg Message) error {
	if err := history.RegisterProject(workDir); err != nil {
		return err
	}
	path := SessionFilePath(workDir, sessionID)
	if path == "" {
		return errors.New(storage.InvalidSessionIDError)
	}
	return SaveTranscriptMessage(path, msg)
}

func SaveUserMessage(workDir, sessionID string, input history.InputEntry, message Message) (Message, error) {
	canonical, err := utils.CanonicalPath(workDir, 0)
	if err != nil {
		return Message{}, err
	}
	if input.Cwd != canonical || input.SessionID == nil || *input.SessionID != sessionID {
		return Message{}, errors.New("User input does not belong to this project and session.")
	}
	message.Role = "user"
	message.Timestamp = input.Timestamp / 1000
	message.UserInput = &conversation.UserInput{ID: input.ID, Timestamp: input.Timestamp}
	return message, SaveMessage(workDir, sessionID, message)
}

func SaveTranscriptMessage(path string, msg Message) error {
	if path == "" {
		return errors.New("Transcript path must not be empty")
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return storage.AppendPrivateFileSync(path, append(data, '\n'))
}

// parseTranscriptRecords returns every parsable record, mirroring
// parseTranscriptRecords in the reference.
func parseTranscriptRecords(path string) ([]Message, error) {
	data, err := storage.ReadPrivateFileSync(path)
	if err != nil {
		// The reference's readFileSync throws on a non-ENOENT read failure and
		// withFileSyncLock re-throws it, so loadSession propagates to the caller.
		return nil, err
	}
	var msgs []Message
	invalidRecords := 0
	var firstErr error
	for _, line := range bytes.Split(data, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var msg Message
		if err := json.Unmarshal(line, &msg); err != nil {
			invalidRecords++
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		msgs = append(msgs, msg)
	}
	if invalidRecords > 0 {
		log.Error(map[string]any{"err": firstErr, "filePath": path, "invalidRecords": invalidRecords}, "Invalid session records skipped")
	}
	return msgs, nil
}

// LoadSessionForResume reads the transcript under the file lock and renews
// its mtime so an actively resumed session is not swept as expired.
func LoadSessionForResume(workDir, sessionID string) ([]Message, error) {
	_ = history.RegisterProject(workDir)
	return loadTranscript(SessionFilePath(workDir, sessionID), true)
}

func loadTranscript(path string, renew bool) ([]Message, error) {
	if path == "" {
		return nil, nil
	}
	if _, err := os.Stat(filepath.Dir(path)); err != nil {
		return nil, nil
	}
	var msgs []Message
	lockErr := storage.WithFileSyncLock(path, func() error {
		if _, err := os.Stat(path); err != nil {
			return nil
		}
		records, err := parseTranscriptRecords(path)
		if err != nil {
			return err
		}
		for _, msg := range records {
			if msg.Empty() {
				continue
			}
			msgs = append(msgs, msg)
		}
		if renew && len(msgs) > 0 {
			now := time.Now()
			_ = os.Chtimes(path, now, now)
		}
		return nil
	})
	if lockErr != nil {
		return nil, lockErr
	}
	return msgs, nil
}

func LoadSession(workDir, sessionID string) ([]Message, error) {
	return loadTranscript(SessionFilePath(workDir, sessionID), false)
}

func LoadTranscript(path string) ([]Message, error) { return loadTranscript(path, false) }

func SessionLineCount(path string) (int, bool, error) {
	if path == "" {
		return 0, false, nil
	}
	if _, err := os.Stat(filepath.Dir(path)); errors.Is(err, os.ErrNotExist) {
		return 0, false, nil
	}
	count, exists := 0, false
	err := storage.WithFileSyncLock(path, func() error {
		data, err := storage.ReadPrivateFileSync(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		exists = true
		for _, line := range bytes.Split(data, []byte("\n")) {
			if len(bytes.TrimSpace(line)) > 0 {
				count++
			}
		}
		return nil
	})
	return count, exists, err
}

func TruncateSessionLines(path string, keepLines int) error {
	if path == "" {
		return nil
	}
	if _, err := os.Stat(filepath.Dir(path)); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return storage.WithFileSyncLock(path, func() error {
		data, err := storage.ReadPrivateFileSync(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		var kept [][]byte
		for _, line := range bytes.Split(data, []byte("\n")) {
			if len(kept) >= keepLines {
				break
			}
			if len(bytes.TrimSpace(line)) > 0 {
				kept = append(kept, line)
			}
		}
		content := bytes.Join(kept, []byte("\n"))
		if len(kept) > 0 {
			content = append(content, '\n')
		}
		temp := fmt.Sprintf("%s.%d.rewind-tmp", path, os.Getpid())
		defer os.Remove(temp)
		if err := storage.WritePrivateFileSync(temp, content, os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
			return err
		}
		return os.Rename(temp, path)
	})
}

// sweptSessionDirs tracks the session directories already swept in this
// process; expired-session cleanup piggybacks on the first ListSessions call
// per directory.
var sweptSessionDirs = struct {
	sync.Mutex
	dirs map[string]bool
}{dirs: make(map[string]bool)}

func ListSessions(workDir string) []SessionInfo {
	dir, err := storage.GetSessionsDir(workDir)
	if err != nil {
		return nil
	}
	sweptSessionDirs.Lock()
	swept := sweptSessionDirs.dirs[dir]
	sweptSessionDirs.dirs[dir] = true
	sweptSessionDirs.Unlock()
	if !swept {
		CleanExpiredSessions(workDir)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	var sessions []SessionInfo
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), SessionFileExtension) {
			continue
		}
		id := strings.TrimSuffix(e.Name(), SessionFileExtension)
		filePath := filepath.Join(dir, e.Name())
		var info *SessionInfo
		lockErr := storage.WithFileSyncLock(filePath, func() error {
			stat, err := os.Stat(filePath)
			if err != nil {
				return nil
			}
			firstMessage := ""
			messageCount := 0
			lastUserTs := int64(-1)
			records, err := parseTranscriptRecords(filePath)
			if err != nil {
				return err
			}
			for _, msg := range records {
				if msg.Type == GoalRecord {
					continue
				}
				messageCount++
				if msg.Role == "user" && msg.UserInput != nil && len(msg.ToolResults) == 0 && msg.UserInput.Timestamp > lastUserTs {
					lastUserTs = msg.UserInput.Timestamp
				}
				if firstMessage == "" && msg.Role == "user" && !msg.Empty() {
					text := msg.ToConversation().ContentText()
					firstMessage = string([]rune(text)[:min(len([]rune(text)), FirstMessagePreviewChars)])
				}
			}
			entry := SessionInfo{
				ID:           id,
				FirstMessage: firstMessage,
				MessageCount: messageCount,
				FileSize:     stat.Size(),
				ModTime:      stat.ModTime(),
			}
			if lastUserTs >= 0 {
				t := time.UnixMilli(lastUserTs)
				entry.LastUserMessageTime = &t
			}
			info = &entry
			return nil
		})
		if lockErr != nil {
			// The reference wraps each file in try/catch and logs
			// "session operation failed", skipping the unreadable session.
			log.Error(map[string]any{"err": lockErr}, "session operation failed")
		}
		if info != nil {
			sessions = append(sessions, *info)
		}
	}

	sort.SliceStable(sessions, func(i, j int) bool {
		ti, tj := int64(-1), int64(-1)
		if sessions[i].LastUserMessageTime != nil {
			ti = sessions[i].LastUserMessageTime.UnixMilli()
		}
		if sessions[j].LastUserMessageTime != nil {
			tj = sessions[j].LastUserMessageTime.UnixMilli()
		}
		if ti != tj {
			return ti > tj
		}
		return sessions[i].ID < sessions[j].ID
	})
	return sessions
}

// ListAllSessions lists sessions across every registered project, ordered by
// newest user activity, then project key, then id — mirroring the reference
// listAllSessions. A project whose sessions cannot be listed contributes
// nothing (ListSessions returns nil on error), matching the reference's
// per-project try/catch that logs and skips.
func ListAllSessions() []ProjectSessionInfo {
	projects, err := history.ListProjects()
	if err != nil {
		return nil
	}
	var sessions []ProjectSessionInfo
	for _, project := range projects {
		for _, info := range ListSessions(project.Cwd) {
			sessions = append(sessions, ProjectSessionInfo{SessionInfo: info, Cwd: project.Cwd, ProjectKey: project.ProjectKey})
		}
	}
	sort.SliceStable(sessions, func(i, j int) bool {
		ti, tj := int64(-1), int64(-1)
		if sessions[i].LastUserMessageTime != nil {
			ti = sessions[i].LastUserMessageTime.UnixMilli()
		}
		if sessions[j].LastUserMessageTime != nil {
			tj = sessions[j].LastUserMessageTime.UnixMilli()
		}
		if ti != tj {
			return ti > tj
		}
		if sessions[i].ProjectKey != sessions[j].ProjectKey {
			return sessions[i].ProjectKey < sessions[j].ProjectKey
		}
		return sessions[i].ID < sessions[j].ID
	})
	return sessions
}

// CleanExpiredSessions deletes .jsonl files whose last modified time exceeds
// SessionExpiryDays. Invoked lazily by ListSessions (once per process per
// sessions directory). Failures are skipped (best-effort).
func CleanExpiredSessions(workDir string) int {
	dir, err := storage.GetSessionsDir(workDir)
	if err != nil {
		return 0
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	now := time.Now()
	expiry := time.Duration(SessionExpiryDays) * 24 * time.Hour
	removed := 0
	for _, entry := range entries {
		if rewindTempPattern.MatchString(entry.Name()) {
			base := rewindTempPattern.ReplaceAllString(entry.Name(), "")
			_ = storage.WithFileSyncLock(filepath.Join(dir, base), func() error { return os.Remove(filepath.Join(dir, entry.Name())) })
		}
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), SessionFileExtension) {
			continue
		}
		filePath := filepath.Join(dir, e.Name())
		_ = storage.WithFileSyncLock(filePath, func() error {
			stat, err := os.Stat(filePath)
			if err != nil {
				return nil
			}
			if now.Sub(stat.ModTime()) <= expiry {
				return nil
			}
			if os.Remove(filePath) == nil {
				if artifacts, err := storage.SessionPath(strings.TrimSuffix(e.Name(), SessionFileExtension)); err == nil {
					_ = os.RemoveAll(artifacts)
				}
				removed++
			}
			return nil
		})
	}
	return removed
}
