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
	"fmt"
	"strings"
)

// extractBaseCmd extracts the base command name from a command string.
// For piped commands, take the last segment: bash and PowerShell both surface
// the exit code of the last command in a pipeline.
func extractBaseCmd(command string) string {
	segments := strings.Split(command, "|")
	lastSegment := strings.TrimSpace(segments[len(segments)-1])
	for _, token := range strings.Fields(lastSegment) {
		// Skip tokens like VAR=value or $env:VAR=value (variable assignments)
		if strings.Contains(token, "=") && !strings.HasPrefix(token, "-") {
			continue
		}
		// Strip path prefix (both separators) and the .exe suffix; normalize to
		// lowercase since Windows command names are case-insensitive
		if i := strings.LastIndexAny(token, "/\\"); i >= 0 {
			token = token[i+1:]
		}
		if len(token) > 4 && strings.EqualFold(token[len(token)-4:], ".exe") {
			token = token[:len(token)-4]
		}
		return strings.ToLower(token)
	}
	return ""
}

// exitCodeHints holds exit-code semantics for commands whose non-zero exits
// are informational rather than failures, or whose codes carry a specific
// meaning — surfaced to the LLM so it can interpret a non-zero exit correctly.
var exitCodeHints = map[string]map[int]string{
	// Search tools: exit 1 means "no match", not failure
	"grep":    {1: "no matches found", 2: "error while searching"},
	"egrep":   {1: "no matches found", 2: "error while searching"},
	"fgrep":   {1: "no matches found", 2: "error while searching"},
	"zgrep":   {1: "no matches found", 2: "error while searching"},
	"rg":      {1: "no matches found", 2: "error while searching"},
	"ack":     {1: "no matches found"},
	"ag":      {1: "no matches found"},
	"findstr": {1: "no matches found", 2: "error while searching"},
	"where":   {1: "not found"},

	// Comparison / condition tools: non-zero exit is informational
	"diff":  {1: "files differ", 2: "trouble reading files"},
	"diff3": {1: "files differ", 2: "trouble reading files"},
	"sdiff": {1: "files differ", 2: "trouble reading files"},
	"cmp":   {1: "files differ", 2: "trouble reading files"},
	"test":  {1: "condition is false", 2: "expression error"},
	"[":     {1: "condition is false", 2: "expression error"},
	"expr":  {1: "expression is null or zero", 2: "syntax error"},
	"find":  {1: "partial success — some inputs could not be processed"},

	// Process / batch helpers
	"xargs":   {123: "some sub-command invocations exited with 1-125", 124: "a sub-command exited with 255"},
	"timeout": {124: "command timed out"},

	// File / build tools
	"ls":     {1: "minor problem (e.g. unreadable subdirectory)", 2: "serious problem (e.g. inaccessible path)"},
	"tar":    {1: "some files changed or differed while archiving", 2: "fatal error"},
	"make":   {1: "targets not up to date (with -q)", 2: "build failed"},
	"gcc":    {1: "compilation failed"},
	"clang":  {1: "compilation failed"},
	"tsc":    {1: "type errors found"},
	"eslint": {1: "lint errors found", 2: "fatal lint problem (bad config or rule crash)"},

	// Test runners
	"jest":   {1: "tests failed"},
	"vitest": {1: "tests failed"},
	"go":     {1: "build/test/vet reported problems"},

	// Interpreters
	"node":    {1: "uncaught exception"},
	"python":  {1: "unhandled exception"},
	"python3": {1: "unhandled exception"},

	// Network / remote tools
	"git": {128: "fatal error (e.g. invalid ref or not a git repository)"},
	"ssh": {255: "ssh error"},
	"wget": {
		1: "generic error",
		4: "network failure",
		5: "SSL verification failed",
		6: "authentication failure",
		7: "protocol error",
		8: "server issued an error response",
	},
	"curl": {
		6:  "couldn't resolve host",
		7:  "failed to connect to host",
		22: "HTTP error >= 400 (with -f)",
		28: "operation timed out",
	},
	"jq":   {2: "usage or system error", 3: "jq program failed to compile", 5: "no valid result was produced"},
	"ping": {1: "no response received"},
	"rsync": {
		23: "partial transfer due to error",
		24: "source files vanished before transfer",
	},

	// Windows
	"robocopy": {
		1:  "success — files copied",
		2:  "success — extra files or directories detected",
		4:  "success — mismatched files detected",
		8:  "some files failed to copy",
		16: "serious error — no files copied",
	},
}

// genericExitCodeHints are shell-level exit codes that apply to any command.
var genericExitCodeHints = map[int]string{
	126: "command found but not executable",
	127: "command not found",
	129: "terminated by SIGHUP",
	130: "terminated by SIGINT (Ctrl+C)",
	137: "killed by SIGKILL (often OOM)",
	141: "downstream consumer exited early (SIGPIPE)",
	143: "terminated by SIGTERM",
}

// exitCodeHint returns a semantic hint for a non-zero exit code, helping the
// LLM understand what the code means. Command-specific hints win over generic
// ones; POSIX 128+n signal exits get a fallback description. Returns an empty
// string when nothing is recognized.
func exitCodeHint(command string, exitCode int) string {
	baseCmd := extractBaseCmd(command)
	if hints, ok := exitCodeHints[baseCmd]; ok {
		if hint, ok := hints[exitCode]; ok {
			return hint
		}
	}
	if hint, ok := genericExitCodeHints[exitCode]; ok {
		return hint
	}
	// 128+n is the POSIX "killed by signal n" convention; the range is capped
	// because Windows HRESULT-style exit codes are far larger numbers.
	if exitCode >= 129 && exitCode <= 159 {
		return fmt.Sprintf("terminated by signal %d", exitCode-128)
	}
	return ""
}
