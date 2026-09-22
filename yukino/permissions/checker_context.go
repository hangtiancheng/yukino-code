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

package permissions

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

// The TS ToolContext carries permissionChecker/onPermissionRequest next to the
// other per-call fields (tools/types.ts). In Go the plumbing lives here
// instead of in tools because permissions already depends on tools and the
// import cycle forbids the TS direction; the observable flow is identical —
// the agent loop attaches both to every tool execution context and spawned
// loops read them back.

// RequestHandler answers "ask" decisions interactively (TS
// PermissionRequestHandler). A non-nil error is reported to the model as
// `Permission request failed: <err>. The tool was not executed.` — the TS
// catch around the awaited callback.
type RequestHandler func(toolName string, args map[string]any, decision Decision, toolCallID string) (tools.PermissionAnswer, error)

type checkerKey struct{}
type requestHandlerKey struct{}

// ContextWithChecker attaches the loop's security checker to a per-call tool
// context (TS ToolContext.permissionChecker). A nil checker clears it.
func ContextWithChecker(ctx context.Context, c *Checker) context.Context {
	return context.WithValue(ctx, checkerKey{}, c)
}

// CheckerFromContext returns the loop's security checker, or nil when the
// context carries none (parentless runs).
func CheckerFromContext(ctx context.Context) *Checker {
	if c, ok := ctx.Value(checkerKey{}).(*Checker); ok {
		return c
	}
	return nil
}

// ContextWithRequestHandler attaches the loop's approval callback to a
// per-call tool context (TS ToolContext.onPermissionRequest).
func ContextWithRequestHandler(ctx context.Context, h RequestHandler) context.Context {
	return context.WithValue(ctx, requestHandlerKey{}, h)
}

// RequestHandlerFromContext returns the loop's approval callback, or nil when
// the run is handler-less (headless).
func RequestHandlerFromContext(ctx context.Context) RequestHandler {
	if h, ok := ctx.Value(requestHandlerKey{}).(RequestHandler); ok {
		return h
	}
	return nil
}

// ForWorkDir clones the checker for a different working directory (TS
// PermissionChecker.forWorkDir): a fresh plain PathSandbox rooted at workDir,
// the same mode, and the shared rule engine plus copied sandbox flags.
func (c *Checker) ForWorkDir(workDir string) *Checker {
	checker := NewChecker(NewPathSandbox(workDir), c.RuleEngine, c.Mode)
	checker.SandboxEnabled = c.SandboxEnabled
	checker.SandboxAutoAllow = c.SandboxAutoAllow
	return checker
}

// AllowAlways persists a scoped "allow always" rule (TS
// PermissionChecker.allowAlways):
//   - file tools scope to the parent directory + `/*` (a directory path uses
//     itself + `/*`);
//   - commands scope to the first 1-2 words + `*` so the rule allows that
//     command family rather than one exact invocation.
//
// The error surfaces like the TS throw, which the agent loop's permission
// catch turns into `Permission request failed: ...`.
func (c *Checker) AllowAlways(toolName string, args map[string]any) error {
	content := ExtractContent(toolName, args)
	var pattern string
	if (toolName == "ReadFile" || toolName == "WriteFile" || toolName == "EditFile") && content != "" {
		abs := tools.ResolvePath(c.Sandbox.projectDir, content)
		base := abs
		// TS treats a path that does not exist yet (e.g. WriteFile creating a
		// new file) as a file, so it scopes to its directory too.
		if fi, err := os.Stat(abs); err != nil || !fi.IsDir() {
			base = filepath.Dir(abs)
		}
		pattern = filepath.Join(base, "*")
	} else {
		words := strings.Fields(content)
		if len(words) > 2 {
			words = words[:2]
		}
		pattern = strings.Join(words, " ") + "*"
	}
	return c.RuleEngine.AppendProjectRule(Rule{
		ToolName: toolName,
		Pattern:  pattern,
		Effect:   RuleAllow,
	})
}
