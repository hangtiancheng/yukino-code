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

import "unicode/utf8"

// MaxShellOutputBytes is the foreground shell output cap: a command producing
// more than this is terminated and its result marked truncated.
const MaxShellOutputBytes = 10 * 1024 * 1024

// takeUtf8Prefix returns a UTF-8-safe prefix of value whose encoded size does
// not exceed maxBytes.
func takeUtf8Prefix(value string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(value) <= maxBytes {
		return value
	}
	used := 0
	for used < len(value) {
		_, size := utf8.DecodeRuneInString(value[used:])
		if used+size > maxBytes {
			break
		}
		used += size
	}
	return value[:used]
}

// formatShellOutput renders the shell transcript: prompt marker, command, then
// the captured streams, plus a truncation notice when the output was capped.
func formatShellOutput(prompt, command, stdout, stderr string, truncated bool) string {
	output := prompt + command + "\n"
	output += stdout
	output += stderr
	if truncated {
		output += "\n\n[Output truncated after 10 MB]"
	}
	return output
}
