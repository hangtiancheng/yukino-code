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

package memory

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
	"gopkg.in/yaml.v3"

	"github.com/hangtiancheng/yukino-code/yukino/logger"
)

var log = logger.CreateChildLogger("memory")

// malformedFingerprints deduplicates the "memory operation failed" log per
// file fingerprint (mtime:size), mirroring the per-manager map in TS
// manager.ts:142. A file that stays broken logs once per fingerprint change;
// a file that recovers clears its entry.
type malformedFingerprints struct {
	mu   sync.Mutex
	seen map[string]string
}

func newMalformedFingerprints() *malformedFingerprints {
	return &malformedFingerprints{seen: make(map[string]string)}
}

func (mf *malformedFingerprints) logOnce(path, fingerprint string, err error) {
	mf.mu.Lock()
	defer mf.mu.Unlock()
	if mf.seen[path] != fingerprint {
		mf.seen[path] = fingerprint
		log.Error("memory operation failed", "err", err, "path", path)
	}
}

func (mf *malformedFingerprints) clear(path string) {
	mf.mu.Lock()
	delete(mf.seen, path)
	mf.mu.Unlock()
}

// scanMalformed serves the standalone ScanMemoryFiles path, which has no
// Manager instance to own the cache (TS reaches it through the same
// MemoryManager; observable behaviour is identical except the dedup scope is
// process-wide instead of per-manager).
var scanMalformed = newMalformedFingerprints()

// nameCollatorTag mirrors the TS index sort: localeCompare with an undefined
// locale and sensitivity "base" (case- and accent-insensitive). The
// und-u-ks-level1 tag selects UCA strength 1 (primary weights only), the
// same algorithm ICU localeCompare uses; the stable sort keeps TS toSorted's
// tie order. The collator is created per call: collate.Collator is not safe
// for concurrent use, and multiple sessions build reminders in parallel.
var nameCollatorTag = language.MustParse("und-u-ks-level1")

// Manager wraps the dual auto-memory directories (user-level + project-level).
// It is a thin coordinator: the actual save/load happens via the agent's
// Write/Read tools (per Yukino's reference architecture). This struct exists
// to give the host a stable handle for the memory system-reminder and for the
// `/memory` slash command (list / clear).
type Manager struct {
	projectRoot string
	userMemDir  string // ~/.yukino/memory/ — user/feedback type memories
	memDir      string // <projectRoot>/.yukino/memory/ — project/reference type memories
	malformed   *malformedFingerprints
}

// NewManager creates a Manager for the given project root. Resolves both
// the user-level and project-level memory directories. Either may be empty
// (e.g. user-level resolves empty if $HOME is unset).
func NewManager(projectRoot string) *Manager {
	abs, err := filepath.Abs(projectRoot)
	if err != nil {
		abs = projectRoot
	}
	return &Manager{
		projectRoot: abs,
		userMemDir:  GetUserAutoMemPath(),
		memDir:      GetAutoMemPath(abs),
		malformed:   newMalformedFingerprints(),
	}
}

// Dir returns the project-level memory directory (with trailing separator).
// Kept for callers that only care about project-scoped state.
func (m *Manager) Dir() string {
	return m.memDir
}

// UserDir returns the user-level memory directory (with trailing separator).
func (m *Manager) UserDir() string {
	return m.userMemDir
}

// EntrypointPath returns the absolute path to the project-level MEMORY.md.
func (m *Manager) EntrypointPath() string {
	return filepath.Join(m.memDir, AutoMemEntrypointName)
}

// UserEntrypointPath returns the absolute path to the user-level MEMORY.md.
func (m *Manager) UserEntrypointPath() string {
	if m.userMemDir == "" {
		return ""
	}
	return filepath.Join(m.userMemDir, AutoMemEntrypointName)
}

