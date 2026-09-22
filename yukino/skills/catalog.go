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
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hangtiancheng/yukino-code/yukino/logger"
	"github.com/hangtiancheng/yukino-code/yukino/utils"
)

var log = logger.CreateChildLogger("skills")

// Catalog is the in-memory registry of all loaded skills. Phase-1 entries
// contain only frontmatter (PromptBody empty, BodyLoaded false); GetFull
// triggers a phase-2 read of the body on each call (hot reload).
type Catalog struct {
	skills  map[string]*Skill
	sources map[string]string // skill name → "builtin" | "user" | "project" | absolute path
	// order preserves load order (user directory first, then project, each in
	// readdir order) so BuildSkillSection emits the same sequence as TS,
	// whose Map iteration is insertion order.
	order       []string
	workDir     string // remembered so Reload can re-scan the same three tiers
	hasReload   bool
	dirModTimes map[string]time.Time // skill directory path → last known modtime
}

func NewCatalog() *Catalog {
	return &Catalog{
		skills:      make(map[string]*Skill),
		sources:     make(map[string]string),
		dirModTimes: make(map[string]time.Time),
	}
}

// Register adds (or overwrites) a skill in the catalog. The source label is
// surfaced by /skills.
func (c *Catalog) Register(s *Skill, source string) {
	if _, exists := c.skills[s.Meta.Name]; !exists {
		c.order = append(c.order, s.Meta.Name)
	}
	c.skills[s.Meta.Name] = s
	c.sources[s.Meta.Name] = source
}

// Get returns the phase-1 skill (frontmatter only). PromptBody may be empty
// if the catalog was loaded in phase-1 mode.
func (c *Catalog) Get(name string) *Skill {
	return c.skills[name]
}

// Has reports whether a skill is loaded (TS: SkillCatalog.has,
// catalog.ts:230-232).
func (c *Catalog) Has(name string) bool {
	_, ok := c.skills[name]
	return ok
}

// GetFull returns the skill with its body loaded. Disk-backed skills hot
// reload exactly like TS catalog.get: when the file's mtime changed since the
// last load, the whole file is re-parsed and BOTH meta and body are refreshed
// (a frontmatter rename triggers a full catalog reload); on read/parse
// failure the cached version is retained. Embedded builtins are cache hits.
func (c *Catalog) GetFull(name string) (*Skill, error) {
	skill, ok := c.skills[name]
	if !ok {
		return nil, fmt.Errorf("unknown skill: %s", name)
	}
	if skill.SourceFile == "" {
		// Embedded skill — body was loaded at startup, nothing to refresh.
		return skill, nil
	}

	// Hot reload: re-read only when the file changed since the last load
	// (TS: entry.loadedMtimeMs > 0 && currentMtime !== entry.loadedMtimeMs;
	// an unreadable mtime skips reloading entirely).
	if skill.LoadedMtimeMs > 0 {
		info, err := os.Stat(skill.SourceFile)
		if err != nil {
			// Retain the cached version if reading fails (TS get()'s catch logs).
			log.Error("skills operation failed", "err", err)
		} else {
			currentMtime := info.ModTime().UnixMilli()
			if currentMtime != skill.LoadedMtimeMs {
				raw, rerr := os.ReadFile(skill.SourceFile)
				if rerr != nil {
					log.Error("skills operation failed", "err", rerr)
				} else if parsed, perr := parseSkillFile(string(raw)); perr == nil {
					if parsed.Meta.Name != name {
						// Rebuild indexes and precedence when frontmatter
						// renames a skill (TS: this.reload()).
						c.Reload(c.workDir)
						renamed, found := c.skills[name]
						if !found {
							return nil, fmt.Errorf("unknown skill: %s", name)
						}
						return renamed, nil
					}
					skill.Meta = parsed.Meta
					skill.PromptBody = parsed.Body
					skill.BodyLoaded = true
					skill.LoadedMtimeMs = currentMtime
					return skill, nil
				}
				// Retain the cached version if parsing fails — a
				// single bad write should not cause a skill to vanish.
			}
		}
	}
	return c.ensureBody(skill)
}

// ensureBody performs the phase-2 body read for entries whose body was never
// loaded, preserving the cached body on failure.
func (c *Catalog) ensureBody(skill *Skill) (*Skill, error) {
	if skill.BodyLoaded {
		return skill, nil
	}
	if err := loadSkillBody(skill); err != nil {
		if skill.PromptBody == "" {
			return nil, err
		}
		return skill, err
	}
	return skill, nil
}

