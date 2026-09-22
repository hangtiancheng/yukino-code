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

// Port of the TS tests/prompt-contracts.test.ts tool-description section:
// the descriptions document Yukino's own parameters and limits.

func TestToolDescriptionContracts(t *testing.T) {
	for _, text := range []string{
		"0-based",
		"offset=100",
		"2000",
		"50KB",
		"Images ignore offset/limit",
		"file-state cache",
	} {
		if !strings.Contains(ReadFileDescription, text) {
			t.Errorf("ReadFileDescription lost %q", text)
		}
	}
	for _, text := range []string{
		"ReadFile is required first",
		"stale",
		"unique",
		"replace_all=true",
		"empty string deletes",
	} {
		if !strings.Contains(EditFileDescription, text) {
			t.Errorf("EditFileDescription lost %q", text)
		}
	}
	if strings.Contains(EditFileDescription, "allow_multiple") {
		t.Error("EditFileDescription must not mention another harness's allow_multiple")
	}
	for _, text := range []string{
		"complete UTF-8 content",
		"Existing files require ReadFile first",
	} {
		if !strings.Contains(WriteFileDescription, text) {
			t.Errorf("WriteFileDescription lost %q", text)
		}
	}
	for _, text := range []string{"1000", "relative to path", "not rules from .gitignore"} {
		if !strings.Contains(GlobDescription, text) {
			t.Errorf("GlobDescription lost %q", text)
		}
	}
	for _, text := range []string{
		"JavaScript-style regex",
		"case-insensitive",
		"include",
		"500 matching lines",
		"not .gitignore rules",
	} {
		if !strings.Contains(GrepDescription, text) {
			t.Errorf("GrepDescription lost %q", text)
		}
	}
	for name, description := range map[string]string{
		"BashDescription":       BashDescription,
		"PowerShellDescription": PowerShellDescription,
	} {
		for _, text := range []string{
			"seconds: default 120, maximum 600",
			"independent shell",
			"do not persist",
			"commit or push only when requested",
			"hooks/signing",
			"Co-Authored-By: Yukino <usr161043261@outlook.com>",
		} {
			if !strings.Contains(description, text) {
				t.Errorf("%s lost %q", name, text)
			}
		}
	}
	for name, description := range map[string]string{
		"ReadFileDescription":  ReadFileDescription,
		"EditFileDescription":  EditFileDescription,
		"WriteFileDescription": WriteFileDescription,
		"GlobDescription":      GlobDescription,
		"GrepDescription":      GrepDescription,
	} {
		if strings.Contains(description, "Co-Authored-By") {
			t.Errorf("%s must not mention Co-Authored-By", name)
		}
	}
}
