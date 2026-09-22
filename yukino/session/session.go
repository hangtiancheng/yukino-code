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

package session

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/conversation"
	"github.com/hangtiancheng/yukino-code/yukino/logger"
	"github.com/hangtiancheng/yukino-code/yukino/utils"
)

// log mirrors the TS module-scoped child logger
// (createChildLogger({module: "session"}), session/index.ts).
var log = logger.CreateChildLogger("session")

// TypeCompactBoundary marks a session record as a compaction boundary rather
// than a plain conversation message. A boundary record's Content holds a JSON
// blob (see CompactBoundary) carrying the summary text plus the recent tail
// (keep) that was preserved verbatim at compaction time. Plain messages leave
// Type empty (omitempty), so old sessions and normal turns are unaffected.
const TypeCompactBoundary = "compact_boundary"

// ToolUseRecord is the on-disk form of a tool invocation. It stores a
// protocol-agnostic internal representation rather than any single vendor's
// wire format, so a session can be restored even after switching providers.
type ToolUseRecord struct {
	ToolUseID string         `json:"tool_use_id"`
	ToolName  string         `json:"tool_name"`
	Arguments map[string]any `json:"arguments,omitempty"`
	// ProviderItemID mirrors the optional provider_item_id persisted by the TS
	// reference (ToolUseRecordSchema). The Go conversation layer does not carry
	// it, but keeping it on the record lets TS-written sessions round-trip
	// through Go without losing the field.
	ProviderItemID string `json:"provider_item_id,omitempty"`
}

// ToolResultRecord is the on-disk form of a tool result, paired with a
// ToolUseRecord via ToolUseID.
type ToolResultRecord struct {
	ToolUseID string `json:"tool_use_id"`
	Content   string `json:"content"`
	// ContentBlocks mirrors the optional content_blocks persisted by the TS
	// reference (ToolResultRecordSchema): structured blocks (e.g. inline images)
	// kept verbatim alongside the flattened text in Content.
	ContentBlocks []map[string]any `json:"content_blocks,omitempty"`
	IsError       bool             `json:"is_error,omitempty"`
}

// errContentMissing signals a required on-disk `content` field was absent.
var errContentMissing = errors.New("session: content is required")

// decodeContent accepts the on-disk content union written by either
// implementation (TS ContentSchema: string | Record<string,unknown>[]): a plain
// string, or an array of content blocks flattened to text via contentToText. It
// returns the text plus the raw blocks (non-nil only for the array form) so
// callers can preserve them as content_blocks.
func decodeContent(raw json.RawMessage) (text string, blocks []map[string]any, err error) {
	if len(raw) == 0 {
		return "", nil, errContentMissing
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s, nil, nil
	}
	if json.Unmarshal(raw, &blocks) == nil {
		return contentToText(blocks), blocks, nil
	}
	return "", nil, errors.New("session: content must be a string or an array of blocks")
}

// contentToText flattens persisted content blocks to a base64-free text
// fallback (TS: utils/index.ts contentToText).
func contentToText(blocks []map[string]any) string {
	var parts []string
	for _, block := range blocks {
		switch block["type"] {
		case "text":
			if text, ok := block["text"].(string); ok {
				parts = append(parts, text)
			}
		case "image":
			source, ok := block["source"].(map[string]any)
			if !ok {
				continue
			}
			mediaType := "image"
			if source["type"] == "base64" {
				if mt, ok := source["media_type"].(string); ok {
					mediaType = mt
				}
			}
			parts = append(parts, fmt.Sprintf("[Image: %s]", mediaType))
		case "tool_reference":
			if name, ok := block["tool_name"].(string); ok {
				parts = append(parts, fmt.Sprintf("[Tool reference: %s]", name))
			}
		case "search_result":
			title := "search result"
			if t, ok := block["title"].(string); ok {
				title = t
			}
			source := ""
			if s, ok := block["source"].(string); ok {
				source = " (" + s + ")"
			}
			nested := ""
			if arr, ok := block["content"].([]any); ok {
				var sub []map[string]any
				for _, item := range arr {
					if rec, ok := item.(map[string]any); ok {
						sub = append(sub, rec)
					}
				}
				nested = contentToText(sub)
			}
			entry := title + source
			if nested != "" {
				entry += "\n" + nested
			}
			parts = append(parts, entry)
		case "document":
			title := "document"
			if t, ok := block["title"].(string); ok {
				title = t
			}
			parts = append(parts, fmt.Sprintf("[Document: %s]", title))
		}
	}
	return strings.Join(parts, "\n")
}

