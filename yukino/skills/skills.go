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

// SkillMeta is the validated frontmatter of a skill (TS: SkillMeta,
// index.ts:23-29). Fields are filled by parseSkillFile, which enforces the
// TS zod schema: name is a required non-empty string, mode and fork_context
// are enums, and any violation skips the whole skill.
type SkillMeta struct {
	Name        string
	Description string
	// Mode selects the execution mode: "inline" (default) injects the skill
	// prompt into the current conversation; "fork" runs it in an isolated
	// sub-agent. Always resolved at parse time — including the legacy
	// `context: fork` spelling — so it is never empty for disk-loaded skills.
	Mode string
	// Model overrides the LLM used for this skill. Empty = inherit main loop.
	Model string
	// ForkContext controls how much of the parent conversation is snapshotted
	// into the fork prompt: "full" (last 100 messages), "recent" (last 5),
	// "none" (no parent context). Empty means unset and behaves like "none"
	// (TS: executor.ts:83). Only meaningful when Mode == "fork".
	ForkContext string
}

// IsFork reports whether the skill should run in fork mode.
func (m SkillMeta) IsFork() bool { return m.Mode == "fork" }

type Skill struct {
	Meta       SkillMeta
	PromptBody string
	SourceDir  string
	// SourceFile is the absolute path to SKILL.md, used for hot reloading
	// (TS: entry.filePath). Empty for embedded builtins.
	SourceFile string
	// LoadedMtimeMs is the file modification time (ms) when the skill was last
	// loaded. 0 means the mtime could not be read, so hot reloading is skipped
	// (TS: entry.loadedMtimeMs).
	LoadedMtimeMs int64
	// IsDirectory marks skills whose SourceDir contains additional resources (references/, scripts/).
	// True for directory-type skills that have supporting files on disk alongside SKILL.md.
	// False only for embedded skills that have no real directory on disk to access at runtime.
	IsDirectory bool
	// BodyLoaded marks whether PromptBody has been read from disk. Phase-1 loading only reads
	// frontmatter; the body stays empty until GetFull triggers a read.
	BodyLoaded bool
}
