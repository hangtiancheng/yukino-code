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
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const sampleSkillMD = "---\nname: sample\ndescription: sample skill\n---\n\nSample body."

// writeSourceSkill drops a raw SKILL.md into work/incoming/ and returns its
// workDir-relative path, mirroring a user-provided local source.
func writeSourceSkill(t *testing.T, work, content string) string {
	t.Helper()
	dir := filepath.Join(work, "incoming")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir incoming: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(content), 0o644); err != nil {
		t.Fatalf("write source SKILL.md: %v", err)
	}
	return filepath.Join("incoming", "SKILL.md")
}

func TestValidateSkillName(t *testing.T) {
	// TS install-tool.ts:142: ^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$ and no trailing dot.
	ok := []string{"frontend-design", "pdf", "backend_interview", "x1y2", "Has-Caps", "Skill.v2", "-dash", "_under", "a..b"}
	for _, n := range ok {
		if err := validateSkillName(n); err != nil {
			t.Errorf("validateSkillName(%q): %v", n, err)
		}
	}
	bad := []string{"", ".hidden", "with space", "with/slash", "ends.", "../escape", "a$b", "dot\ttab"}
	for _, n := range bad {
		if err := validateSkillName(n); err == nil {
			t.Errorf("expected reject for %q", n)
		}
	}
}

func TestInstallSkillFromLocalPath(t *testing.T) {
	work := t.TempDir()
	src := writeSourceSkill(t, work, sampleSkillMD)

	name, err := installSkill(context.Background(), work, src, "", nil)
	if err != nil {
		t.Fatalf("installSkill: %v", err)
	}
	if name != "sample" {
		t.Errorf("name = %q, want sample", name)
	}
	data, err := os.ReadFile(filepath.Join(work, ".agents", "skills", "sample", "SKILL.md"))
	if err != nil {
		t.Fatalf("read installed SKILL.md: %v", err)
	}
	if !strings.Contains(string(data), "Sample body.") {
		t.Errorf("installed content mismatch: %q", string(data))
	}
}

func TestInstallSkillFromURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/raw/SKILL.md" {
			fmt.Fprint(w, sampleSkillMD)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	work := t.TempDir()
	name, err := installSkill(context.Background(), work, srv.URL+"/raw/SKILL.md", "", srv.Client())
	if err != nil {
		t.Fatalf("installSkill: %v", err)
	}
	if name != "sample" {
		t.Errorf("name = %q, want sample", name)
	}
	if _, err := os.Stat(filepath.Join(work, ".agents", "skills", "sample", "SKILL.md")); err != nil {
		t.Errorf("installed file missing: %v", err)
	}
}

func TestInstallSkillURLFetchFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	_, err := installSkill(context.Background(), t.TempDir(), srv.URL+"/missing.md", "", srv.Client())
	var verr *installValidationError
	if !errors.As(err, &verr) || verr.Error() != "fetch failed (404)" {
		t.Fatalf("want validation error 'fetch failed (404)', got %v", err)
	}
}

// stallPartialBody writes a partial body, flushes it, then holds the
// connection open until the request context ends — a stalled mid-body read.
func stallPartialBody(w http.ResponseWriter, r *http.Request) {
	fmt.Fprint(w, "partial")
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	select {
	case <-r.Context().Done():
	case <-time.After(10 * time.Second):
	}
}

// TestDownloadSkillSource_TimeoutMidBodyRead pins the TS behavior of the
// AbortSignal.timeout armed around the whole fetch+body read
// (install-tool.ts:102-128): a deadline that fires mid-body-read rejects with
// the timer's DOMException, rendered as the timeout message by asErrorString.
func TestDownloadSkillSource_TimeoutMidBodyRead(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(stallPartialBody))
	defer srv.Close()

	prev := installDownloadTimeout
	installDownloadTimeout = 100 * time.Millisecond
	defer func() { installDownloadTimeout = prev }()

	_, err := downloadSkillSource(context.Background(), srv.URL, srv.Client())
	if !errors.Is(err, errDownloadTimeout) {
		t.Fatalf("want the download timeout error, got %v", err)
	}
	if err.Error() != "Skill download timed out after 30 seconds" {
		t.Errorf("timeout wording = %q", err.Error())
	}
}

