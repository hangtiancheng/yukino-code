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

package tools

import (
	"strings"
	"unicode/utf8"
)

// decodeUTF8Lenient converts raw bytes to a string exactly the way Node does
// (Buffer.toString("utf-8") / readFileSync(…, "utf-8")), i.e. the WHATWG
// encoding spec's UTF-8 decoder
// (https://encoding.spec.whatwg.org/#utf-8-decoder): every maximal invalid
// subpart yields ONE U+FFFD. strings.ToValidUTF8 is not equivalent — it
// collapses a whole run of invalid bytes into a single replacement, where the
// spec emits one per subpart (e.g. ED A0 80 decodes to 3× U+FFFD because each
// byte fails on its own).
//
// The decoder mirrors the spec's state machine: a lead byte defines how many
// continuation bytes follow and the legal range of the first one; when a byte
// falls outside that range (or input ends mid-sequence) the bytes consumed so
// far form one maximal subpart (→ U+FFFD) and the offending byte is
// reprocessed as a lead.
func decodeUTF8Lenient(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	sb.Grow(len(b) + utf8.UTFMax)
	for i := 0; i < len(b); {
		c := b[i]
		if c < utf8.RuneSelf {
			sb.WriteByte(c)
			i++
			continue
		}
		// WHATWG "UTF-8 decode": lead byte → (needed continuation bytes,
		// lower/upper bound of the FIRST continuation byte).
		var count, lower, upper int
		switch {
		case c >= 0xC2 && c <= 0xDF:
			count, lower, upper = 1, 0x80, 0xBF
		case c == 0xE0:
			count, lower, upper = 2, 0xA0, 0xBF
		case c >= 0xE1 && c <= 0xEC:
			count, lower, upper = 2, 0x80, 0xBF
		case c == 0xED:
			count, lower, upper = 2, 0x80, 0x9F
		case c >= 0xEE && c <= 0xEF:
			count, lower, upper = 2, 0x80, 0xBF
		case c == 0xF0:
			count, lower, upper = 3, 0x90, 0xBF
		case c >= 0xF1 && c <= 0xF3:
			count, lower, upper = 3, 0x80, 0xBF
		case c == 0xF4:
			count, lower, upper = 3, 0x80, 0x8F
		default:
			// 0x80-0xC1 (stray continuation / overlong lead) or 0xF5-0xFF:
			// a single-byte maximal subpart.
			sb.WriteString("\uFFFD")
			i++
			continue
		}
		cp := int(c & (0x3F >> count))
		j := i + 1
		complete := true
		for k := 0; k < count; k++ {
			if j >= len(b) {
				// EOF mid-sequence: the accumulated prefix is the maximal
				// subpart (one U+FFFD for the whole thing).
				complete = false
				break
			}
			lo, hi := lower, upper
			if k > 0 {
				lo, hi = 0x80, 0xBF
			}
			if b[j] < byte(lo) || b[j] > byte(hi) {
				complete = false
				break
			}
			cp = cp<<6 | int(b[j]&0x3F)
			j++
		}
		if complete && j-i == count+1 {
			sb.WriteRune(rune(cp))
			i = j
			continue
		}
		// Invalid: one U+FFFD for the maximal subpart (lead + the valid
		// continuation prefix); j points at the offending byte (or EOF), which
		// the outer loop reprocesses as a lead byte — exactly the spec's
		// "prepend bytes consumed so far to stream" step.
		sb.WriteString("\uFFFD")
		i = j
	}
	return sb.String()
}
