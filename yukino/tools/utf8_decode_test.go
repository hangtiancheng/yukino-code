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
	"testing"
)

// The expected outputs are ground truth from Node's Buffer.from(bytes).toString("utf-8")
// (V8 implements the WHATWG maximal-subpart rule), not from strings.ToValidUTF8,
// which would collapse invalid runs into a single U+FFFD.
func TestDecodeUTF8Lenient(t *testing.T) {
	const fffd = "\uFFFD"
	cases := []struct {
		name string
		in   []byte
		want string
	}{
		{"valid ascii", []byte("hello"), "hello"},
		{"valid multibyte", []byte{0xC3, 0xA9, 0xF0, 0x9F, 0x98, 0x80}, "é😀"},
		{"boundary code point max", []byte{0xF4, 0x8F, 0xBF, 0xBF}, "\U0010FFFF"},
		{"lone stray continuation", []byte{0x80}, fffd},
		{"two stray continuations stay separate", []byte{0x80, 0x80}, fffd + fffd},
		{"overlong two-byte C0 80", []byte{0xC0, 0x80}, fffd + fffd},
		{"C1 lead is invalid", []byte{0xC1, 0xBF}, fffd + fffd},
		{"overlong three-byte E0 80 80", []byte{0xE0, 0x80, 0x80}, fffd + fffd + fffd},
		{"truncated two-byte at EOF", []byte{0xC2}, fffd},
		{"truncated three-byte lead only", []byte{0xE0}, fffd},
		{"truncated three-byte keeps valid prefix", []byte{0xE0, 0xA0}, fffd},
		{"truncated four-byte at EOF", []byte{0xF0, 0x9F, 0x98}, fffd},
		{"invalid first continuation E0 80", []byte{0xE0, 0x80}, fffd + fffd},
		{"surrogate half ED A0 80", []byte{0xED, 0xA0, 0x80}, fffd + fffd + fffd},
		{"surrogate low ED B0 80", []byte{0xED, 0xB0, 0x80}, fffd + fffd + fffd},
		{"F5 lead is invalid", []byte{0xF5, 0x80, 0x80, 0x80}, fffd + fffd + fffd + fffd},
		{"FF lead is invalid", []byte{0xFF}, fffd},
		{"overlong four-byte F0 80 80 80", []byte{0xF0, 0x80, 0x80, 0x80}, fffd + fffd + fffd + fffd},
		{"above U+10FFFF F4 90 80 80", []byte{0xF4, 0x90, 0x80, 0x80}, fffd + fffd + fffd + fffd},
		{
			"mixed valid and invalid",
			[]byte{0x61, 0xE0, 0x80, 0x62, 0xED, 0xA0, 0x80, 0xC3, 0xA9},
			"a" + fffd + fffd + "b" + fffd + fffd + fffd + "é",
		},
		{"valid then truncated at EOF", []byte("abc\xF0\x9F"), "abc" + fffd},
		{"invalid then valid continuation-like byte", []byte{0xF5, 0x41}, fffd + "A"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decodeUTF8Lenient(tc.in)
			if got != tc.want {
				t.Errorf("decodeUTF8Lenient(%x) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// Valid input must round-trip byte-identically (fast path).
func TestDecodeUTF8LenientValidPassthrough(t *testing.T) {
	in := "plain text with CJK 你好 and emoji 🎉\r\n\ttabs"
	if got := decodeUTF8Lenient([]byte(in)); got != in {
		t.Errorf("valid UTF-8 must pass through unchanged, got %q", got)
	}
}

// strings.ToValidUTF8 is the defective baseline: it collapses whole invalid
// runs into ONE U+FFFD. This test documents where the WHATWG decoder must
// disagree with it, guarding against a regression to ToValidUTF8.
func TestDecodeUTF8LenientDisagreesWithToValidUTF8(t *testing.T) {
	for _, in := range [][]byte{
		{0xED, 0xA0, 0x80},       // 3× U+FFFD vs 1×
		{0xF5, 0x80, 0x80, 0x80}, // 4× U+FFFD vs 1×
		{0x80, 0x80},             // 2× U+FFFD vs 1×
	} {
		got := decodeUTF8Lenient(in)
		collapsed := strings.ToValidUTF8(string(in), "\uFFFD")
		if got == collapsed {
			t.Errorf("decodeUTF8Lenient(%x) = %q must not collapse like ToValidUTF8", in, got)
		}
	}
}
