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
	"strings"
	"testing"

	"github.com/hangtiancheng/yukino-code/yukino/tools"
)

// stubHost captures every SkillHost call so tests can verify the executor
// fired the right side effects. Implements both SkillHost and SkillForkHost
// so the same fixture covers RunInline and RunFork.
type stubHost struct {
	activated      map[string]string
	registry       *tools.Registry
	parentSnapshot string // text returned by SnapshotParentMessages
	snapshotCount  int    // last requested snapshot size (0 = never called)
	subAgentPrompt string
	subAgentReply  string
	subAgentErr    error
}

func newStubHost(reg *tools.Registry) *stubHost {
	return &stubHost{activated: map[string]string{}, registry: reg}
}

func (s *stubHost) ActivateSkill(name, body string) { s.activated[name] = body }
func (s *stubHost) ToolRegistry() *tools.Registry   { return s.registry }
func (s *stubHost) SnapshotParentMessages(count int) string {
	s.snapshotCount = count
	return s.parentSnapshot
}

func (s *stubHost) RunSubAgent(_ context.Context, prompt string) (string, error) {
	s.subAgentPrompt = prompt
	return s.subAgentReply, s.subAgentErr
}

func TestRunInlineActivates(t *testing.T) {
	reg := tools.NewRegistry()
	host := newStubHost(reg)
	skill := &Skill{
		Meta: SkillMeta{
			Name: "commit",
			Mode: "inline",
		},
		PromptBody: "Body with $ARGUMENTS",
		BodyLoaded: true,
	}

	prompt, err := RunInline(context.Background(), skill, "extra ctx", host)
	if err != nil {
		t.Fatalf("RunInline: %v", err)
	}
	// The envelope: instructions first, then metadata, body with $ARGUMENTS
	// substituted, and the arguments tag (TS: executor.ts:30-40).
	if !strings.HasPrefix(prompt, skillInstructions+"\n\n") {
		t.Errorf("prompt missing SKILL_INSTRUCTIONS prefix: %q", prompt)
	}
	if !strings.Contains(prompt, "<skill-body>\nBody with extra ctx\n</skill-body>") {
		t.Errorf("body did not interpolate $ARGUMENTS inside <skill-body>: %q", prompt)
	}
	if !strings.Contains(prompt, "<skill-metadata><name>commit</name><directory></directory></skill-metadata>") {
		t.Errorf("prompt missing skill metadata: %q", prompt)
	}
	if !strings.HasSuffix(prompt, "<skill-arguments>extra ctx</skill-arguments>") {
		t.Errorf("prompt missing skill arguments suffix: %q", prompt)
	}
	if host.activated["commit"] != prompt {
		t.Errorf("ActivateSkill did not receive the envelope: %q", host.activated["commit"])
	}
}

func TestRunForkPrependsParentContext(t *testing.T) {
	reg := tools.NewRegistry()
	host := newStubHost(reg)
	host.parentSnapshot = "user: msg1\nassistant: msg2"
	host.subAgentReply = "review complete"

	skill := &Skill{
		Meta: SkillMeta{
			Name:        "review",
			Mode:        "fork",
			ForkContext: "recent",
		},
		PromptBody: "Review this: $ARGUMENTS",
	}

	out, err := RunFork(context.Background(), skill, "main.go", host)
	if err != nil {
		t.Fatalf("RunFork: %v", err)
	}
	if out != "review complete" {
		t.Errorf("unexpected fork output: %q", out)
	}
	// recent snapshots the last 5 parent messages (TS: executor.ts:85-87).
	if host.snapshotCount != 5 {
		t.Errorf("recent fork must request 5 messages; got %d", host.snapshotCount)
	}
	wantPrefix := "<parent-context>\nuser: msg1\nassistant: msg2\n</parent-context>\n\n" + skillInstructions
	if !strings.HasPrefix(host.subAgentPrompt, wantPrefix) {
		t.Errorf("fork prompt missing <parent-context> prefix: %q", host.subAgentPrompt)
	}
	if !strings.Contains(host.subAgentPrompt, "<skill-body>\nReview this: main.go\n</skill-body>") {
		t.Errorf("sub-agent prompt missing rendered body: %q", host.subAgentPrompt)
	}
	if !strings.Contains(host.subAgentPrompt, "<skill-arguments>main.go</skill-arguments>") {
		t.Errorf("sub-agent prompt missing args: %q", host.subAgentPrompt)
	}
}

func TestRunForkFullContextSnapshots100(t *testing.T) {
	reg := tools.NewRegistry()
	host := newStubHost(reg)
	host.parentSnapshot = "full history"
	skill := &Skill{
		Meta:       SkillMeta{Name: "deep", Mode: "fork", ForkContext: "full"},
		PromptBody: "body",
	}
	if _, err := RunFork(context.Background(), skill, "", host); err != nil {
		t.Fatalf("RunFork: %v", err)
	}
	if host.snapshotCount != 100 {
		t.Errorf("full fork must request 100 messages; got %d", host.snapshotCount)
	}
	if !strings.Contains(host.subAgentPrompt, "<parent-context>\nfull history\n</parent-context>") {
		t.Errorf("fork prompt missing parent context: %q", host.subAgentPrompt)
	}
}