// BuildSystemReminder builds the memory index injected into the conversation
// as a system-reminder message (TS manager.ts:212-261): one line per memory,
// `- [name] (type): description`. This content is re-sent to the model on
// every turn, so both a line-count and a byte-size cap are enforced at the
// output boundary; when either limit is exceeded a warning is appended so the
// model knows the index it received is incomplete (otherwise it would assume
// a memory does not exist and create a duplicate entry).
func (m *Manager) BuildSystemReminder() string {
	memories, err := m.LoadAll()
	if err != nil {
		// TS buildSystemReminder throws out of createRemoteAgent when the
		// index write fails; the Go host consumes the reminder through a
		// string-only boundary (bridge session setup), so the failure is
		// logged and the reminder is still built from the scanned memories.
		log.Error("memory operation failed", "err", err)
	}
	if len(memories) == 0 {
		return ""
	}

	lines := make([]string, len(memories))
	for i, mem := range memories {
		lines[i] = fmt.Sprintf("- [%s] (%s): %s", mem.Name, mem.Type, mem.Description)
	}

	lineCount := len(lines)
	joined := strings.Join(lines, "\n")
	byteCount := len(joined)
	overLines := lineCount > MaxEntrypointLines
	overBytes := byteCount > MaxEntrypointBytes

	if !overLines && !overBytes {
		return "Active memories:\n" + joined
	}

	capped := lines
	if len(capped) > MaxEntrypointLines {
		capped = capped[:MaxEntrypointLines]
	}
	body := capEntrypoint(strings.Join(capped, "\n"))

	var reason string
	switch {
	case overBytes && !overLines:
		reason = fmt.Sprintf("%s (limit: %s) — index entries are too long",
			formatFileSize(byteCount), formatFileSize(MaxEntrypointBytes))
	case overLines && !overBytes:
		reason = fmt.Sprintf("%d lines (limit: %d)", lineCount, MaxEntrypointLines)
	default:
		reason = fmt.Sprintf("%d lines and %s", lineCount, formatFileSize(byteCount))
	}

	return "Active memories:\n" + body + "\n\n" +
		"> WARNING: Partial " + AutoMemEntrypointName + ": " + reason +
		". Check topic files before adding duplicates. " +
		"Keep entries under ~200 chars; move details into topic files."
}

// MemoryFile describes one saved memory.
type MemoryFile struct {
	Path        string
	Name        string
	Description string
	Type        string // free-form; defaults to "reference" (TS: type ?? "reference")
	Content     string
}

// GetMemories returns one-line summaries of every memory file in the
// memory directories. Used by the `/memory list` slash command. Order is
// stable (user-level first, each dir sorted by filename). The line format
// mirrors the TS UI rendering: `[type] name — description`, with the
// frontmatter defaults applied at scan time (type "reference", description
// empty).
func (m *Manager) GetMemories() []string {
	files, err := m.LoadAll()
	if err != nil {
		// TS loadAll throws out of getMemories; the Go host consumes this
		// through a value-only boundary (bridge commands.Context.MemoryList),
		// so the failure is logged and the scanned memories are still served.
		log.Error("memory operation failed", "err", err)
	}
	out := make([]string, 0, len(files))
	for _, f := range files {
		out = append(out, fmt.Sprintf("[%s] %s — %s", f.Type, f.Name, f.Description))
	}
	return out
}

// LoadAll scans both the user-level and project-level memory directories for
// *.md files (excluding MEMORY.md), regenerates the MEMORY.md index, and
// returns the parsed memories (TS manager.ts:202-206). User-level files come
// first, then project-level. The error is a failed index write (TS
// writeFileSync/mkdirSync throw); the scanned memories are returned alongside
// it because they are independent of the index.
func (m *Manager) LoadAll() ([]MemoryFile, error) {
	memories := m.scanAllMemories()
	err := m.writeIndex(memories)
	return memories, err
}

// scanAllMemories reads every top-level *.md file (excluding MEMORY.md) in
// both memory directories (TS manager.ts:177-200). Malformed files are
// dropped by readMemory.
func (m *Manager) scanAllMemories() []MemoryFile {
	var memories []MemoryFile
	for _, dir := range []string{m.userMemDir, m.memDir} {
		if dir == "" {
			continue
		}
		// TS checks existsSync(dir) first (silent skip), then logs readdir
		// failures.
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			log.Error("memory operation failed", "err", err, "path", dir)
			continue
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			if !strings.HasSuffix(name, ".md") || name == AutoMemEntrypointName {
				continue
			}
			if mf, _, ok := m.readMemory(filepath.Join(dir, name)); ok {
				memories = append(memories, mf)
			}
		}
	}
	return memories
}

// readMemory parses one memory file with per-manager malformed-log dedup
// (TS manager.ts:149-175).
func (m *Manager) readMemory(fullPath string) (MemoryFile, int64, bool) {
	return readMemoryFileWith(fullPath, m.malformed)
}

// readMemoryFile parses one memory file, returning the memory, its mtime in
// ms since epoch, and whether it loaded (TS manager.ts:149-175). Files whose
// frontmatter is malformed (missing closing delimiter, invalid YAML) are
// excluded rather than partially loaded. Failures log once per fingerprint
// change through the process-wide scan cache.
func readMemoryFile(fullPath string) (MemoryFile, int64, bool) {
	return readMemoryFileWith(fullPath, scanMalformed)
}