// TestDownloadSkillSource_AbortMidBodyRead pins the turn-abort behavior: the
// combined signal rejects with the turn's AbortError reason, whose message
// asErrorString renders (TS: AbortSignal.any + asErrorString).
func TestDownloadSkillSource_AbortMidBodyRead(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(stallPartialBody))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	defer cancel()

	_, err := downloadSkillSource(ctx, srv.URL, srv.Client())
	if !errors.Is(err, errAborted) {
		t.Fatalf("want the abort error, got %v", err)
	}
	if err.Error() != "This operation was aborted" {
		t.Errorf("abort wording = %q", err.Error())
	}
}

// TestDownloadSkillSource_NetworkFailure pins the undici wording: a
// network-level failure renders "fetch failed" (the TypeError message TS's
// fetch rejects with), keeping the Go diagnostic as the wrapped cause.
func TestDownloadSkillSource_NetworkFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	client := srv.Client()
	srv.Close() // connection refused from here on

	_, err := downloadSkillSource(context.Background(), srv.URL, client)
	if err == nil || err.Error() != "fetch failed" {
		t.Fatalf("want 'fetch failed', got %v", err)
	}
	if errors.Unwrap(err) == nil {
		t.Error("fetch-failed error should wrap the Go network diagnostic")
	}
}

// TestInstallSkill_AbortedContext pins the TS throwIfAborted wording at the
// top of execute: an aborted turn yields the AbortError message, which the
// tool catch renders as "Error installing skill: This operation was aborted".
func TestInstallSkill_AbortedContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	work := t.TempDir()
	src := writeSourceSkill(t, work, sampleSkillMD)
	_, err := installSkill(ctx, work, src, "", nil)
	if !errors.Is(err, errAborted) {
		t.Fatalf("want the abort error, got %v", err)
	}

	tool := &InstallSkillTool{Catalog: LoadCatalog(work), WorkDir: work}
	res := tool.Execute(ctx, map[string]any{"source": src})
	if !res.IsError || res.Output != "Error installing skill: This operation was aborted" {
		t.Fatalf("tool output = %q (IsError=%v)", res.Output, res.IsError)
	}
}

func TestInstallSkillRejectsInvalidSource(t *testing.T) {
	work := t.TempDir()
	src := writeSourceSkill(t, work, "no frontmatter here")

	_, err := installSkill(context.Background(), work, src, "", nil)
	var verr *installValidationError
	if !errors.As(err, &verr) || verr.Error() != "source must be a valid SKILL.md with a frontmatter name" {
		t.Fatalf("want invalid-source validation error, got %v", err)
	}
}

func TestInstallSkillNameOverrideRewritesFrontmatter(t *testing.T) {
	work := t.TempDir()
	src := writeSourceSkill(t, work, sampleSkillMD)

	name, err := installSkill(context.Background(), work, src, "renamed", nil)
	if err != nil {
		t.Fatalf("installSkill: %v", err)
	}
	if name != "renamed" {
		t.Errorf("name = %q, want renamed", name)
	}
	data, err := os.ReadFile(filepath.Join(work, ".agents", "skills", "renamed", "SKILL.md"))
	if err != nil {
		t.Fatalf("read installed SKILL.md: %v", err)
	}
	// The rewritten file must re-parse with the overridden name and keep the
	// rest of the frontmatter + body.
	parsed, err := parseSkillFile(string(data))
	if err != nil {
		t.Fatalf("re-parse installed SKILL.md: %v", err)
	}
	if parsed.Meta.Name != "renamed" {
		t.Errorf("frontmatter name = %q, want renamed", parsed.Meta.Name)
	}
	if parsed.Meta.Description != "sample skill" {
		t.Errorf("description lost in rewrite: %q", parsed.Meta.Description)
	}
	if parsed.Body != "Sample body." {
		t.Errorf("body lost in rewrite: %q", parsed.Body)
	}
}

