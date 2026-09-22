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

package skills

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// installDownloadTimeout caps a remote SKILL.md download
// (TS: install-tool.ts:102-111). A var so tests can exercise the timeout path.
var installDownloadTimeout = 30 * time.Second

// errDownloadTimeout is the DOMException message the TS 30s timer aborts with
// (install-tool.ts:104-108); asErrorString renders err.message, so the tool
// output is "Error installing skill: Skill download timed out after 30 seconds".
var errDownloadTimeout = errors.New("Skill download timed out after 30 seconds")

// errAborted is the AbortError DOMException message signal.throwIfAborted()
// throws when the turn was aborted (install-tool.ts:99,124,154).
var errAborted = errors.New("This operation was aborted")

// fetchFailedError mirrors undici's network-level TypeError: err.message is the
// constant "fetch failed" while the wrapped cause keeps the Go diagnostic for
// the { err } log field (pino serialises err.cause, like the TS log).
type fetchFailedError struct{ cause error }

func (e *fetchFailedError) Error() string { return "fetch failed" }
func (e *fetchFailedError) Unwrap() error { return e.cause }

// terminatedError mirrors undici's body-level TypeError ("terminated") raised
// when the connection drops mid-body; the cause keeps the Go IO error.
type terminatedError struct{ cause error }

func (e *terminatedError) Error() string { return "terminated" }
func (e *terminatedError) Unwrap() error { return e.cause }

// httpURLRe detects the URL form of `source` (TS: install-tool.ts:101).
var httpURLRe = regexp.MustCompile(`(?i)^https?://`)

// skillNameRe is the install-name allowlist: letters, digits, dots,
// underscores and hyphens; the first character may not be a dot
// (TS: install-tool.ts:142).
var skillNameRe = regexp.MustCompile(`^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$`)

// installValidationError marks the failures TS surfaces verbatim as
// "Error: <message>" tool results, as opposed to unexpected errors wrapped in
// "Error installing skill: <message>" (TS: install-tool.ts:95,118-148,200-206).
type installValidationError struct{ message string }

func (e *installValidationError) Error() string { return e.message }

func validationErrorf(format string, args ...any) error {
	return &installValidationError{message: fmt.Sprintf(format, args...)}
}

// validateSkillName enforces the TS name rule: the name must match
// ^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$ and must not end with a dot
// (TS: install-tool.ts:142-148).
func validateSkillName(name string) error {
	if !skillNameRe.MatchString(name) || strings.HasSuffix(name, ".") {
		return validationErrorf("invalid skill name; use letters, digits, dots, underscores and hyphens")
	}
	return nil
}

// installSkill reads source — a local file path resolved against workDir, or
// an http(s) URL of a raw SKILL.md — and installs it into the project-level
// skills directory <workDir>/.agents/skills/<name>/SKILL.md, returning the
// installed name. skills.sh pages and GitHub tree/blob pages are NOT
// supported: the source must be the raw SKILL.md itself
// (TS: InstallSkillTool.execute, install-tool.ts:89-207).
func installSkill(ctx context.Context, workDir, source, nameOverride string, client *http.Client) (string, error) {
	// TS: ctx.abortSignal?.throwIfAborted() at the top of execute — the
	// AbortError DOMException message is what asErrorString renders.
	if err := ctx.Err(); err != nil {
		return "", errAborted
	}
	var content string
	if httpURLRe.MatchString(source) {
		downloaded, err := downloadSkillSource(ctx, source, client)
		if err != nil {
			return "", err
		}
		content = downloaded
	} else {
		path := source
		if !filepath.IsAbs(path) {
			// TS: readFileSync(resolve(this.workDir, source)) — relative paths
			// resolve against the workspace (install-tool.ts:130).
			path = filepath.Join(workDir, path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		content = string(data)
	}

	parsed, err := parseSkillFile(content)
	if err != nil {
		return "", validationErrorf("source must be a valid SKILL.md with a frontmatter name")
	}
	name := nameOverride
	if name == "" {
		name = parsed.Meta.Name
	}
	if err := validateSkillName(name); err != nil {
		return "", err
	}
	if name != parsed.Meta.Name {
		// The catalog indexes the YAML name, so an override must update it too
		// (TS: install-tool.ts:149-152). The rewrite preserves the original
		// key order, like the TS spread of the parsed frontmatter object.
		rewritten, err := rewriteFrontmatterName(parsed.FrontmatterNode, name)
		if err != nil {
			return "", fmt.Errorf("rewrite frontmatter: %w", err)
		}
		content = "---\n" + rewritten + "---\n\n" + parsed.Body + "\n"
	}

	// TS: ctx.abortSignal?.throwIfAborted() before the filesystem work.
	if err := ctx.Err(); err != nil {
		return "", errAborted
	}
	dir, err := prepareInstallDir(workDir, name)
	if err != nil {
		return "", err
	}
	if err := writeSkillFileAtomically(dir, content); err != nil {
		return "", err
	}
	return name, nil
}

// rewriteFrontmatterName replaces the `name` value in a decoded frontmatter
// document, preserving the original key order, and returns the re-marshalled
// YAML (TS: yaml.dump({...parsed.frontmatter, name}), install-tool.ts:151).
func rewriteFrontmatterName(node *yaml.Node, name string) (string, error) {
	if node == nil {
		return "", errors.New("missing frontmatter node")
	}
	mapping := node
	if mapping.Kind == yaml.DocumentNode {
		if len(mapping.Content) == 0 {
			return "", errors.New("empty frontmatter document")
		}
		mapping = mapping.Content[0]
	}
	if mapping.Kind != yaml.MappingNode {
		return "", errors.New("frontmatter is not a YAML mapping")
	}
	replaced := false
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == "name" {
			mapping.Content[i+1] = &yaml.Node{
				Kind:  yaml.ScalarNode,
				Tag:   "!!str",
				Value: name,
			}
			replaced = true
			break
		}
	}
	if !replaced {
		mapping.Content = append(mapping.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "name"},
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: name},
		)
	}
	out, err := yaml.Marshal(mapping)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// downloadSkillSource fetches a raw SKILL.md over http(s) with a 30s timeout