// List returns metadata for every loaded skill in catalog load order
// (registration order, with an overwritten name keeping its first position) —
// exactly like TS's Map insertion order in catalog.list() (catalog.ts:182-184).
func (c *Catalog) List() []SkillMeta {
	result := make([]SkillMeta, 0, len(c.order))
	for _, name := range c.order {
		if s, ok := c.skills[name]; ok {
			result = append(result, s.Meta)
		}
	}
	return result
}

// Source returns the origin label for a skill ("builtin", "user", "project",
// or a path). Returns "" if the skill isn't loaded.
func (c *Catalog) Source(name string) string {
	return c.sources[name]
}

// Reload re-scans all three tiers (builtin + user + project) and rebuilds
// the catalog in place. Used by `/skills reload` and tests.
func (c *Catalog) Reload(workDir string) {
	fresh := LoadCatalog(workDir)
	c.skills = fresh.skills
	c.sources = fresh.sources
	c.order = fresh.order
	c.workDir = fresh.workDir
	c.dirModTimes = fresh.dirModTimes
}

// NeedsReload checks whether the skill directories' modtimes have changed
// since the catalog was last loaded. A changed modtime indicates a skill was
// added or removed (file edits within existing skills are already handled by
// GetFull's per-call re-read). TS needsReload (catalog.ts:77-91): iterate the
// recorded directories; a stat failure reloads only when a real mtime was
// recorded (the zero time stands for TS's null).
func (c *Catalog) NeedsReload() bool {
	for dir, recorded := range c.dirModTimes {
		info, err := os.Stat(dir)
		if err != nil {
			if recorded.IsZero() {
				continue
			}
			return true // directory disappeared
		}
		if !info.ModTime().Equal(recorded) {
			return true
		}
	}
	return false
}

// snapshotDirModTimes records current modtimes of every watched directory:
// the skill-dir roots plus any subdirectory recorded during the scan, so a
// directory created after a missing-dirs load is still detected
// (TS: snapshotDirModTimes, catalog.ts:97-110).
func (c *Catalog) snapshotDirModTimes() {
	watched := make(map[string]bool, len(c.dirModTimes)+2)
	for _, dir := range skillDirPaths(c.workDir) {
		watched[dir] = true
	}
	for dir := range c.dirModTimes {
		watched[dir] = true
	}
	for dir := range watched {
		info, err := os.Stat(dir)
		if err != nil {
			c.dirModTimes[dir] = time.Time{}
			continue
		}
		c.dirModTimes[dir] = info.ModTime()
	}
}

// skillDirPaths returns the user-global and project skill directory paths:
// ~/.agents/skills first, then $workDir/.agents/skills (highest priority)
// (TS: skillDirPaths, catalog.ts:112-116).
func skillDirPaths(workDir string) []string {
	var dirs []string
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(home, ".agents", "skills"))
	}
	if workDir != "" {
		dirs = append(dirs, filepath.Join(workDir, ".agents", "skills"))
	}
	return dirs
}

// LoadCatalog builds a phase-1 catalog by merging three tiers, with later
// sources overriding earlier ones by name (project wins over user wins over
// builtin):
//  1. internal/skills/builtins/* (embedded via go:embed, lowest priority)
//  2. ~/.agents/skills/         (user global)
//  3. $workDir/.agents/skills/  (project, highest priority)
//
// Only frontmatter is read at this stage; PromptBody stays empty until
// GetFull is called. Parse failures on individual skills are silently
// skipped — one bad file must not bring down the whole catalog.
func LoadCatalog(workDir string) *Catalog {
	c := NewCatalog()
	c.workDir = workDir

	// Tier 1: embedded builtins
	for _, s := range LoadBuiltins() {
		c.Register(s, "builtin")
	}

	// Tier 2: user global
	if home, err := os.UserHomeDir(); err == nil {
		loadTierInto(c, filepath.Join(home, ".agents", "skills"), "user")
	}

	// Tier 3: project
	loadTierInto(c, filepath.Join(workDir, ".agents", "skills"), "project")

	c.snapshotDirModTimes()
	return c
}

// LoadFromDirectory loads every subdirectory of dir as a skill. Used by tests
// and one-off callers that just want a single tier loaded. Body is read
// eagerly (no two-phase split) so existing test code that touches
// skill.PromptBody continues to work.
func LoadFromDirectory(dir string) (*Catalog, error) {
	c := NewCatalog()
	loadTierEager(c, dir, dir)
	return c, nil
}

// LoadSkills is the legacy two-tier loader kept for backward compatibility
// with code that still pre-loads bodies eagerly. New callers should use
// LoadCatalog + GetFull. Order: user global → project.
func LoadSkills(workDir string) *Catalog {
	c := NewCatalog()
	c.workDir = workDir
	if home, err := os.UserHomeDir(); err == nil {
		loadTierEager(c, filepath.Join(home, ".agents", "skills"), "user")
	}
	loadTierEager(c, filepath.Join(workDir, ".agents", "skills"), "project")
	return c
}

