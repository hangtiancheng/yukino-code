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

// Port of the TS tests/prompt-contracts.test.ts skill-section assertions:
// metadata is XML-escaped, the catalog section stays body-free, and an empty
// catalog emits nothing.

func TestBuildSkillSectionEscapingContract(t *testing.T) {
	if got := BuildSkillSection(NewCatalog(), "/project"); got != "" {
		t.Fatalf("empty catalog must render \"\", got %q", got)
	}
	if got := BuildSkillSection(nil, "/project"); got != "" {
		t.Fatalf("nil catalog must render \"\", got %q", got)
	}

	skill := &Skill{
		Meta: SkillMeta{
			Name:        "demo<&>",
			Description: "Read <file> & inspect\n  safely",
			Mode:        "fork",
		},
		SourceDir:   "/skills/<demo>&",
		PromptBody:  "Run the existing script; do not change it.",
		IsDirectory: true,
	}
	catalog := NewCatalog()
	catalog.Register(skill, skill.SourceDir)

	prompt := BuildSkillSection(catalog, "/project/<x>&")
	for _, text := range []string{
		"<name>demo&lt;&amp;&gt;</name>",
		"<description>Read &lt;file&gt; &amp; inspect safely</description>",
		"/project/&lt;x&gt;&amp;",
		"<mode>fork</mode>",
		"/<skill-name>",
		"LoadSkill",
		"InstallSkill",
		"host-controlled",
	} {
		if !strings.Contains(prompt, text) {
			t.Errorf("skill section lost %q", text)
		}
	}
	if strings.Contains(prompt, skill.PromptBody) {
		t.Error("skill section must stay body-free (bodies load on demand)")
	}
	if len(prompt) >= 1100 {
		t.Errorf("skill section length = %d, want < 1100", len(prompt))
	}
}
