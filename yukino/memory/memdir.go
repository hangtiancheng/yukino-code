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
	"bytes"
	"fmt"
	"math/big"

	"github.com/hangtiancheng/yukino-code/yukino/utils"
)

// Caps for the memory index content: 200 lines or 25KB, whichever is hit
// first (TS manager.ts:46-49).
const (
	MaxEntrypointLines = 200
	MaxEntrypointBytes = 25_000
)

// capEntrypoint truncates index content to fit within the byte limit
// (TS manager.ts:51-77).
//
// Preferably cuts at the last newline before the limit so that only complete
// entries are retained. In UTF-8, ASCII bytes never appear inside multi-byte
// sequences, so scanning for a newline at the byte level is safe. When no
// newline exists in the entire segment, we hard-cut at the byte limit and
// then back up to a character boundary; otherwise a multi-byte character
// split in half would decode to a replacement character.
func capEntrypoint(content string) string {
	buf := []byte(content)
	if len(buf) <= MaxEntrypointBytes {
		return content
	}

	nl := bytes.LastIndexByte(buf[:MaxEntrypointBytes], '\n')
	if nl > 0 {
		return string(buf[:nl])
	}

	end := MaxEntrypointBytes
	// UTF-8 continuation bytes always have the top two bits set to 10; skip
	// backward past them to land on a character boundary.
	for end > 0 && buf[end]&0xC0 == 0x80 {
		end--
	}
	return string(buf[:end])
}

// formatFileSize mirrors the TS formatFileSize (manager.ts:79-87). toFixed(1)
// picks the larger of two equidistant tenths per ECMA-262, while Go's %.1f
// rounds exact ties half-to-even; the arithmetic is done in exact rationals
// instead (the same approach images.formatMB uses). The divisors are powers
// of two, so the TS float64 divisions are exact and the rational value is
// precisely what toFixed sees.
func formatFileSize(size int) string {
	switch {
	case size < 1024:
		return fmt.Sprintf("%dB", size)
	case size < 1024*1024:
		return formatSizeTenths(int64(size), 1024) + "KB"
	default:
		return formatSizeTenths(int64(size), 1024*1024) + "MB"
	}
}

// formatSizeTenths renders size/denom with one decimal digit, rounding an
// exact .05 tie up like toFixed(1).
func formatSizeTenths(size, denom int64) string {
	return utils.RatFixed1(big.NewRat(size, denom))
}

// LoadAutoMemoryPrompt is the convenience entrypoint used by the conversation
// injection path: it returns the memory index reminder for the project (TS
// remote/server.ts: `new MemoryManager(workDir).buildSystemReminder()`).
func LoadAutoMemoryPrompt(projectRoot string) string {
	return NewManager(projectRoot).BuildSystemReminder()
}