func readMemoryFileWith(fullPath string, malformed *malformedFingerprints) (MemoryFile, int64, bool) {
	// TS: fingerprint stays "unknown" when statSync itself fails.
	fingerprint := "unknown"
	info, err := os.Stat(fullPath)
	if err == nil {
		fingerprint = fmt.Sprintf("%d:%d", info.ModTime().UnixMilli(), info.Size())
	}
	if err != nil {
		malformed.logOnce(fullPath, fingerprint, err)
		return MemoryFile{}, 0, false
	}
	data, err := os.ReadFile(fullPath)
	if err != nil {
		malformed.logOnce(fullPath, fingerprint, err)
		return MemoryFile{}, 0, false
	}
	parsed, err := parseFrontmatter(string(data))
	if err != nil {
		malformed.logOnce(fullPath, fingerprint, err)
		return MemoryFile{}, 0, false
	}
	malformed.clear(fullPath)
	// TS manager.ts:161-163: `parsed.name ?? basename(...)`, `parsed.type ??
	// "reference"` — the fallbacks fire only for an absent value, so a
	// present-but-empty name/type is kept as-is.
	name := parsed.name
	if !parsed.nameSet {
		name = strings.TrimSuffix(filepath.Base(fullPath), ".md")
	}
	typ := parsed.typ
	if !parsed.typSet {
		typ = "reference"
	}
	return MemoryFile{
		Path:        fullPath,
		Name:        name,
		Description: parsed.description,
		Type:        typ,
		Content:     parsed.body,
	}, info.ModTime().UnixMilli(), true
}

// frontmatterFields holds the parsed YAML frontmatter of a memory file. The
// Set flags carry the TS zod `??` semantics (manager.ts:161-163,577): the
// nullish fallbacks only fire for absent (or nullish) values, so a
// present-but-empty name/type must be kept as-is instead of falling back.
type frontmatterFields struct {
	name        string
	nameSet     bool
	description string
	typ         string
	typSet      bool
	body        string
}

// frontmatterRe matches a leading `---` block terminated by a closing `---`
// line (TS manager.ts:563).
var frontmatterRe = regexp.MustCompile(`\A---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)`)

// parseFrontmatter extracts name/description/type from YAML frontmatter
// (TS manager.ts:549-580). Content without a leading `---` is returned as a
// bare body; content that opens a frontmatter block but never closes it is an
// error so the caller excludes the file. The type field is read from the top
// level first; the nested metadata.type form is also accepted.
//
// Validation mirrors the TS FrontmatterSchema zod parse: the frontmatter must
// decode to a YAML mapping, and name/description/type (plus metadata.type)
// must be strings when present — a null or otherwise non-string value rejects
// the whole file (z.string().optional() accepts undefined but not null).
func parseFrontmatter(content string) (frontmatterFields, error) {
	if !strings.HasPrefix(content, "---") {
		return frontmatterFields{body: content}, nil
	}

	match := frontmatterRe.FindStringSubmatch(content)
	if match == nil {
		return frontmatterFields{}, errors.New("memory frontmatter is missing its closing delimiter")
	}

	raw := match[1]
	if strings.TrimSpace(raw) == "" {
		// TS: yaml.load yields undefined for an empty block and zod rejects.
		return frontmatterFields{}, errors.New("memory frontmatter is empty")
	}
	// TS body = content.slice(...).trim() — trim uses the JS whitespace set.
	body := trimJSSpace(content[len(match[0]):])

	var doc any
	if err := yaml.Unmarshal([]byte(raw), &doc); err != nil {
		return frontmatterFields{}, err
	}
	if doc == nil {
		// A comment-only block loads as undefined in js-yaml; zod rejects the
		// file the same way as an empty block.
		return frontmatterFields{}, errors.New("memory frontmatter is empty")
	}
	fields, ok := yamlMapping(doc)
	if !ok {
		return frontmatterFields{}, errors.New("memory frontmatter must be a YAML mapping")
	}

	fm := frontmatterFields{body: body}
	if v, present := fields["name"]; present {
		s, ok := v.(string)
		if !ok {
			return frontmatterFields{}, errors.New("memory frontmatter name must be a string")
		}
		fm.name, fm.nameSet = s, true
	}
	if v, present := fields["description"]; present {
		s, ok := v.(string)
		if !ok {
			return frontmatterFields{}, errors.New("memory frontmatter description must be a string")
		}
		fm.description = s
	}
	if v, present := fields["type"]; present {
		s, ok := v.(string)
		if !ok {
			return frontmatterFields{}, errors.New("memory frontmatter type must be a string")
		}
		fm.typ, fm.typSet = s, true
	}
	if v, present := fields["metadata"]; present {
		// TS z.looseObject({type}).optional() rejects null and non-objects.
		meta, ok := yamlMapping(v)
		if !ok {
			return frontmatterFields{}, errors.New("memory frontmatter metadata must be a mapping")
		}
		if t, present := meta["type"]; present {
			s, ok := t.(string)
			if !ok {
				return frontmatterFields{}, errors.New("memory frontmatter metadata type must be a string")
			}
			// TS: type = topType ?? nestedType — the top level wins even when
			// it is the empty string.
			if !fm.typSet {
				fm.typ, fm.typSet = s, true
			}
		}
	}
	return fm, nil
}