// (TS: install-tool.ts:101-128). The timeout stays armed until the response
// body has been consumed: a deadline that fires mid-body-read surfaces the same
// DOMException message as one that fires during the request. A non-2xx status
// is a validation error ("fetch failed (<status>)") that TS returns without
// throwing; network failures render the undici TypeError messages.
func downloadSkillSource(ctx context.Context, source string, client *http.Client) (string, error) {
	if client == nil {
		client = &http.Client{}
	}
	reqCtx, cancel := context.WithTimeout(ctx, installDownloadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, source, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		if serr := signalError(ctx, reqCtx); serr != nil {
			return "", serr
		}
		return "", &fetchFailedError{cause: err}
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return "", validationErrorf("fetch failed (%d)", resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		if serr := signalError(ctx, reqCtx); serr != nil {
			return "", serr
		}
		return "", &terminatedError{cause: err}
	}
	// TS: signal.throwIfAborted() after the body was consumed — the timer is
	// only cleared in the finally block, so an abort that lands right after a
	// complete read still throws (install-tool.ts:124-128).
	if serr := signalError(ctx, reqCtx); serr != nil {
		return "", serr
	}
	return string(data), nil
}

// signalError maps the combined request-context state onto the reason TS's
// AbortSignal.any([turnSignal, timeoutSignal]) rejects with: the 30s timer's
// TimeoutError when only the download deadline fired, the turn's AbortError
// when the parent context was aborted. Returns nil when neither is done.
func signalError(parent, reqCtx context.Context) error {
	if reqCtx.Err() == nil {
		return nil
	}
	if parent.Err() == nil {
		// Only the download timer could have fired.
		return errDownloadTimeout
	}
	return errAborted
}

// prepareInstallDir resolves the workspace itself (which may be reached via a
// symlink), then rejects symlinks in every installation component, including
// dangling links, creating missing directories along the way
// (TS: install-tool.ts:154-170).
func prepareInstallDir(workDir, name string) (string, error) {
	root, err := filepath.EvalSymlinks(workDir)
	if err != nil {
		return "", fmt.Errorf("resolve workspace: %w", err)
	}
	dir := root
	for _, segment := range []string{".agents", "skills", name} {
		dir = filepath.Join(dir, segment)
		info, err := os.Lstat(dir)
		switch {
		case err == nil:
			if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
				return "", fmt.Errorf("installation directory must be a real directory: %s", dir)
			}
		case errors.Is(err, os.ErrNotExist):
			if err := os.Mkdir(dir, 0o755); err != nil {
				return "", fmt.Errorf("create %s: %w", dir, err)
			}
		default:
			return "", err
		}
	}
	return dir, nil
}

// writeSkillFileAtomically replaces only the SKILL.md directory entry via a
// temporary file + rename, refusing symlinked or non-regular targets. This
// also avoids truncating a file outside the workspace when the old SKILL.md
// has another hard link (TS: install-tool.ts:171-192).
func writeSkillFileAtomically(dir, content string) error {
	destination := filepath.Join(dir, "SKILL.md")
	mode := os.FileMode(0o666)
	if info, err := os.Lstat(destination); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return fmt.Errorf("installation target must be a regular file: %s", destination)
		}
		mode = info.Mode().Perm()
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	suffix := make([]byte, 16)
	if _, err := rand.Read(suffix); err != nil {
		return err
	}
	temporary := filepath.Join(dir, ".SKILL-"+hex.EncodeToString(suffix)+".tmp")
	f, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer os.Remove(temporary) // no-op once the rename succeeded
	if _, err := f.WriteString(content); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(temporary, destination)
}
