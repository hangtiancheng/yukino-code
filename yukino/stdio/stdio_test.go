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

package stdio

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestReadLineFraming(t *testing.T) {
	in := "one\ntwo\r\nthree" // the last line is unterminated (EOF)
	r := bufio.NewReader(strings.NewReader(in))

	line, oversized, err := readLine(r, maxLineLen)
	if err != nil || oversized || string(line) != "one" {
		t.Fatalf("first line = %q, %v, %v", line, oversized, err)
	}
	line, oversized, err = readLine(r, maxLineLen)
	if err != nil || oversized || string(line) != "two" {
		t.Fatalf("CRLF line = %q, %v, %v", line, oversized, err)
	}
	// A final unterminated line is delivered before the EOF surfaces.
	line, oversized, err = readLine(r, maxLineLen)
	if err != nil || oversized || string(line) != "three" {
		t.Fatalf("unterminated line = %q, %v, %v", line, oversized, err)
	}
	if _, _, err = readLine(r, maxLineLen); !errors.Is(err, io.EOF) {
		t.Fatalf("stream end = %v, want io.EOF", err)
	}
}

func TestReadLineOversizedDiscardsAndResynchronizes(t *testing.T) {
	// An oversized message is dropped, reported, and the NEXT line still
	// serves — one bad client message must not kill the bridge (the old
	// bufio.Scanner framing exited silently here).
	huge := strings.Repeat("x", 50)
	in := huge + "\nnext\n"
	r := bufio.NewReaderSize(strings.NewReader(in), 8) // force multi-chunk reads

	line, oversized, err := readLine(r, 10)
	if err != nil {
		t.Fatalf("oversized line returned err %v", err)
	}
	if !oversized || len(line) != 0 {
		t.Fatalf("oversized = %v, line = %q", oversized, line)
	}
	line, oversized, err = readLine(r, 10)
	if err != nil || oversized || string(line) != "next" {
		t.Fatalf("resynchronized line = %q, %v, %v", line, oversized, err)
	}
}

func TestReadLineExactCapKept(t *testing.T) {
	in := bytes.Repeat([]byte("y"), 10)
	r := bufio.NewReaderSize(bytes.NewReader(append(in, '\n')), 4)
	line, oversized, err := readLine(r, 10)
	if err != nil || oversized || len(line) != 10 {
		t.Fatalf("exact-cap line = %d bytes, %v, %v", len(line), oversized, err)
	}
}