func TestRunForkEscapesParentContext(t *testing.T) {
	reg := tools.NewRegistry()
	host := newStubHost(reg)
	host.parentSnapshot = "user said <script> & \"bye\""
	skill := &Skill{
		Meta:       SkillMeta{Name: "esc", Mode: "fork", ForkContext: "recent"},
		PromptBody: "body",
	}
	if _, err := RunFork(context.Background(), skill, "", host); err != nil {
		t.Fatalf("RunFork: %v", err)
	}
	if !strings.Contains(host.subAgentPrompt, "<parent-context>\nuser said &lt;script&gt; &amp; \"bye\"\n</parent-context>") {
		t.Errorf("parent context not XML-escaped: %q", host.subAgentPrompt)
	}
}

func TestRunForkContextNone(t *testing.T) {
	reg := tools.NewRegistry()
	host := newStubHost(reg)
	host.parentSnapshot = "should not leak"
	skill := &Skill{
		Meta:       SkillMeta{Name: "isolated", Mode: "fork", ForkContext: "none"},
		PromptBody: "Pure isolation.",
	}
	_, err := RunFork(context.Background(), skill, "", host)
	if err != nil {
		t.Fatalf("RunFork: %v", err)
	}
	if host.snapshotCount != 0 {
		t.Errorf("none mode must not snapshot parent messages; got count %d", host.snapshotCount)
	}
	if strings.Contains(host.subAgentPrompt, "<parent-context>") {
		t.Errorf("none mode must not prepend parent context: %q", host.subAgentPrompt)
	}
	if strings.Contains(host.subAgentPrompt, "should not leak") {
		t.Errorf("parent conversation leaked into fork prompt: %q", host.subAgentPrompt)
	}
}

func TestRunForkPropagatesAgentError(t *testing.T) {
	reg := tools.NewRegistry()
	host := newStubHost(reg)
	host.subAgentErr = errors.New("upstream failure")

	skill := &Skill{Meta: SkillMeta{Name: "review", Mode: "fork"}}
	_, err := RunFork(context.Background(), skill, "", host)
	if err == nil || !strings.Contains(err.Error(), "upstream") {
		t.Fatalf("expected upstream failure, got %v", err)
	}
}

func TestParseSkillPromptRoundTrip(t *testing.T) {
	skill := &Skill{
		Meta:       SkillMeta{Name: "demo"},
		PromptBody: "body & <stuff>\nmulti-line $ARGUMENTS",
		SourceDir:  "/tmp/demo & co",
	}
	prompt := BuildSkillPrompt(skill, "a & <b>")
	parsed := ParseSkillPrompt(prompt)
	if parsed == nil {
		t.Fatalf("ParseSkillPrompt did not recognise the envelope: %q", prompt)
	}
	if parsed.Name != "demo" {
		t.Errorf("Name = %q", parsed.Name)
	}
	if parsed.Directory != "/tmp/demo & co" {
		t.Errorf("Directory = %q", parsed.Directory)
	}
	if parsed.Body != "body & <stuff>\nmulti-line a & <b>" {
		t.Errorf("Body = %q", parsed.Body)
	}
	if parsed.Args != "a & <b>" {
		t.Errorf("Args = %q", parsed.Args)
	}
}

func TestParseSkillPromptRejectsForeignText(t *testing.T) {
	if got := ParseSkillPrompt("not an envelope"); got != nil {
		t.Errorf("expected nil for foreign text, got %+v", got)
	}
	if got := ParseSkillPrompt(skillInstructions + "\n\ngarbage"); got != nil {
		t.Errorf("expected nil for garbage after the prefix, got %+v", got)
	}
}

func TestLoadSkillToolReturnsConfirmation(t *testing.T) {
	reg := tools.NewRegistry()
	cat := NewCatalog()
	cat.Register(&Skill{
		Meta:       SkillMeta{Name: "commit", Mode: "inline"},
		PromptBody: "do commit stuff",
		BodyLoaded: true,
	}, "builtin")

	host := newStubHost(reg)
	tool := &LoadSkillTool{Catalog: cat, Host: host}
	res := tool.Execute(context.Background(), map[string]any{"name": "commit"})
	if res.IsError {
		t.Fatalf("unexpected error: %s", res.Output)
	}
	// TS load-skill-tool.ts:107-111: "Skill '<name>' activated." + the envelope.
	if !strings.HasPrefix(res.Output, "Skill 'commit' activated.\n\n") {
		t.Errorf("missing activation confirmation: %q", res.Output)
	}
	if !strings.Contains(res.Output, "<skill-body>\ndo commit stuff\n</skill-body>") {
		t.Errorf("expected full SOP envelope in output: %q", res.Output)
	}
	if !strings.HasPrefix(host.activated["commit"], skillInstructions) {
		t.Errorf("ActivateSkill did not receive the envelope: %q", host.activated["commit"])
	}
}

func TestLoadSkillToolUnknown(t *testing.T) {
	reg := tools.NewRegistry()
	cat := NewCatalog()
	cat.Register(&Skill{Meta: SkillMeta{Name: "commit", Mode: "inline"}, PromptBody: "x", BodyLoaded: true}, "test")
	host := newStubHost(reg)
	tool := &LoadSkillTool{Catalog: cat, Host: host}

	res := tool.Execute(context.Background(), map[string]any{"name": "missing"})
	if !res.IsError {
		t.Fatalf("expected error for missing skill")
	}
	// TS load-skill-tool.ts:78-86 lists the available skills.
	if !strings.Contains(res.Output, "Skill 'missing' not found. Available skills: commit") {
		t.Errorf("unexpected not-found output: %q", res.Output)
	}
}
