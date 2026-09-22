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
	"os"
	"path/filepath"

	"github.com/hangtiancheng/yukino-code/yukino/conversation"
)

// TranscriptEntry is a single conversation record serialized to disk (TS:
// teams/transcript.ts TranscriptEntry).
type TranscriptEntry struct {
	Role string `json:"role"`
	// Content is always serialized: TS writes contentToText(msg.content),
	// which may legitimately be "" — omitting the key would change the file
	// shape for tool-only turns.
	Content     string                 `json:"content"`
	ToolUses    []TranscriptToolUse    `json:"tool_uses,omitempty"`
	ToolResults []TranscriptToolResult `json:"tool_results,omitempty"`
}

type TranscriptToolUse struct {
	ToolUseID string `json:"tool_use_id"`
	ToolName  string `json:"tool_name"`
	// Arguments is always serialized (TS stringifies it as-is, "{}" included).
	Arguments map[string]any `json:"arguments"`
}

type TranscriptToolResult struct {
	ToolUseID string `json:"tool_use_id"`
	Content   string `json:"content"`
	IsError   bool   `json:"is_error,omitempty"`
}

// serializeConversation serializes conversation history into a persistable JSON format.
func serializeConversation(conv *conversation.Manager) []TranscriptEntry {
	var entries []TranscriptEntry
	for _, msg := range conv.GetMessages() {
		// TS serializes contentToText(msg.content); the Go Message.Content is
		// already the text form (ContentBlocks carry the structured variant).
		entry := TranscriptEntry{Role: msg.Role, Content: msg.Content}
		for _, tu := range msg.ToolUses {
			entry.ToolUses = append(entry.ToolUses, TranscriptToolUse{
				ToolUseID: tu.ToolUseID,
				ToolName:  tu.ToolName,
				Arguments: tu.Arguments,
			})
		}
		for _, tr := range msg.ToolResults {
			entry.ToolResults = append(entry.ToolResults, TranscriptToolResult{
				ToolUseID: tr.ToolUseID,
				Content:   tr.Content,
				IsError:   tr.IsError,
			})
		}
		entries = append(entries, entry)
	}
	return entries
}

// transcriptDir mirrors the TS transcript location (transcript.ts:93-95):
// <workDir>/.yukino/teams/<team>/transcripts. The team segment is sanitized
// in the Go port (TS uses the raw LLM-chosen name, which could escape the
// directory).
func transcriptDir(workDir, teamName string) string {
	return filepath.Join(workDir, ".yukino", "teams", sanitizeTeamName(teamName), "transcripts")
}

// SaveTranscript persists a teammate's conversation history to disk for
// debugging and troubleshooting (TS: saveTranscript — JSON.stringify(data,
// null, 2), which does not HTML-escape `<`/`>`/`&`).
func SaveTranscript(workDir, teamName, agentID string, conv *conversation.Manager) (string, error) {
	dir := transcriptDir(workDir, teamName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, agentID+".json")
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(serializeConversation(conv)); err != nil {
		return "", err
	}
	return path, os.WriteFile(path, bytes.TrimSuffix(buf.Bytes(), []byte("\n")), 0o644)
}

// LoadTranscript loads a teammate's conversation history from disk; it
// returns nil when the file does not exist or parsing fails (TS:
// loadTranscript — a missing file is silent, a read/parse/schema failure logs
// `teams operation failed`).
func LoadTranscript(workDir, teamName, agentID string) []TranscriptEntry {
	path := filepath.Join(transcriptDir(workDir, teamName), agentID+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Error("teams operation failed", "err", err)
		}
		return nil
	}
	var entries []TranscriptEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		log.Error("teams operation failed", "err", err)
		return nil
	}
	return entries
}
