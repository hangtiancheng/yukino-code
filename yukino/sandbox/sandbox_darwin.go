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
	"fmt"
	"os"
	"strings"
)

// sandboxExecPath is a hardcoded path to prevent PATH injection attacks.
const sandboxExecPath = "/usr/bin/sandbox-exec"

// darwinSandbox implements sandbox isolation using macOS seatbelt (sandbox-exec).
// It dynamically generates a seatbelt profile to control file-write and network
// access permissions.
type darwinSandbox struct{}

func newPlatformSandbox() Sandbox {
	return &darwinSandbox{}
}

func (s *darwinSandbox) Implementation() string { return "seatbelt" }

func (s *darwinSandbox) Available() bool {
	_, err := os.Stat(sandboxExecPath)
	return err == nil
}

// buildProfile dynamically generates a seatbelt profile string.
// Strategy: deny by default -> allow exec/read -> allow write per path -> deny write per path -> network control.
func buildProfile(config Config) string {
	// TS joins the profile lines with "\n" (no trailing newline), so the last
	// line must not carry one either.
	lines := []string{
		"(version 1)",
		"(deny default)",
		// Allow process execution and fork.
		"(allow process-exec)",
		"(allow process-fork)",
		// Allow reading system information.
		"(allow sysctl-read)",
		// Full-disk readable.
		"(allow file-read* (subpath \"/\"))",
	}

	// Allow write per path.
	for _, path := range config.AllowWrite {
		lines = append(lines, fmt.Sprintf("(allow file-write* (subpath %q))", path))
	}

	// Paths to deny write are placed after allow rules; seatbelt applies
	// later rules with higher priority. Single files use literal for exact
	// match; directories use subpath for prefix match.
	for _, path := range config.DenyWrite {
		info, err := os.Stat(path)
		if err == nil && info.IsDir() {
			lines = append(lines, fmt.Sprintf("(deny file-write* (subpath %q))", path))
		} else {
			lines = append(lines, fmt.Sprintf("(deny file-write* (literal %q))", path))
		}
	}

	// Network control.
	if config.NetworkEnabled {
		lines = append(lines, "(allow network*)")
	} else {
		lines = append(lines, "(deny network*)")
	}

	return strings.Join(lines, "\n")
}

// Prepare returns the argv that runs the command under seatbelt. The profile
// and the command are passed as discrete argv elements to sandbox-exec — no
// intermediate shell may re-parse them (TS: seatbelt.ts prepare).
func (s *darwinSandbox) Prepare(command string, config Config) (PreparedCommand, error) {
	return PreparedCommand{
		Executable: sandboxExecPath,
		Args:       []string{"-p", buildProfile(config), "bash", "-c", command},
	}, nil
}