// yamlMapping coerces a decoded YAML node to a string-keyed mapping (js-yaml
// load always stringifies mapping keys, so a non-string key is still a valid
// object entry for the zod schema).
func yamlMapping(v any) (map[string]any, bool) {
	switch m := v.(type) {
	case map[string]any:
		return m, true
	case map[any]any:
		out := make(map[string]any, len(m))
		for k, val := range m {
			out[fmt.Sprint(k)] = val
		}
		return out, true
	}
	return nil, false
}

// RebuildIndex regenerates the MEMORY.md index from the current memory files
// (TS manager.ts:288-290). Called after the extraction subagent saves files;
// the error surfaces like the TS rebuildIndex throw (the extractor aborts on
// it).
func (m *Manager) RebuildIndex() error {
	return m.writeIndex(m.scanAllMemories())
}

// writeIndex writes a MEMORY.md index in the project memory directory: one
// line per memory, sorted alphabetically by name (case-insensitive),
// truncated at MaxEntrypointLines / MaxEntrypointBytes (TS manager.ts:292-324).
// Skips the write when the content is unchanged. The mkdir/write errors are
// returned like the TS mkdirSync/writeFileSync throws; an unreadable existing
// index is rewritten silently (TS catch).
func (m *Manager) writeIndex(memories []MemoryFile) error {
	if m.memDir == "" {
		return nil
	}
	type entry struct {
		name        string
		relPath     string
		description string
	}
	entries := make([]entry, 0, len(memories))
	for _, mem := range memories {
		rel, err := filepath.Rel(m.memDir, mem.Path)
		if err != nil || rel == "" {
			rel = filepath.Base(mem.Path)
		}
		entries = append(entries, entry{name: mem.Name, relPath: rel, description: mem.Description})
	}
	nameCollator := collate.New(nameCollatorTag)
	sort.SliceStable(entries, func(i, j int) bool {
		return nameCollator.CompareString(entries[i].name, entries[j].name) < 0
	})

	lines := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.description != "" {
			lines = append(lines, fmt.Sprintf("- [%s](%s) — %s", e.name, e.relPath, e.description))
		} else {
			lines = append(lines, fmt.Sprintf("- [%s](%s)", e.name, e.relPath))
		}
	}
	if len(lines) > MaxEntrypointLines {
		lines = lines[:MaxEntrypointLines]
	}
	content := capEntrypoint(strings.Join(lines, "\n")) + "\n"

	indexPath := filepath.Join(m.memDir, AutoMemEntrypointName)
	if err := os.MkdirAll(m.memDir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", m.memDir, err)
	}
	if existing, err := os.ReadFile(indexPath); err == nil && string(existing) == content {
		return nil
	}
	if err := os.WriteFile(indexPath, []byte(content), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", indexPath, err)
	}
	return nil
}

// Clear removes every *.md file (including MEMORY.md) in both memory
// directories. Used by the `/memory clear` slash command. A readdir failure
// throws out of the TS clear() loop (aborting the remaining directories); the
// Go host calls through a void boundary, so the failure is logged and the
// abort is reproduced by stopping.
func (m *Manager) Clear() {
	if err := clearDir(m.userMemDir); err != nil {
		log.Error("memory operation failed", "err", err)
		return
	}
	if err := clearDir(m.memDir); err != nil {
		log.Error("memory operation failed", "err", err)
	}
}

// clearDir removes every *.md file in dir. Per-file unlink failures log and
// continue (TS manager.ts:269-275); a readdir failure is returned like the
// TS readdirSync throw.
func clearDir(dir string) error {
	if dir == "" {
		return nil
	}
	// TS clear(): existsSync guard (silent skip), then readdirSync.
	if _, err := os.Stat(dir); err != nil {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		if err := os.Remove(filepath.Join(dir, e.Name())); err != nil {
			log.Error("memory operation failed", "err", err)
			continue
		}
	}
	return nil
}
