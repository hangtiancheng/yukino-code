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

package compact

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/utils"
)

// Recovery limits for the attachment block that gets appended to the
// summary message. Compact wipes the working conversation; without these
// snapshots the model would forget which files it just read and which
// skill SOPs it was operating under.
const (
	RecoveryFileLimit      = 5
	RecoveryTokensPerFile  = 5_000
	RecoverySkillsBudget   = 25_000
	RecoveryTokensPerSkill = 5_000
	recoveryCharsPerToken  = 3.5
)

// FileReadRecord snapshots the bytes a ReadFile call returned to the
// model. Re-injected post-compact so the model still has the content it
// was reasoning about when the threshold tripped.
type FileReadRecord struct {
	Path      string
	Content   string
	Timestamp time.Time
}

// SkillInvocationRecord captures the SOP body that was attached when a
// skill was invoked. After compaction the same definition gets stitched
// back in so behaviour stays consistent across the boundary.
type SkillInvocationRecord struct {
	Name      string
	Body      string
	Timestamp time.Time
}

// RecoveryState tracks the per-agent data that needs to survive
// compaction. The struct is safe for concurrent recording — tool
// callbacks can fire from parallel goroutines in the streaming
// executor.
//
// fileOrder/skillOrder mirror the TS Maps' insertion order: RecordFileRead
// deletes then re-inserts (a re-read moves the entry to the end of the
// eviction order), RecordSkillInvocation keeps the first-seen position.
// Snapshots sort by timestamp descending, stable over that order.
type RecoveryState struct {
	mu         sync.Mutex
	files      map[string]FileReadRecord
	fileOrder  []string
	skills     map[string]SkillInvocationRecord
	skillOrder []string
}

// NewRecoveryState returns an empty state ready for recording.
func NewRecoveryState() *RecoveryState {
	return &RecoveryState{
		files:  map[string]FileReadRecord{},
		skills: map[string]SkillInvocationRecord{},
	}
}

// RecordFileRead overwrites any prior record for the same path so the
// most recent snapshot wins, truncating the content at record time and
// evicting the least-recently-updated entries beyond the limit (TS:
// recordFileRead). Safe to call on a nil receiver.
func (s *RecoveryState) RecordFileRead(path, content string) {
	if s == nil || path == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.files[path]; exists {
		// delete+set: the re-read entry moves to the end of the order.
		s.fileOrder = removeOrdered(s.fileOrder, path)
	}
	s.files[path] = FileReadRecord{
		Path:      path,
		Content:   truncateByTokens(content, RecoveryTokensPerFile),
		Timestamp: time.Now(),
	}
	s.fileOrder = append(s.fileOrder, path)
	for len(s.files) > RecoveryFileLimit {
		oldest := s.fileOrder[0]
		s.fileOrder = s.fileOrder[1:]
		delete(s.files, oldest)
	}
}

// RecordSkillInvocation overwrites any prior record for the same skill
// name, keeping its first-seen position in the order (TS: set without
// delete). Safe to call on a nil receiver.
func (s *RecoveryState) RecordSkillInvocation(name, body string) {
	if s == nil || name == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.skills[name]; !exists {
		s.skillOrder = append(s.skillOrder, name)
	}
	s.skills[name] = SkillInvocationRecord{Name: name, Body: body, Timestamp: time.Now()}
}

func removeOrdered(list []string, value string) []string {
	for i, v := range list {
		if v == value {
			return append(list[:i], list[i+1:]...)
		}
	}
	return list
}

// snapshotFiles returns at most `limit` records, newest first (stable over
// the insertion order on timestamp ties, like the TS sort).
func (s *RecoveryState) snapshotFiles(limit int) []FileReadRecord {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]FileReadRecord, 0, len(s.fileOrder))
	for _, path := range s.fileOrder {
		out = append(out, s.files[path])
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Timestamp.After(out[j].Timestamp) })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// snapshotSkills returns every recorded skill, newest first (stable over
// the insertion order on timestamp ties, like the TS sort).
func (s *RecoveryState) snapshotSkills() []SkillInvocationRecord {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]SkillInvocationRecord, 0, len(s.skillOrder))
	for _, name := range s.skillOrder {
		out = append(out, s.skills[name])
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Timestamp.After(out[j].Timestamp) })
	return out
}

