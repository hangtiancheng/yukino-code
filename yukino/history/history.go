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

// Package history persists the prompt input history as JSONL. Port of
// src/history/index.ts from the TypeScript reference implementation.
package history

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/hangtiancheng/yukino-code/yukino/logger"
)

// MaxHistoryEntries bounds both the returned list and the on-disk file.
const MaxHistoryEntries = 200

const filename = "prompt_history.jsonl"

var log = logger.CreateChildLogger("history")

// entry is one JSONL line: {"text": "..."}. Extra keys are tolerated on
// read, mirroring the TS z.looseObject schema.
type entry struct {
	Text string `json:"text"`
}

// Load reads the history stored under dir, skipping malformed or empty
// entries and keeping only the most recent MaxHistoryEntries. A missing
// file yields an empty list.
func Load(dir string) []string {
	content, err := os.ReadFile(filepath.Join(dir, filename))
	if err != nil {
		if !os.IsNotExist(err) {
			log.Error("load history failed", "err", err)
		}
		return []string{}
	}
	entries := []string{}
	for _, line := range strings.Split(strings.TrimSpace(string(content)), "\n") {
		if line == "" {
			continue
		}
		// TS: parse(z.looseObject({text: z.string()}), JSON.parse(line)) fails —
		// and logs — for any line that is not an object with a string `text`,
		// including `{}` and `null`, which a struct decode would silently accept.
		var raw any
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			log.Error("parse history line failed", "err", err)
			continue
		}
		obj, ok := raw.(map[string]any)
		if !ok {
			log.Error("parse history line failed", "err", "expected an object")
			continue
		}
		textVal, present := obj["text"]
		text, isStr := textVal.(string)
		if !present || !isStr {
			log.Error("parse history line failed", "err", "text must be a string")
			continue
		}
		// A successfully-parsed empty text is dropped by the TS filter(Boolean)
		// without logging.
		if text == "" {
			continue
		}
		entries = append(entries, text)
	}
	if len(entries) > MaxHistoryEntries {
		entries = entries[len(entries)-MaxHistoryEntries:]
	}
	return entries
}

// Append adds text to the history (unless it duplicates the latest entry),
// rewrites the file bounded to MaxHistoryEntries, and returns the retained
// entries.
func Append(dir, text string) []string {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Error("create history dir failed", "err", err)
		return []string{}
	}
	entries := Load(dir)
	if len(entries) == 0 || entries[len(entries)-1] != text {
		entries = append(entries, text)
	}
	if len(entries) > MaxHistoryEntries {
		entries = entries[len(entries)-MaxHistoryEntries:]
	}
	var b strings.Builder
	for _, e := range entries {
		line, err := json.Marshal(entry{Text: e})
		if err != nil {
			continue // cannot happen for plain strings
		}
		b.Write(line)
		b.WriteByte('\n')
	}
	if err := os.WriteFile(filepath.Join(dir, filename), []byte(b.String()), 0o644); err != nil {
		log.Error("write history failed", "err", err)
	}
	return entries
}