// loadTierInto walks a single tier and registers each subdir as a phase-1
// skill (TS: scanDirectory + loadSkill, catalog.ts:118-180).
func loadTierInto(c *Catalog, dir, source string) {
	c.scanDirectory(dir, source, false)
}

// loadTierEager is like loadTierInto but also reads the body. Used by legacy
// LoadSkills / LoadFromDirectory to preserve old behavior.
func loadTierEager(c *Catalog, dir, source string) {
	c.scanDirectory(dir, source, true)
}

// scanDirectory mirrors TS scanDirectory (catalog.ts:118-146): every entry is
// stat'ed (following symlinks, like TS statSync); directories are recorded in
// dirModTimes and loaded when they contain a SKILL.md. A broken symlink or a
// concurrently removed entry must not hide other skills.
//
// Residual: os.ReadDir returns entries sorted by name while TS readdirSync
// returns OS order. Later duplicates win in both, so when one tier holds two
// directories declaring the same frontmatter name (or for list()/section
// ordering), the winner/sequence can differ from TS. Reproducing OS order
// would need raw syscalls — deliberately not done.
func (c *Catalog) scanDirectory(dir, source string, eager bool) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Error("skills operation failed", "err", err)
		}
		return
	}
	for _, entry := range entries {
		fullPath := filepath.Join(dir, entry.Name())
		info, err := os.Stat(fullPath)
		if err != nil {
			// A broken symlink or a concurrently removed entry must not hide other skills.
			log.Error("skills operation failed", "err", err)
			continue
		}
		if !info.IsDir() {
			continue
		}
		c.dirModTimes[fullPath] = info.ModTime()
		// TS: existsSync(SKILL.md) — a directory without the manifest is
		// skipped silently.
		if _, err := os.Stat(filepath.Join(fullPath, "SKILL.md")); err != nil {
			continue
		}
		skill, err := parseFrontmatterOnly(fullPath)
		if err != nil {
			continue // read/parse failures are logged where they occur
		}
		if eager {
			_ = loadSkillBody(skill)
		}
		c.Register(skill, source)
	}
}

// xmlEscaper escapes text embedded in the skill XML envelopes
// (TS: escapeSkillXml, catalog.ts:295-300).
var xmlEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

// EscapeSkillXml escapes &, < and > for the skill XML envelopes.
func EscapeSkillXml(text string) string { return xmlEscaper.Replace(text) }

// BuildSkillSection renders the metadata-only conversation reminder; bodies
// load on demand without changing the system prefix (TS: buildSkillSection,
// catalog.ts:302-329). Returns "" when the catalog is empty.
func BuildSkillSection(catalog *Catalog, workDir string) string {
	if catalog == nil {
		return ""
	}
	metas := catalog.List()
	if len(metas) == 0 {
		return ""
	}
	// Emit in catalog load order (user directory first, then project; each in
	// readdir order), exactly like TS catalog.list() — an alphabetical sort
	// would make the assembled section differ from the TS bytes.

	skillsDir := filepath.Join(workDir, ".agents", "skills")
	lines := []string{
		"## Skills",
		`Load relevant instructions with LoadSkill {name: "<skill-name>"}, or user command /<skill-name>. Mode inline activates in this conversation; fork runs in a subagent when available, otherwise inline. Load resources only as needed, relative to the skill directory. Tool access remains host-controlled.`,
		`InstallSkill {source: "<local path or raw SKILL.md URL>"} makes skills available immediately. skills.sh pages and GitHub tree/blob pages are not supported.`,
		"Create skills under the following directory as <skill-name>/SKILL.md:",
		"<skills-directory>" + EscapeSkillXml(skillsDir) + "</skills-directory>",
		"<available-skills>",
	}
	for _, meta := range metas {
		oneLine := strings.Join(strings.Fields(meta.Description), " ")
		desc := oneLine
		// TS slices by UTF-16 code units (oneLine.length > 200), not runes.
		if utils.UTF16Len(oneLine) > 200 {
			desc = utils.TruncateUTF16(oneLine, 200) + "…"
		}
		mode := meta.Mode
		if mode == "" {
			mode = "inline"
		}
		lines = append(lines,
			"<skill><name>"+EscapeSkillXml(meta.Name)+"</name><description>"+EscapeSkillXml(desc)+"</description><mode>"+mode+"</mode></skill>")
	}
	lines = append(lines, "</available-skills>")
	return strings.Join(lines, "\n")
}
