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

package commands

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/logger"
)

var log = logger.CreateChildLogger("commands")

// usageEntry mirrors the TS UsageEntrySchema fields. Both are plain numbers
// (z.coerce.number()); Go stores them as float64 so a fractional persisted
// value loads instead of failing the entry.
type usageEntry struct {
	UsageCount float64 `json:"usageCount"`
	LastUsedAt float64 `json:"lastUsedAt"`
}

// UsageTracker records slash-command usage in .yukino/command_usage.json and
// scores commands by frequency with exponential recency decay, so recently
// used commands surface first in pickers.
type UsageTracker struct {
	usage map[string]usageEntry
	// order preserves the first-use insertion order (TS: the usage Map).
	order    []string
	filePath string
}

func NewUsageTracker(workDir string) *UsageTracker {
	dir := filepath.Join(workDir, ".yukino")
	_ = os.MkdirAll(dir, 0o755)
	t := &UsageTracker{
		usage:    make(map[string]usageEntry),
		filePath: filepath.Join(dir, "command_usage.json"),
	}
	t.load()
	return t
}

func (t *UsageTracker) Record(name string) {
	entry := t.usage[name]
	entry.UsageCount++
	entry.LastUsedAt = float64(time.Now().UnixMilli())
	if _, seen := t.usage[name]; !seen {
		// Map.set keeps the original position for existing keys (TS).
		t.order = append(t.order, name)
	}
	t.usage[name] = entry
	t.save()
}

// GetScore returns usageCount weighted by recency: half-life of 7 days,
// floored at 0.1 so old but frequent commands keep some weight.
func (t *UsageTracker) GetScore(name string) float64 {
	entry, ok := t.usage[name]
	if !ok {
		return 0
	}
	daysSince := (float64(time.Now().UnixMilli()) - entry.LastUsedAt) / (1000 * 60 * 60 * 24)
	recency := math.Pow(0.5, daysSince/7)
	return entry.UsageCount * math.Max(recency, 0.1)
}

func (t *UsageTracker) GetRecentlyUsed(limit int) []string {
	if limit <= 0 {
		limit = 5
	}
	type scored struct {
		name  string
		score float64
	}
	var entries []scored
	for _, name := range t.order {
		if s := t.GetScore(name); s > 0 {
			entries = append(entries, scored{name, s})
		}
	}
	// TS sorts by score descending only; Array.prototype.sort is stable, so
	// equal scores keep the insertion order (no name tie-break).
	sort.SliceStable(entries, func(i, j int) bool {
		return entries[i].score > entries[j].score
	})
	if len(entries) > limit {
		entries = entries[:limit]
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.name)
	}
	return names
}

// load mirrors the TS load(): a missing or unreadable file and a non-object
// document are silent; each entry is validated independently (TS zod
// safeParse per entry) and an invalid entry is skipped without discarding the
// rest. Keys are kept in document order (TS Object.entries order — the
// integer-keys-first enumeration edge is not reproduced). The TS catch block
// is silent (its log.error is commented out), so load failures are not logged.
func (t *UsageTracker) load() {
	raw, err := os.ReadFile(t.filePath)
	if err != nil {
		return // file doesn't exist yet
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return // not valid JSON, or not an object (TS isRecord guard)
	}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return
		}
		name, ok := keyTok.(string)
		if !ok {
			return
		}
		var entryRaw json.RawMessage
		if err := dec.Decode(&entryRaw); err != nil {
			return
		}
		entry, valid := parseUsageEntry(entryRaw)
		if !valid {
			continue // TS: safeParse failure skips the entry
		}
		if _, seen := t.usage[name]; !seen {
			t.order = append(t.order, name)
		}
		t.usage[name] = entry
	}
}

// parseUsageEntry applies the TS UsageEntrySchema per entry: both fields must
// be present and numeric (zod's string-to-number coercion is not reproduced —
// a documented residual). Unknown keys are ignored like zod's object strip.
func parseUsageEntry(raw json.RawMessage) (usageEntry, bool) {
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		return usageEntry{}, false
	}
	usageCountRaw, hasCount := doc["usageCount"]
	lastUsedAtRaw, hasLast := doc["lastUsedAt"]
	if !hasCount || !hasLast {
		return usageEntry{}, false
	}
	var entry usageEntry
	if err := json.Unmarshal(usageCountRaw, &entry.UsageCount); err != nil {
		return usageEntry{}, false
	}
	if err := json.Unmarshal(lastUsedAtRaw, &entry.LastUsedAt); err != nil {
		return usageEntry{}, false
	}
	return entry, true
}

// save mirrors the TS save(): JSON.stringify(Object.fromEntries(this.usage),
// null, 2) — Map insertion order, two-space indent, and no HTML escaping
// (JSON.stringify keeps `<`/`>`/`&` literal). mkdir and write failures are
// logged and ignored.
func (t *UsageTracker) save() {
	if err := os.MkdirAll(filepath.Dir(t.filePath), 0o755); err != nil {
		log.Error("commands operation failed", "err", err)
		return
	}
	raw, err := t.marshalJSON()
	if err != nil {
		log.Error("commands operation failed", "err", err)
		return
	}
	if err := os.WriteFile(t.filePath, raw, 0o644); err != nil {
		// TS save()'s catch logs and ignores write errors
		// (usage-tracker.ts:99-110).
		log.Error("commands operation failed", "err", err)
	}
}

// marshalJSON renders the persisted document: keys in first-use order,
// two-space indent, entries shaped as {"usageCount": N, "lastUsedAt": N}.
func (t *UsageTracker) marshalJSON() ([]byte, error) {
	if len(t.order) == 0 {
		return []byte("{}"), nil
	}
	var sb strings.Builder
	sb.WriteString("{\n")
	for i, name := range t.order {
		key, err := jsonStringNoEscape(name)
		if err != nil {
			return nil, err
		}
		entry, err := json.MarshalIndent(t.usage[name], "  ", "  ")
		if err != nil {
			return nil, err
		}
		fmt.Fprintf(&sb, "  %s: %s", key, entry)
		if i < len(t.order)-1 {
			sb.WriteString(",")
		}
		sb.WriteString("\n")
	}
	sb.WriteString("}")
	return []byte(sb.String()), nil
}

// jsonStringNoEscape JSON-encodes a string without HTML escaping (the Go
// encoder's default would expand `<`/`>`/`&`, which JSON.stringify does not).
func jsonStringNoEscape(s string) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(s); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buf.String(), "\n"), nil
}
