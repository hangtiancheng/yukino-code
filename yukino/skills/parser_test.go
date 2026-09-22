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
	"strings"
	"testing"
)

func TestParseSkillFileValid(t *testing.T) {
	content := "---\nname: demo\ndescription: a demo\nmode: fork\nfork_context: recent\nmodel: fast-1\n---\n\nBody text.\n\n---\n\nTrailing --- stays in the body."
	parsed, err := parseSkillFile(content)
	if err != nil {
		t.Fatalf("parseSkillFile: %v", err)
	}
	if parsed.Meta.Name != "demo" || parsed.Meta.Description != "a demo" {
		t.Errorf("meta mismatch: %+v", parsed.Meta)
	}
	if parsed.Meta.Mode != "fork" || parsed.Meta.ForkContext != "recent" || parsed.Meta.Model != "fast-1" {
		t.Errorf("mode/fork_context/model mismatch: %+v", parsed.Meta)
	}
	// `---` lines inside the body are content, not delimiters.
	if !strings.Contains(parsed.Body, "Trailing --- stays in the body.") {
		t.Errorf("body lost trailing section: %q", parsed.Body)
	}
	if parsed.Frontmatter["name"] != "demo" {
		t.Errorf("raw frontmatter not preserved: %+v", parsed.Frontmatter)
	}
}

func TestParseSkillFileStripsBOM(t *testing.T) {
	parsed, err := parseSkillFile("\uFEFF---\nname: bom\ndescription: d\n---\nbody")
	if err != nil {
		t.Fatalf("parseSkillFile with BOM: %v", err)
	}
	if parsed.Meta.Name != "bom" {
		t.Errorf("name = %q", parsed.Meta.Name)
	}
}

func TestParseSkillFileCRLF(t *testing.T) {
	parsed, err := parseSkillFile("---\r\nname: crlf\r\n---\r\nbody line")
	if err != nil {
		t.Fatalf("parseSkillFile CRLF: %v", err)
	}
	if parsed.Meta.Name != "crlf" || parsed.Body != "body line" {
		t.Errorf("CRLF parse mismatch: %+v / %q", parsed.Meta, parsed.Body)
	}
}

// Invalid skills are skipped wholesale (TS: zod schema failures return null,
// catalog.ts:275-292). Each case must fail parsing.
func TestParseSkillFileRejectsInvalid(t *testing.T) {
	cases := map[string]string{
		"no frontmatter":          "just a body",
		"unterminated":            "---\nname: x\nbody without closing delimiter",
		"missing name":            "---\ndescription: d\n---\nbody",
		"empty name":              "---\nname: \"\"\n---\nbody",
		"whitespace name":         "---\nname: \"   \"\n---\nbody",
		"non-string name":         "---\nname: 123\n---\nbody",
		"null name":               "---\nname:\n---\nbody",
		"invalid mode":            "---\nname: x\nmode: sideways\n---\nbody",
		"null mode":               "---\nname: x\nmode:\n---\nbody",
		"invalid fork_context":    "---\nname: x\nfork_context: everything\n---\nbody",
		"null description":        "---\nname: x\ndescription:\n---\nbody",
		"non-mapping frontmatter": "---\n- just\n- a list\n---\nbody",
	}
	for label, content := range cases {
		if _, err := parseSkillFile(content); err == nil {
			t.Errorf("%s: expected parse failure, got success", label)
		}
	}
}

func TestParseSkillFileResolveMode(t *testing.T) {
	// Legacy `context: fork` is equivalent to `mode: fork` (TS resolveMode).
	parsed, err := parseSkillFile("---\nname: legacy\ncontext: fork\n---\nbody")
	if err != nil {
		t.Fatalf("parseSkillFile: %v", err)
	}
	if parsed.Meta.Mode != "fork" {
		t.Errorf("context: fork must resolve to mode fork, got %q", parsed.Meta.Mode)
	}

	// An explicit mode wins over context.
	parsed, err = parseSkillFile("---\nname: both\nmode: inline\ncontext: fork\n---\nbody")
	if err != nil {
		t.Fatalf("parseSkillFile: %v", err)
	}
	if parsed.Meta.Mode != "inline" {
		t.Errorf("explicit mode must win, got %q", parsed.Meta.Mode)
	}

	// Neither present → inline.
	parsed, err = parseSkillFile("---\nname: plain\n---\nbody")
	if err != nil {
		t.Fatalf("parseSkillFile: %v", err)
	}
	if parsed.Meta.Mode != "inline" {
		t.Errorf("default mode = %q, want inline", parsed.Meta.Mode)
	}
	if parsed.Meta.ForkContext != "" {
		t.Errorf("unset fork_context = %q, want empty", parsed.Meta.ForkContext)
	}
}

// The catalog must skip invalid skills without hiding their siblings
// (TS: loadSkill catch → skip, catalog.ts:147-180).
func TestLoadFromDirectorySkipsInvalidSkills(t *testing.T) {
	dir := t.TempDir()
	writeSkillDir(t, dir, "good", "name: good\ndescription: valid skill", "good body")
	writeSkillDir(t, dir, "no-name", "description: missing the required name", "bad")
	writeSkillDir(t, dir, "bad-mode", "name: bad-mode\nmode: sideways", "bad")

	cat, err := LoadFromDirectory(dir)
	if err != nil {
		t.Fatalf("LoadFromDirectory: %v", err)
	}
	if cat.Get("good") == nil {
		t.Error("valid skill must be loaded")
	}
	if cat.Get("no-name") != nil {
		t.Error("skill without a frontmatter name must be skipped")
	}
	if cat.Get("bad-mode") != nil {
		t.Error("skill with an invalid mode must be skipped")
	}
	if len(cat.List()) != 1 {
		t.Errorf("expected exactly 1 skill, got %d", len(cat.List()))
	}
}
