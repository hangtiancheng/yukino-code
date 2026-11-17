package compact

import (
	"fmt"
	"math"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

func approxTokens(s string) int {
	if s == "" {
		return 0
	}
	return int(math.Floor(float64(utf8.RuneCountInString(s)) / RecoveryCharsPerToken))
}

func truncateByTokens(s string, tokenBudget int) string {
	if tokenBudget <= 0 || s == "" {
		return s
	}
	if approxTokens(s) <= tokenBudget {
		return s
	}
	maxChars := int(math.Floor(float64(tokenBudget) * RecoveryCharsPerToken))
	runes := []rune(s)
	if maxChars <= 0 || maxChars >= len(runes) {
		return s
	}
	suffix := "\n… (content truncated)"
	suffixRunes := []rune(suffix)
	if maxChars <= len(suffixRunes) {
		return string(suffixRunes[:maxChars])
	}
	return string(runes[:maxChars-len(suffixRunes)]) + suffix
}

// FileReadRecord is one tracked file snapshot.
type FileReadRecord struct {
	Path      string
	Content   string
	Timestamp time.Time
}

// RecoveryState keeps the recent-file snapshots attached to compaction
// summaries. Insertion order is tracked explicitly: re-recording a path
// refreshes its recency and eviction drops the oldest entry, mirroring the
// reference Map semantics.
type RecoveryState struct {
	mu    sync.Mutex
	files map[string]FileReadRecord
	order []string
}

func NewRecoveryState() *RecoveryState {
	return &RecoveryState{files: map[string]FileReadRecord{}}
}

func (s *RecoveryState) ensure() {
	if s.files == nil {
		s.files = map[string]FileReadRecord{}
	}
}

// RecordFileRead snapshots a file read, truncating to the per-file budget and
// evicting the oldest entries beyond the limit.
func (s *RecoveryState) RecordFileRead(path, content string) {
	if s == nil || path == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensure()
	if _, ok := s.files[path]; ok {
		s.removeOrder(path)
	}
	s.files[path] = FileReadRecord{
		Path:      path,
		Content:   truncateByTokens(content, RecoveryTokensPerFile),
		Timestamp: time.Now(),
	}
	s.order = append(s.order, path)
	for len(s.order) > RecoveryFileLimit {
		oldest := s.order[0]
		s.order = s.order[1:]
		delete(s.files, oldest)
	}
}

func (s *RecoveryState) removeOrder(path string) {
	for i, item := range s.order {
		if item == path {
			s.order = append(s.order[:i], s.order[i+1:]...)
			return
		}
	}
}

// SnapshotFiles returns the most recently read records, newest first.
func (s *RecoveryState) SnapshotFiles(limit int) []FileReadRecord {
	if s == nil {
		return nil
	}
	if limit <= 0 {
		limit = RecoveryFileLimit
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]FileReadRecord, 0, len(s.files))
	for _, record := range s.files {
		out = append(out, record)
	}
	sortByTimestampDesc(out)
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

func sortByTimestampDesc(out []FileReadRecord) {
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Timestamp.After(out[j-1].Timestamp); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
}

// BuildRecoveryAttachment renders the attachment block appended to the
// compaction summary message.
func (s *RecoveryState) BuildRecoveryAttachment(toolSchemaNames []string) string {
	var sections []string

	recentFiles := s.SnapshotFiles(RecoveryFileLimit)
	if len(recentFiles) > 0 {
		sections = append(sections, RecoveryFilesHeader)
		sections = append(sections, RecoveryFilesNote)
		for _, f := range recentFiles {
			content := truncateByTokens(f.Content, RecoveryTokensPerFile)
			// toISOString() with the milliseconds stripped, like the reference.
			ts := f.Timestamp.UTC().Format("2006-01-02T15:04:05") + "Z"
			body := content
			if !strings.HasSuffix(body, "\n") {
				body += "\n"
			}
			sections = append(sections, fmt.Sprintf("### %s  (read %s)\n\n```\n%s```", f.Path, ts, body))
		}
	}

	if len(toolSchemaNames) > 0 {
		lines := make([]string, 0, len(toolSchemaNames))
		for _, name := range toolSchemaNames {
			lines = append(lines, "- "+name)
		}
		sections = append(sections, RecoveryToolsIntro+strings.Join(lines, "\n"))
	}

	if len(sections) == 0 {
		return ""
	}

	sections = append(sections, RecoveryFooterNote)
	return strings.Join(sections, "\n\n")
}
