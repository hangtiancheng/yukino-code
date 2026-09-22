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

//go:build darwin

package sandbox

import (
	"strings"
	"testing"
)

// TestDarwinPrepareArgvPassthrough verifies the seatbelt command is handed to
// sandbox-exec as discrete argv elements (TS: seatbelt.ts prepare): the profile
// and the command are never re-quoted into a shell string, so $(...), backticks
// and real newlines survive verbatim and cannot be expanded by an outer shell.
func TestDarwinPrepareArgvPassthrough(t *testing.T) {
	s := &darwinSandbox{}
	if got := s.Implementation(); got != "seatbelt" {
		t.Errorf("Implementation() = %q, want %q", got, "seatbelt")
	}

	command := "echo $(whoami) `id`\ntrue"
	config := Config{
		AllowWrite:     []string{"/tmp/allowed"},
		DenyWrite:      []string{"/etc/denied-missing"},
		NetworkEnabled: false,
	}
	prepared, err := s.Prepare(command, config)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if prepared.Executable != sandboxExecPath {
		t.Errorf("Executable = %q, want %q", prepared.Executable, sandboxExecPath)
	}
	if len(prepared.Args) != 5 {
		t.Fatalf("len(Args) = %d, want 5: %q", len(prepared.Args), prepared.Args)
	}
	if prepared.Args[0] != "-p" {
		t.Errorf("Args[0] = %q, want %q", prepared.Args[0], "-p")
	}
	profile := prepared.Args[1]
	for _, want := range []string{
		"(version 1)",
		"(deny default)",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow sysctl-read)",
		"(allow file-read* (subpath \"/\"))",
		"(allow file-write* (subpath \"/tmp/allowed\"))",
		"(deny file-write* (literal \"/etc/denied-missing\"))",
		"(deny network*)",
	} {
		if !strings.Contains(profile, want) {
			t.Errorf("profile missing %q:\n%s", want, profile)
		}
	}
	if prepared.Args[2] != "bash" || prepared.Args[3] != "-c" {
		t.Errorf("Args[2:4] = %q, want [bash -c]", prepared.Args[2:4])
	}
	if prepared.Args[4] != command {
		t.Errorf("command argv = %q, want verbatim %q", prepared.Args[4], command)
	}
}