// BuildRecoveryAttachment renders the post-compact recovery sections
// (recently read files, skill definitions, tool listing, plus a closing
// note about not guessing from the summary) into a single block of text.
// toolSchemaNames is every registered tool name, unfiltered by the active
// tool filter (TS: registry.listTools().map(t => t.name)) — the model must be
// told what it still has access to even when a turn filter narrows the
// request schemas. Returns "" when there is nothing worth emitting so the
// caller can keep the summary message clean.
func BuildRecoveryAttachment(state *RecoveryState, toolSchemaNames []string) string {
	// Sections are joined with a blank line, exactly like the TS
	// buildRecoveryAttachment array join.
	var sections []string

	if files := state.snapshotFiles(RecoveryFileLimit); len(files) > 0 {
		sections = append(sections,
			"## Recently read files\n",
			"These snapshots are what the file-reading tool last returned. Re-open with the tool if you need the current bytes.\n",
		)
		for _, f := range files {
			content := truncateByTokens(f.Content, RecoveryTokensPerFile)
			ts := f.Timestamp.UTC().Format("2006-01-02T15:04:05Z")
			suffix := "\n"
			if strings.HasSuffix(content, "\n") {
				suffix = ""
			}
			sections = append(sections, fmt.Sprintf("### %s  (read %s)\n\n```\n%s%s```", f.Path, ts, content, suffix))
		}
	}

	if skills := state.snapshotSkills(); len(skills) > 0 {
		skillParts := []string{
			"## Active skills\n",
			"These skills were invoked earlier in the session. Continue to follow each SOP when its triggering condition applies.\n",
		}
		used := 0
		emitted := false
		for _, sk := range skills {
			body := truncateByTokens(sk.Body, RecoveryTokensPerSkill)
			tokens := approxTokens(body) + approxTokens(sk.Name) + 8
			if used+tokens > RecoverySkillsBudget {
				break
			}
			used += tokens
			skillParts = append(skillParts, fmt.Sprintf("### %s\n\n%s", sk.Name, body))
			emitted = true
		}
		if emitted {
			sections = append(sections, strings.Join(skillParts, "\n\n"))
		}
	}

	if len(toolSchemaNames) > 0 {
		lines := make([]string, 0, len(toolSchemaNames))
		for _, name := range toolSchemaNames {
			lines = append(lines, "- "+name)
		}
		sections = append(sections, "## Available tools\n\nYou still have access to the following tools — call them directly when the task needs one:\n\n"+strings.Join(lines, "\n"))
	}

	if len(sections) == 0 {
		return ""
	}

	sections = append(sections, "## Note\n\nEverything above the divider is reconstructed context. For exact code, error strings, or user-typed text, re-read the source rather than guess from the summary.")
	return strings.Join(sections, "\n\n")
}

// approxTokens uses the same chars-per-token heuristic as EstimateTokens
// so budgeting stays consistent across the package. Lengths are UTF-16
// code units (TS: s.length).
func approxTokens(s string) int {
	if s == "" {
		return 0
	}
	return int(float64(utils.UTF16Len(s)) / recoveryCharsPerToken)
}

// truncateByTokens cuts s at the UTF-16 offset that puts it just under the
// token budget and appends a marker so the model can see content was
// clipped. The suffix is reserved inside the budget, exactly like TS.
func truncateByTokens(s string, tokenBudget int) string {
	if tokenBudget <= 0 || s == "" {
		return s
	}
	if approxTokens(s) <= tokenBudget {
		return s
	}
	maxChars := int(float64(tokenBudget) * recoveryCharsPerToken)
	if maxChars <= 0 || maxChars >= utils.UTF16Len(s) {
		return s
	}
	suffix := "\n… (content truncated)"
	suffixLen := utils.UTF16Len(suffix)
	if maxChars <= suffixLen {
		return utils.TruncateUTF16(suffix, maxChars)
	}
	return utils.TruncateUTF16(s, maxChars-suffixLen) + suffix
}
