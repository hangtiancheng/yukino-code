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

//go:build linux

package sandbox

import (
	"reflect"
	"testing"
)

// TestLinuxPrepareArgvPassthrough verifies the bwrap argv sequence is returned
// as discrete elements (TS: bwrap.ts prepare): the command is never re-quoted
// into a shell string, so $(...), backticks and real newlines survive verbatim
// and cannot be expanded by an outer shell.
func TestLinuxPrepareArgvPassthrough(t *testing.T) {
	s := &linuxSandbox{}
	if got := s.Implementation(); got != "bwrap" {
		t.Errorf("Implementation() = %q, want %q", got, "bwrap")
	}

	command := "echo $(whoami) `id`\ntrue"
	config := Config{
		AllowWrite:     []string{"/tmp/allowed"},
		DenyWrite:      []string{"/etc/denied"},
		NetworkEnabled: false,
	}
	prepared, err := s.Prepare(command, config)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if prepared.Executable != "bwrap" {
		t.Errorf("Executable = %q, want %q", prepared.Executable, "bwrap")
	}
	want := []string{
		"--unshare-user", "--unshare-pid",
		"--ro-bind", "/", "/",
		"--bind", "/tmp/allowed", "/tmp/allowed",
		"--ro-bind", "/etc/denied", "/etc/denied",
		"--unshare-net",
		"--proc", "/proc",
		"--", "bash", "-c", command,
	}
	if !reflect.DeepEqual(prepared.Args, want) {
		t.Errorf("Args = %q, want %q", prepared.Args, want)
	}
}
