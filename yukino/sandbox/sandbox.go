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

package sandbox

// PreparedCommand is a sandboxed command ready to run: the sandbox executable
// plus its full argv (TS: PreparedSandboxCommand in sandbox/index.ts). Callers
// must spawn it directly (exec.Command(p.Executable, p.Args...)); re-quoting it
// into a shell string would let an outer shell re-parse the command outside the
// sandbox.
type PreparedCommand struct {
	Executable string
	Args       []string
}

// Sandbox defines the unified interface for OS-level sandboxing.
// Each platform (macOS seatbelt / Linux bubblewrap) provides its own implementation.
type Sandbox interface {
	// Implementation returns the backend name ("seatbelt" or "bwrap").
	Implementation() string
	// Available checks whether the platform's sandbox tool is available.
	Available() bool
	// Prepare returns the executable and argv that run the command inside the
	// sandbox. The command is handed to the sandbox tool as a single argv
	// element (no intermediate shell), so it is never re-parsed outside.
	Prepare(command string, config Config) (PreparedCommand, error)
}

// Config controls the sandbox's read, write, and network permissions.
type Config struct {
	AllowWrite     []string // paths where writing is permitted
	DenyWrite      []string // paths that are always read-only (priority over AllowWrite)
	NetworkEnabled bool     // whether network access is permitted
}

// New returns the sandbox implementation for the current platform, or nil if
// the platform is unsupported.
func New() Sandbox {
	return newPlatformSandbox()
}
