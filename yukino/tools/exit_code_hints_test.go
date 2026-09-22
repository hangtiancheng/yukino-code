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

import "testing"

func TestExtractBaseCmd(t *testing.T) {
	cases := []struct {
		command string
		want    string
	}{
		{"grep foo .", "grep"},
		{"cat file | grep x", "grep"},
		{"a | b | rg pattern", "rg"},
		{"FOO=1 BAR=2 make", "make"},
		{"$env:FOO=1 Get-Content x", "get-content"},
		{"/usr/bin/grep x", "grep"},
		{`C:\Windows\System32\FINDSTR.exe x`, "findstr"},
		{"./node_modules/.bin/tsc", "tsc"},
		{"  ls -la", "ls"},
		{"", ""},
		{"| ", ""},
	}
	for _, tc := range cases {
		if got := extractBaseCmd(tc.command); got != tc.want {
			t.Errorf("extractBaseCmd(%q) = %q, want %q", tc.command, got, tc.want)
		}
	}
}

func TestExitCodeHint(t *testing.T) {
	cases := []struct {
		command  string
		exitCode int
		want     string
	}{
		// Search tools: exit 1 means "no match", not failure.
		{"grep foo .", 1, "no matches found"},
		{"grep foo .", 2, "error while searching"},
		{"rg pattern", 1, "no matches found"},
		{"egrep x", 1, "no matches found"},
		{"findstr x", 2, "error while searching"},
		{"where pwsh", 1, "not found"},
		{"ag pattern", 1, "no matches found"},

		// Comparison / condition tools.
		{"diff a b", 1, "files differ"},
		{"cmp a b", 2, "trouble reading files"},
		{"test -f x", 1, "condition is false"},
		{"[ -f x ]", 2, "expression error"},
		{"expr 0", 1, "expression is null or zero"},
		{"find . -delete", 1, "partial success — some inputs could not be processed"},

		// Process / batch helpers.
		{"xargs rm", 123, "some sub-command invocations exited with 1-125"},
		{"xargs rm", 124, "a sub-command exited with 255"},
		{"timeout 5 slow", 124, "command timed out"},

		// File / build tools.
		{"ls /missing", 1, "minor problem (e.g. unreadable subdirectory)"},
		{"ls /missing", 2, "serious problem (e.g. inaccessible path)"},
		{"tar cf a.tar dir", 2, "fatal error"},
		{"make -q", 1, "targets not up to date (with -q)"},
		{"make", 2, "build failed"},
		{"gcc main.c", 1, "compilation failed"},
		{"tsc", 1, "type errors found"},
		{"eslint .", 2, "fatal lint problem (bad config or rule crash)"},

		// Test runners and interpreters.
		{"jest", 1, "tests failed"},
		{"vitest run", 1, "tests failed"},
		{"go test ./...", 1, "build/test/vet reported problems"},
		{"node app.js", 1, "uncaught exception"},
		{"python3 main.py", 1, "unhandled exception"},

		// Network / remote tools.
		{"git log", 128, "fatal error (e.g. invalid ref or not a git repository)"},
		{"ssh host", 255, "ssh error"},
		{"wget https://x", 5, "SSL verification failed"},
		{"curl https://x", 6, "couldn't resolve host"},
		{"curl -f https://x", 22, "HTTP error >= 400 (with -f)"},
		{"curl https://x", 28, "operation timed out"},
		{"jq . x.json", 3, "jq program failed to compile"},
		{"ping host", 1, "no response received"},
		{"rsync -a src dst", 23, "partial transfer due to error"},
		{"rsync -a src dst", 24, "source files vanished before transfer"},

		// Windows.
		{"robocopy src dst", 1, "success — files copied"},
		{"robocopy src dst", 8, "some files failed to copy"},
		{"robocopy src dst", 16, "serious error — no files copied"},

		// Pipelines surface the exit code of the last segment.
		{"cat file | grep x", 1, "no matches found"},

		// Generic shell-level hints apply to any command.
		{"anything", 126, "command found but not executable"},
		{"anything", 127, "command not found"},
		{"anything", 129, "terminated by SIGHUP"},
		{"anything", 130, "terminated by SIGINT (Ctrl+C)"},
		{"anything", 137, "killed by SIGKILL (often OOM)"},
		{"anything", 141, "downstream consumer exited early (SIGPIPE)"},
		{"anything", 143, "terminated by SIGTERM"},

		// Command-specific hints win over the POSIX signal fallback only when
		// defined; otherwise 129-159 decodes as "killed by signal n".
		{"grep x .", 130, "terminated by SIGINT (Ctrl+C)"},
		{"somecmd", 145, "terminated by signal 17"},
		{"somecmd", 159, "terminated by signal 31"},

		// Unrecognized combinations stay silent.
		{"somecmd", 3, ""},
		{"somecmd", 128, ""},
		{"somecmd", 160, ""},
		{"somecmd", 0, ""},
		{"grep x .", 7, ""},
	}
	for _, tc := range cases {
		if got := exitCodeHint(tc.command, tc.exitCode); got != tc.want {
			t.Errorf("exitCodeHint(%q, %d) = %q, want %q", tc.command, tc.exitCode, got, tc.want)
		}
	}
}
