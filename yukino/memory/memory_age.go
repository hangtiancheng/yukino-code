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

package memory

import (
	"fmt"
	"time"
)

// MemoryAgeDays returns days elapsed since mtime. Floor-rounded — 0 for
// today, 1 for yesterday, 2+ for older. Negative inputs (future mtime,
// clock skew) clamp to 0.
func MemoryAgeDays(mtimeMs int64) int {
	d := (time.Now().UnixMilli() - mtimeMs) / 86_400_000
	if d < 0 {
		return 0
	}
	return int(d)
}

// MemoryAge returns a human-readable age string. Models are poor at
// date arithmetic — a raw ISO timestamp doesn't trigger staleness
// reasoning the way "47 days ago" does.
func MemoryAge(mtimeMs int64) string {
	d := MemoryAgeDays(mtimeMs)
	if d == 0 {
		return "today"
	}
	if d == 1 {
		return "yesterday"
	}
	return fmt.Sprintf("%d days ago", d)
}

// MemoryFreshnessText returns a plain-text staleness caveat for memories
// >1 day old (TS memory-age.ts:43-49). Returns "" for fresh
// (today/yesterday) memories — warning there is noise.
//
// Use this when the consumer already provides its own wrapping (e.g.
// RenderReminder → AddSystemReminder).
//
// Motivated by user reports of stale code-state memories (file:line
// citations to code that has since changed) being asserted as fact —
// the citation makes the stale claim sound more authoritative, not less.
func MemoryFreshnessText(mtimeMs int64) string {
	d := MemoryAgeDays(mtimeMs)
	if d <= 1 {
		return ""
	}
	return fmt.Sprintf(
		"Saved %d days ago; not live state. "+
			"Code behavior and file:line citations may be stale. "+
			"Verify against current code before asserting facts.",
		d,
	)
}