// UnmarshalJSON tolerates the TS on-disk shape: `content` may be a string or an
// array of content blocks (flattened to text, with the array preserved as
// content_blocks when the record carries no explicit ones — TS
// recordsToCamelResults' legacy fallback).
func (r *ToolResultRecord) UnmarshalJSON(data []byte) error {
	var raw struct {
		ToolUseID     string           `json:"tool_use_id"`
		Content       json.RawMessage  `json:"content"`
		ContentBlocks []map[string]any `json:"content_blocks"`
		IsError       bool             `json:"is_error"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	text, blocks, err := decodeContent(raw.Content)
	if err != nil {
		return err
	}
	*r = ToolResultRecord{
		ToolUseID:     raw.ToolUseID,
		Content:       text,
		ContentBlocks: raw.ContentBlocks,
		IsError:       raw.IsError,
	}
	if len(r.ContentBlocks) == 0 {
		r.ContentBlocks = blocks
	}
	return nil
}

type Message struct {
	Role string `json:"role"`
	// Type distinguishes record kinds. Empty (the default, omitted from JSON)
	// means a plain conversation message; TypeCompactBoundary means Content is a
	// CompactBoundary JSON blob written by SaveCompactBoundary.
	Type    string `json:"type,omitempty"`
	Content string `json:"content"`
	// ContentBlocks carries structured user-message content (text/image blocks)
	// when a turn includes image attachments (TS: content is
	// `string | Record<string,unknown>[]`). When non-empty the on-disk `content`
	// field is written as this block array (see MarshalJSON); Content holds the
	// text fallback. json:"-" because the custom marshal folds it into content.
	ContentBlocks []map[string]any `json:"-"`
	// Ts is the unix timestamp. On disk the field is `timestamp` to match the
	// TS SessionMessageSchema, which requires it on every record.
	Ts int64 `json:"timestamp"`
	// ToolUses / ToolResults hold the tool blocks carried by this message. When both
	// are empty the fields are omitted from JSON entirely, so session files lacking
	// these fields still load fine — just without a tool chain.
	ToolUses    []ToolUseRecord    `json:"tool_uses,omitempty"`
	ToolResults []ToolResultRecord `json:"tool_results,omitempty"`
}

// UnmarshalJSON tolerates the TS on-disk shape: `content` may be a string or an
// array of content blocks (flattened to text so the line is preserved instead
// of dropped).
func (m *Message) UnmarshalJSON(data []byte) error {
	var raw struct {
		Role        string             `json:"role"`
		Type        string             `json:"type"`
		Content     json.RawMessage    `json:"content"`
		Timestamp   int64              `json:"timestamp"`
		ToolUses    []ToolUseRecord    `json:"tool_uses"`
		ToolResults []ToolResultRecord `json:"tool_results"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	text, blocks, err := decodeContent(raw.Content)
	if err != nil && !errors.Is(err, errContentMissing) {
		return err
	}
	// TS SessionMessageSchema gives `content` a default of "" when absent.
	*m = Message{
		Role:          raw.Role,
		Type:          raw.Type,
		Content:       text,
		ContentBlocks: blocks,
		Ts:            raw.Timestamp,
		ToolUses:      raw.ToolUses,
		ToolResults:   raw.ToolResults,
	}
	return nil
}

// marshalNoEscape encodes v like JSON.stringify: `<`/`>`/`&` stay literal
// (the Go encoder's default would HTML-escape them, diverging from the TS
// persisted bytes).
func marshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// MarshalJSON writes `content` as the block array when the message carries
// structured content (image attachments), matching the TS on-disk union shape;
// otherwise it writes the plain text string.
func (m Message) MarshalJSON() ([]byte, error) {
	type messageAlias struct {
		Role        string             `json:"role"`
		Type        string             `json:"type,omitempty"`
		Content     any                `json:"content"`
		Ts          int64              `json:"timestamp"`
		ToolUses    []ToolUseRecord    `json:"tool_uses,omitempty"`
		ToolResults []ToolResultRecord `json:"tool_results,omitempty"`
	}
	var content any = m.Content
	if len(m.ContentBlocks) > 0 {
		content = m.ContentBlocks
	}
	return marshalNoEscape(messageAlias{
		Role:        m.Role,
		Type:        m.Type,
		Content:     content,
		Ts:          m.Ts,
		ToolUses:    m.ToolUses,
		ToolResults: m.ToolResults,
	})
}

// FromConversation converts an in-memory conversation message into its on-disk form.
// Thinking blocks are not persisted: their signature is only needed when echoed back
// within the same tool loop, and is useless for cross-session restoration.
func FromConversation(msg conversation.Message) Message {
	rec := Message{
		Role:          msg.Role,
		Content:       msg.Content,
		ContentBlocks: msg.ContentBlocks,
		Ts:            time.Now().Unix(),
	}
	for _, tu := range msg.ToolUses {
		rec.ToolUses = append(rec.ToolUses, ToolUseRecord{
			ToolUseID:      tu.ToolUseID,
			ToolName:       tu.ToolName,
			Arguments:      tu.Arguments,
			ProviderItemID: tu.ProviderItemID,
		})
	}
	for _, tr := range msg.ToolResults {
		rec.ToolResults = append(rec.ToolResults, ToolResultRecord{
			ToolUseID:     tr.ToolUseID,
			Content:       tr.Content,
			ContentBlocks: tr.ContentBlocks,
			IsError:       tr.IsError,
		})
	}
	return rec
}

// ToConversation restores an on-disk record back into an in-memory conversation
// message, used by resume to rebuild history.
func (m Message) ToConversation() conversation.Message {
	msg := conversation.Message{
		Role:          m.Role,
		Content:       m.Content,
		ContentBlocks: m.ContentBlocks,
	}
	for _, tu := range m.ToolUses {
		msg.ToolUses = append(msg.ToolUses, conversation.ToolUseBlock{
			ToolUseID:      tu.ToolUseID,
			ToolName:       tu.ToolName,
			Arguments:      tu.Arguments,
			ProviderItemID: tu.ProviderItemID,
		})
	}
	for _, tr := range m.ToolResults {
		msg.ToolResults = append(msg.ToolResults, conversation.ToolResultBlock{
			ToolUseID:     tr.ToolUseID,
			Content:       tr.Content,
			ContentBlocks: tr.ContentBlocks,
			IsError:       tr.IsError,
		})
	}
	return msg
}

// KeepMessage is a recent message preserved verbatim when compaction occurs. Like
// Message, it carries tool blocks so that restoring a compacted session keeps this
// tail's tool call chain intact.
type KeepMessage struct {
	Role string `json:"role"`
	// Content is the text form; ContentBlocks carries the structured union
	// member (TS KeptMessageSchema content: string | blocks[]) and is folded
	// into `content` by MarshalJSON.
	Content       string             `json:"content"`
	ContentBlocks []map[string]any   `json:"-"`
	ToolUses      []ToolUseRecord    `json:"tool_uses,omitempty"`
	ToolResults   []ToolResultRecord `json:"tool_results,omitempty"`
}

// UnmarshalJSON tolerates the TS KeptMessageSchema shape where `content` may be
// an array of content blocks; the array is flattened to text AND preserved in
// ContentBlocks so a TS-written boundary replays with its blocks intact.
func (k *KeepMessage) UnmarshalJSON(data []byte) error {
	var raw struct {
		Role        string             `json:"role"`
		Content     json.RawMessage    `json:"content"`
		ToolUses    []ToolUseRecord    `json:"tool_uses"`
		ToolResults []ToolResultRecord `json:"tool_results"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	text, blocks, err := decodeContent(raw.Content)
	if err != nil {
		return err
	}
	*k = KeepMessage{
		Role:          raw.Role,
		Content:       text,
		ContentBlocks: blocks,
		ToolUses:      raw.ToolUses,
		ToolResults:   raw.ToolResults,
	}
	return nil
}

// MarshalJSON writes `content` as the block array when the kept message
// carries structured content, matching the TS on-disk union shape.
func (k KeepMessage) MarshalJSON() ([]byte, error) {
	type keepAlias struct {
		Role        string             `json:"role"`
		Content     any                `json:"content"`
		ToolUses    []ToolUseRecord    `json:"tool_uses,omitempty"`
		ToolResults []ToolResultRecord `json:"tool_results,omitempty"`
	}
	var content any = k.Content
	if len(k.ContentBlocks) > 0 {
		content = k.ContentBlocks
	}
	return marshalNoEscape(keepAlias{
		Role:        k.Role,
		Content:     content,
		ToolUses:    k.ToolUses,
		ToolResults: k.ToolResults,
	})
}

// ToConversation restores a kept record into an in-memory conversation message.
func (k KeepMessage) ToConversation() conversation.Message {
	msg := conversation.Message{
		Role:          k.Role,
		Content:       k.Content,
		ContentBlocks: k.ContentBlocks,
	}
	for _, tu := range k.ToolUses {
		msg.ToolUses = append(msg.ToolUses, conversation.ToolUseBlock{
			ToolUseID:      tu.ToolUseID,
			ToolName:       tu.ToolName,
			Arguments:      tu.Arguments,
			ProviderItemID: tu.ProviderItemID,
		})
	}
	for _, tr := range k.ToolResults {
		msg.ToolResults = append(msg.ToolResults, conversation.ToolResultBlock{
			ToolUseID:     tr.ToolUseID,
			Content:       tr.Content,
			ContentBlocks: tr.ContentBlocks,
			IsError:       tr.IsError,
		})
	}
	return msg
}

// FromConversationKeep converts a kept tail message into its on-disk form.
func FromConversationKeep(msg conversation.Message) KeepMessage {
	rec := FromConversation(msg)
	return KeepMessage{
		Role:          rec.Role,
		Content:       rec.Content,
		ContentBlocks: rec.ContentBlocks,
		ToolUses:      rec.ToolUses,
		ToolResults:   rec.ToolResults,
	}
}

// CompactBoundary is the structured payload stored (as JSON) in the Content of a
// TypeCompactBoundary record. Summary is the LLM-produced summary of the
// older prefix; Keep is the recent tail that was kept verbatim. On resume the
// compacted state is rebuilt as: [user message = Summary] + Keep + any plain
// messages appended after the boundary.
type CompactBoundary struct {
	Summary string        `json:"summary"`
	Keep    []KeepMessage `json:"keep"`
}

// SaveCompactBoundary appends a compaction boundary record to the session log.
// The boundary is append-only: the original prefix messages stay in the file but
// are not replayed on resume (see FindLastCompactBoundary). The summary + keep
// are inlined into the record's Content as a CompactBoundary JSON blob.
func SaveCompactBoundary(workDir, sessionID, summary string, keep []KeepMessage) {
	blob, err := marshalNoEscape(CompactBoundary{Summary: summary, Keep: keep})
	if err != nil {
		return
	}
	SaveMessage(workDir, sessionID, Message{
		Role:    "system",
		Type:    TypeCompactBoundary,
		Content: string(blob),
		Ts:      time.Now().Unix(),
	})
}

// FindLastCompactBoundary scans the loaded records for the last usable
// compaction boundary. It returns the parsed boundary, the slice of plain
// messages appended after that boundary, and ok=true when one was found. When
// no usable boundary exists (ok=false) the caller should replay all records
// verbatim (backward-compatible: old sessions have no boundary records).
//
// A damaged boundary must not discard the only recoverable history: like the TS
// rebuildFromSession, the scan walks backwards and accepts the last boundary
// that both parses AND carries a non-empty summary, so a corrupt or empty
// trailing boundary falls back to the previous valid one instead of replaying
// the entire already-compacted prefix.
func FindLastCompactBoundary(msgs []Message) (boundary CompactBoundary, after []Message, ok bool) {
	last := -1
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Type != TypeCompactBoundary {
			continue
		}
		var parsed CompactBoundary
		if err := json.Unmarshal([]byte(msgs[i].Content), &parsed); err != nil {
			continue // damaged boundary blob; try the previous one
		}
		if strings.TrimSpace(parsed.Summary) == "" {
			continue // a boundary without a summary recovers nothing; skip it
		}
		boundary = parsed
		last = i
		break
	}
	if last < 0 {
		return CompactBoundary{}, nil, false
	}
	for _, m := range msgs[last+1:] {
		if m.Type == TypeCompactBoundary {
			continue // defensive; the backward scan already located the last usable one
		}
		after = append(after, m)
	}
	return boundary, after, true
}

// RebuildFromSession rebuilds the conversation to replay on resume, honoring
// compaction boundaries (TS: rebuildFromSession). When a usable boundary
// exists the result is [summary user message] + its inlined keep tail + the
// ordinary messages appended after it; otherwise every ordinary message is
// replayed verbatim. buildSummary renders the summary user message — TS calls
// buildCompactionSummaryMessage(summary, keep.length > 0) from compact/prompts;
// Go injects it because session cannot import compact (compact imports
// session, and Go forbids the resulting cycle).
func RebuildFromSession(saved []Message, buildSummary func(summary string, hasKeep bool) string) []conversation.Message {
	var out []conversation.Message

	if boundary, after, ok := FindLastCompactBoundary(saved); ok {
		out = append(out, conversation.Message{
			Role:    "user",
			Content: buildSummary(boundary.Summary, len(boundary.Keep) > 0),
		})
		for _, k := range boundary.Keep {
			if k.Role != "user" && k.Role != "assistant" {
				continue
			}
			if keepMessageIsEmpty(k) {
				continue
			}
			out = append(out, k.ToConversation())
		}
		for _, m := range after {
			if r := toRestored(m); r != nil {
				out = append(out, *r)
			}
		}
		return out
	}

	// No boundary → full replay (backward compatible).
	for _, m := range saved {
		if m.Type == TypeCompactBoundary {
			continue
		}
		if r := toRestored(m); r != nil {
			out = append(out, *r)
		}
	}
	return out
}

// toRestored restores a single persisted record into a replayable message
// (TS: toRestored). Messages containing only tool results have no text but
// must still be restored, otherwise the call chain breaks.
func toRestored(m Message) *conversation.Message {
	if m.Role != "user" && m.Role != "assistant" {
		return nil
	}
	if messageIsEmpty(m) {
		return nil
	}
	restored := m.ToConversation()
	return &restored
}

type SessionInfo struct {
	ID           string
	FirstMessage string
	MessageCount int
	FileSize     int64
	GitBranch    string
	ModTime      time.Time
}

// NewID returns a session id shaped like the TS one: the millisecond clock in
// base36 plus 4 random bytes as hex (TS: newSessionId, session/index.ts:170-174).
// Equal-length, collision-resistant and lexically ordered by creation time.
func NewID() string {
	var b [4]byte
	ts := strconv.FormatInt(time.Now().UnixMilli(), 36)
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand rarely fails; fall back to the nanosecond clock, which
		// still avoids collisions within the same millisecond and process.
		return fmt.Sprintf("%s-%08x", ts, time.Now().UnixNano()&0xFFFFFFFF)
	}
	return ts + "-" + hex.EncodeToString(b[:])
}

func sessionsDir(workDir string) string {
	return filepath.Join(workDir, ".yukino", "sessions")
}

func SessionFilePath(workDir, id string) string {
	return filepath.Join(sessionsDir(workDir), id+".jsonl")
}

// SaveMessage appends one record to the session log (TS: saveMessage —
// JSON.stringify(msg) + "\n", no HTML escaping). TS lets mkdir/write failures
// throw to the caller; the Go signature is frozen (callers live outside this
// package), so failures are silently dropped — a documented residual.
func SaveMessage(workDir, sessionID string, msg Message) {
	dir := sessionsDir(workDir)
	os.MkdirAll(dir, 0o755)

	f, err := os.OpenFile(SessionFilePath(workDir, sessionID), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()

	data, err := marshalNoEscape(msg)
	if err != nil {
		return
	}
	f.Write(data)
	f.Write([]byte("\n"))
}

func LoadSession(workDir, sessionID string) []Message {
	// TS loadSession lets a read failure of an existing file throw to the
	// caller; the frozen Go signature swallows it (documented residual). A
	// missing file is an empty session in both.
	msgs, _, _ := loadSessionWithCount(workDir, sessionID)
	return msgs
}

// loadSessionWithCount mirrors the TS loadSession/listSessions split: every
// line is validated against the TS SessionMessageSchema (including the nested
// ToolUseRecordSchema/ToolResultRecordSchema), with `session operation failed`
// logged for each malformed line exactly like the TS log.error sites. The
// returned slice skips messages without content or tool blocks (loadSession),
// while the count covers every record that passes the schema, incremented
// before any emptiness check (listSessions messageCount). The third result is
// a read failure of an existing file (TS: readFileSync throws).
func loadSessionWithCount(workDir, sessionID string) ([]Message, int, error) {
	path := SessionFilePath(workDir, sessionID)
	if _, err := os.Stat(path); err != nil {
		return nil, 0, nil // TS existsSync guard: a missing file is empty
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()

	var msgs []Message
	count := 0
	// bufio.Reader instead of bufio.Scanner: Scanner enforces a maximum token
	// size, so a single over-long line would abort the scan and silently drop
	// every message after it. TS readFileSync has no line-length limit.
	reader := bufio.NewReader(f)
	for {
		line, readErr := reader.ReadString('\n')
		if strings.TrimSpace(line) != "" {
			// TS: a JSON.parse failure and a schema violation each log
			// `session operation failed` once and skip the line (both
			// loadSession and listSessions do this).
			var doc map[string]json.RawMessage
			if err := json.Unmarshal([]byte(line), &doc); err != nil {
				log.Error("session operation failed", "err", err)
			} else if err := validateSessionMessage(doc); err != nil {
				log.Error("session operation failed", "err", err)
			} else {
				count++
				// A message carrying only tool results has no text content of
				// its own; it must not be filtered by whether Content is
				// empty, or the entire tool round-trip would be dropped when
				// the session is restored. TS checks the content union: an
				// array of blocks counts as non-empty even when it flattens
				// to no text.
				var msg Message
				if json.Unmarshal([]byte(line), &msg) == nil && !messageIsEmpty(msg) {
					msgs = append(msgs, msg)
				}
			}
		}
		if readErr != nil {
			// io.EOF: the final unterminated line (if any) was already handled
			// above. Any other read error stops the load like TS's throw.
			break
		}
	}
	return msgs, count, nil
}

// validateSessionMessage applies the TS SessionMessageSchema to one parsed
// JSONL record: role (string) and timestamp (number) are required; content
// defaults to "" and is a string-or-blocks union; type is an optional string;
// tool_uses/tool_results are optional arrays whose records carry their own
// required keys. Zod's optional fields reject explicit null, unknown keys are
// ignored (stripped), and the error wording is a Go phrase (the zod issue dump
// is not reproducible — a documented residual).
func validateSessionMessage(doc map[string]json.RawMessage) error {
	if k := jsonKindOf(doc["role"]); k != kindString {
		return fmt.Errorf("role: expected string, received %s", k)
	}
	if k := jsonKindOf(doc["timestamp"]); k != kindNumber {
		return fmt.Errorf("timestamp: expected number, received %s", k)
	}
	if raw, present := doc["content"]; present {
		if err := validateContentUnion(raw, "content"); err != nil {
			return err
		}
	}
	if raw, present := doc["type"]; present {
		if k := jsonKindOf(raw); k != kindString {
			return fmt.Errorf("type: expected string, received %s", k)
		}
	}
	if raw, present := doc["tool_uses"]; present {
		if jsonKindOf(raw) != kindArray {
			return fmt.Errorf("tool_uses: expected array, received %s", jsonKindOf(raw))
		}
		items, _ := jsonArray(raw)
		for i, item := range items {
			rec, ok := jsonObject(item)
			if !ok {
				return fmt.Errorf("tool_uses[%d]: expected object, received %s", i, jsonKindOf(item))
			}
			if k := jsonKindOf(rec["tool_use_id"]); k != kindString {
				return fmt.Errorf("tool_uses[%d].tool_use_id: expected string, received %s", i, k)
			}
			if k := jsonKindOf(rec["tool_name"]); k != kindString {
				return fmt.Errorf("tool_uses[%d].tool_name: expected string, received %s", i, k)
			}
			if a, present := rec["arguments"]; present {
				if k := jsonKindOf(a); k != kindObject {
					return fmt.Errorf("tool_uses[%d].arguments: expected object, received %s", i, k)
				}
			}
			if p, present := rec["provider_item_id"]; present {
				if k := jsonKindOf(p); k != kindString {
					return fmt.Errorf("tool_uses[%d].provider_item_id: expected string, received %s", i, k)
				}
			}
		}
	}
	if raw, present := doc["tool_results"]; present {
		if jsonKindOf(raw) != kindArray {
			return fmt.Errorf("tool_results: expected array, received %s", jsonKindOf(raw))
		}
		items, _ := jsonArray(raw)
		for i, item := range items {
			rec, ok := jsonObject(item)
			if !ok {
				return fmt.Errorf("tool_results[%d]: expected object, received %s", i, jsonKindOf(item))
			}
			if k := jsonKindOf(rec["tool_use_id"]); k != kindString {
				return fmt.Errorf("tool_results[%d].tool_use_id: expected string, received %s", i, k)
			}
			// ToolResultRecordSchema requires content (no default).
			contentRaw, present := rec["content"]
			if !present {
				return fmt.Errorf("tool_results[%d].content: required", i)
			}
			if err := validateContentUnion(contentRaw, fmt.Sprintf("tool_results[%d].content", i)); err != nil {
				return err
			}
			if cb, present := rec["content_blocks"]; present {
				if k := jsonKindOf(cb); k != kindArray {
					return fmt.Errorf("tool_results[%d].content_blocks: expected array, received %s", i, k)
				}
			}
			if ie, present := rec["is_error"]; present {
				if k := jsonKindOf(ie); k != kindBool {
					return fmt.Errorf("tool_results[%d].is_error: expected boolean, received %s", i, k)
				}
			}
		}
	}
	return nil
}

// validateContentUnion applies the TS ContentSchema: z.union([z.string(),
// z.array(z.record(z.string(), z.unknown()))]).
func validateContentUnion(raw json.RawMessage, path string) error {
	switch jsonKindOf(raw) {
	case kindString:
		return nil
	case kindArray:
		items, _ := jsonArray(raw)
		for i, item := range items {
			if k := jsonKindOf(item); k != kindObject {
				return fmt.Errorf("%s[%d]: expected object, received %s", path, i, k)
			}
		}
		return nil
	}
	return fmt.Errorf("%s: expected string or array, received %s", path, jsonKindOf(raw))
}

type jsonKind string

const (
	kindUndefined jsonKind = "undefined"
	kindNull      jsonKind = "null"
	kindBool      jsonKind = "boolean"
	kindNumber    jsonKind = "number"
	kindString    jsonKind = "string"
	kindArray     jsonKind = "array"
	kindObject    jsonKind = "object"
	kindInvalid   jsonKind = "invalid"
)

// jsonKindOf classifies a raw JSON value; a missing key (nil RawMessage) is
// `undefined`, mirroring an absent TS object property.
func jsonKindOf(raw json.RawMessage) jsonKind {
	if len(raw) == 0 {
		return kindUndefined
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return kindInvalid
	}
	switch v.(type) {
	case nil:
		return kindNull
	case bool:
		return kindBool
	case float64:
		return kindNumber
	case string:
		return kindString
	case []any:
		return kindArray
	case map[string]any:
		return kindObject
	}
	return kindInvalid
}

func jsonArray(raw json.RawMessage) ([]json.RawMessage, bool) {
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, false
	}
	return items, true
}

func jsonObject(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	if jsonKindOf(raw) != kindObject {
		return nil, false
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, false
	}
	return obj, true
}

// messageIsEmpty mirrors the TS emptiness check: `content.length === 0` on the
// string|blocks union plus no tool uses and no tool results.
func messageIsEmpty(m Message) bool {
	return m.Content == "" && len(m.ContentBlocks) == 0 &&
		len(m.ToolUses) == 0 && len(m.ToolResults) == 0
}

// keepMessageIsEmpty is messageIsEmpty for the kept-tail record shape (TS
// rebuildFromSession applies the same union-aware check to kept messages).
func keepMessageIsEmpty(k KeepMessage) bool {
	return k.Content == "" && len(k.ContentBlocks) == 0 &&
		len(k.ToolUses) == 0 && len(k.ToolResults) == 0
}

// maxSessionAgeDays is the maximum retention period for sessions; sessions older
// than this are cleaned up automatically.
const maxSessionAgeDays = 30

// sweptSessionDirs tracks the session directories already swept in this
// process. Expired-session cleanup piggybacks on the first ListSessions call
// per directory (TS: sweptSessionDirs), so every entry mode gets a sweep
// without separate startup wiring.
var (
	sweptMu   sync.Mutex
	sweptDirs = map[string]bool{}
)

func ListSessions(workDir string) []SessionInfo {
	dir := sessionsDir(workDir)
	sweptMu.Lock()
	firstSweep := !sweptDirs[dir]
	sweptDirs[dir] = true
	sweptMu.Unlock()
	if firstSweep {
		CleanExpiredSessions(workDir)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	branch := currentGitBranch(workDir)

	var sessions []SessionInfo
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".jsonl")
		info, err := e.Info()
		if err != nil {
			continue
		}

		msgs, count, readErr := loadSessionWithCount(workDir, id)
		if readErr != nil {
			// TS listSessions' per-file catch logs and skips the entry.
			log.Error("session operation failed", "err", readErr)
			continue
		}
		first := ""
		for _, msg := range msgs {
			// Label the session by its first non-empty user message, truncated
			// to 100 UTF-16 code units (TS listSessions slice(0, 100)).
			if msg.Role == "user" && msg.Content != "" {
				first = utils.TruncateUTF16(msg.Content, 100)
				break
			}
		}

		sessions = append(sessions, SessionInfo{
			ID:           id,
			FirstMessage: first,
			MessageCount: count,
			FileSize:     info.Size(),
			GitBranch:    branch,
			ModTime:      info.ModTime(),
		})
	}

	// Stable, like Array.prototype.sort: equal mtimes keep the directory read
	// order instead of an arbitrary permutation.
	sort.SliceStable(sessions, func(i, j int) bool {
		return sessions[i].ModTime.After(sessions[j].ModTime)
	})

	return sessions
}

func currentGitBranch(dir string) string {
	cmd := exec.Command("git", "rev-parse", "--abbrev-ref", "HEAD")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
