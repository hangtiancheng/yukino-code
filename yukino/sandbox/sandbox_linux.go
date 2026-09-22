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
	"os/exec"
	"sync"
)

// linuxSandbox implements sandbox isolation using bubblewrap (bwrap).
// bwrap leverages Linux user namespaces to create lightweight isolated environments.
type linuxSandbox struct {
	// detected caches the one-time bwrap probe (TS: BwrapSandbox.detected).
	detectOnce sync.Once
	detected   bool
}

func newPlatformSandbox() Sandbox {
	return &linuxSandbox{}
}

func (s *linuxSandbox) Implementation() string { return "bwrap" }

func (s *linuxSandbox) Available() bool {
	s.detectOnce.Do(func() {
		_, err := exec.LookPath("bwrap")
		s.detected = err == nil
	})
	return s.detected
}

// Prepare returns the argv that runs the command under bwrap. The command is
// passed as a single argv element after "--" — no intermediate shell may
// re-parse it (TS: bwrap.ts prepare).
func (s *linuxSandbox) Prepare(command string, config Config) (PreparedCommand, error) {
	var args []string

	// Isolate user and pid namespaces.
	args = append(args, "--unshare-user", "--unshare-pid")

	// Read-only bind mount of the root filesystem.
	args = append(args, "--ro-bind", "/", "/")

	// Allow write per path (writable bind mounts).
	for _, path := range config.AllowWrite {
		args = append(args, "--bind", path, path)
	}

	// Force read-only (overrides writable sub-paths under root).
	for _, path := range config.DenyWrite {
		args = append(args, "--ro-bind", path, path)
	}

	// Network isolation.
	if !config.NetworkEnabled {
		args = append(args, "--unshare-net")
	}

	// Mount /proc; many commands depend on it.
	args = append(args, "--proc", "/proc")

	// Append the command to execute.
	args = append(args, "--", "bash", "-c", command)

	return PreparedCommand{Executable: "bwrap", Args: args}, nil
}