func TestInstallSkillRejectsInvalidOverrideName(t *testing.T) {
	work := t.TempDir()
	src := writeSourceSkill(t, work, sampleSkillMD)

	for _, bad := range []string{"bad name", ".hidden", "ends."} {
		_, err := installSkill(context.Background(), work, src, bad, nil)
		var verr *installValidationError
		if !errors.As(err, &verr) || !strings.Contains(verr.Error(), "invalid skill name") {
			t.Errorf("override %q: want invalid-name validation error, got %v", bad, err)
		}
	}
}

func TestInstallSkillSymlinkGuard(t *testing.T) {
	work := t.TempDir()
	src := writeSourceSkill(t, work, sampleSkillMD)

	// A symlinked .agents/skills component must be refused so installs cannot
	// be redirected outside the workspace (TS: install-tool.ts:157-170).
	if err := os.MkdirAll(filepath.Join(work, ".agents"), 0o755); err != nil {
		t.Fatalf("mkdir .agents: %v", err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(work, ".agents", "skills")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	_, err := installSkill(context.Background(), work, src, "", nil)
	if err == nil || !strings.Contains(err.Error(), "installation directory must be a real directory") {
		t.Fatalf("want symlink rejection, got %v", err)
	}
	if _, statErr := os.Stat(filepath.Join(outside, "sample")); statErr == nil {
		t.Error("install escaped the workspace through the symlink")
	}
}

func TestInstallSkillAtomicOverwrite(t *testing.T) {
	work := t.TempDir()
	src := writeSourceSkill(t, work, sampleSkillMD)

	if _, err := installSkill(context.Background(), work, src, "", nil); err != nil {
		t.Fatalf("first install: %v", err)
	}
	updated := "---\nname: sample\ndescription: v2\n---\n\nUpdated body."
	if err := os.WriteFile(filepath.Join(work, "incoming", "SKILL.md"), []byte(updated), 0o644); err != nil {
		t.Fatalf("rewrite source: %v", err)
	}
	if _, err := installSkill(context.Background(), work, src, "", nil); err != nil {
		t.Fatalf("second install: %v", err)
	}

	dir := filepath.Join(work, ".agents", "skills", "sample")
	data, err := os.ReadFile(filepath.Join(dir, "SKILL.md"))
	if err != nil {
		t.Fatalf("read installed SKILL.md: %v", err)
	}
	if !strings.Contains(string(data), "Updated body.") {
		t.Errorf("overwrite did not land: %q", string(data))
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".SKILL-") && strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("temp file left behind: %s", e.Name())
		}
	}
}

func TestInstallSkillToolExecute(t *testing.T) {
	work := t.TempDir()
	src := writeSourceSkill(t, work, sampleSkillMD)

	cat := LoadCatalog(work)
	var installed string
	tool := &InstallSkillTool{
		Catalog:     cat,
		WorkDir:     work,
		OnInstalled: func(name string) { installed = name },
	}
	res := tool.Execute(context.Background(), map[string]any{"source": src})
	if res.IsError {
		t.Fatalf("unexpected error: %s", res.Output)
	}
	want := "Skill 'sample' installed to .agents/skills/sample/SKILL.md"
	if res.Output != want {
		t.Errorf("output = %q, want %q", res.Output, want)
	}
	if installed != "sample" {
		t.Errorf("OnInstalled got %q, want sample", installed)
	}
	// The catalog was reloaded, so the skill is immediately reachable.
	if cat.Get("sample") == nil {
		t.Error("catalog missing the installed skill after reload")
	}
}

func TestInstallSkillToolRequiresSource(t *testing.T) {
	tool := &InstallSkillTool{WorkDir: t.TempDir()}
	res := tool.Execute(context.Background(), map[string]any{})
	if !res.IsError || res.Output != "Error: source is required" {
		t.Fatalf("want 'Error: source is required', got %+v", res)
	}
}
