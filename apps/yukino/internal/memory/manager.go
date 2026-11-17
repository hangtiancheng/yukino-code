package memory

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/yukino-js/yukino/yukino/internal/config"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/logger"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

var log = logger.CreateChildLogger("memory")

type MemoryFile struct {
	Path        string
	Name        string
	Description string
	Type        string
	Content     string
}

// MemoryHeader is header metadata from a scanned memory file.
type MemoryHeader struct {
	Filename    string
	FilePath    string
	Scope       string
	MtimeMs     int64
	Description string
	Type        string
}

// RelevantMemory is one memory selected for surfacing into the main
// conversation.
type RelevantMemory struct {
	Path    string
	MtimeMs int64
}

type Manager struct {
	userDir    string
	projectDir string
	checker    *permissions.Checker
	malformed  map[string]string
}

func NewManager(cwd string, checker *permissions.Checker) *Manager {
	return &Manager{
		userDir:    GetUserAutoMemPath(),
		projectDir: GetAutoMemPath(cwd),
		checker:    checker,
		malformed:  map[string]string{},
	}
}

func (m *Manager) Dir() string     { return m.projectDir }
func (m *Manager) UserDir() string { return m.userDir }

func (m *Manager) allowed(name string, category tools.ToolCategory, args map[string]any) bool {
	if m.checker == nil {
		return true
	}
	return m.checker.CheckNamed(name, category, args).Effect == permissions.Allow
}

func (m *Manager) readMemory(fullPath string) (MemoryFile, int64, bool) {
	if !m.allowed("ReadFile", tools.CategoryRead, map[string]any{"file_path": fullPath}) {
		return MemoryFile{}, 0, false
	}
	fingerprint := "unknown"
	info, err := os.Stat(fullPath)
	if err == nil {
		fingerprint = fmt.Sprintf("%d:%d", info.ModTime().UnixMilli(), info.Size())
		data, readErr := storage.ReadPrivateFileSync(fullPath)
		if readErr == nil {
			parsed, parseErr := ParseFrontmatter(string(data))
			if parseErr == nil {
				delete(m.malformed, fullPath)
				name := parsed.Name
				if name == "" {
					name = strings.TrimSuffix(filepath.Base(fullPath), ".md")
				}
				memoryType := parsed.Type
				if memoryType == "" {
					memoryType = DefaultMemoryType
				}
				return MemoryFile{
					Path:        fullPath,
					Name:        name,
					Description: parsed.Description,
					Type:        memoryType,
					Content:     parsed.Body,
				}, info.ModTime().UnixMilli(), true
			}
			err = parseErr
		} else {
			err = readErr
		}
	}
	if m.malformed[fullPath] != fingerprint {
		m.malformed[fullPath] = fingerprint
		log.Error(map[string]any{"err": err, "path": fullPath}, "memory operation failed")
	}
	return MemoryFile{}, 0, false
}

func (m *Manager) scanAllMemories() []MemoryFile {
	var memories []MemoryFile
	for _, dir := range []string{m.userDir, m.projectDir} {
		if dir == "" {
			continue
		}
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		if !m.allowed("Glob", tools.CategoryRead, map[string]any{"path": dir, "pattern": "*.md"}) {
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			log.Error(map[string]any{"err": err, "path": dir}, "memory operation failed")
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || !strings.HasSuffix(name, ".md") || name == MemoryIndexName {
				continue
			}
			if memory, _, ok := m.readMemory(filepath.Join(dir, name)); ok {
				memories = append(memories, memory)
			}
		}
	}
	return memories
}

func (m *Manager) LoadAll() []MemoryFile {
	memories := m.scanAllMemories()
	if len(memories) > 0 {
		m.writeIndex(memories)
	}
	return memories
}

func (m *Manager) GetMemories() []MemoryFile {
	return m.LoadAll()
}

// BuildSystemReminder builds the memory index injected into the conversation
// as a system-reminder message (not the system prompt, which stays
// project-independent to preserve prompt caching).
func (m *Manager) BuildSystemReminder() string {
	memories := m.LoadAll()
	if len(memories) == 0 {
		return ""
	}
	lines := make([]string, 0, len(memories))
	for _, memory := range memories {
		lines = append(lines, fmt.Sprintf("- [%s] (%s): %s", memory.Name, memory.Type, memory.Description))
	}
	lineCount := len(lines)
	joined := strings.Join(lines, "\n")
	byteCount := len(joined)
	overLines := lineCount > MaxEntrypointLines
	overBytes := byteCount > MaxEntrypointBytes
	if !overLines && !overBytes {
		return ActiveMemoriesHeader + "\n" + joined
	}
	if overLines && lineCount > MaxEntrypointLines {
		lines = lines[:MaxEntrypointLines]
	}
	body := capEntrypoint(strings.Join(lines, "\n"))
	var reason string
	switch {
	case overBytes && !overLines:
		reason = fmt.Sprintf("%s (limit: %s) — index entries are too long", formatFileSize(byteCount), formatFileSize(MaxEntrypointBytes))
	case overLines && !overBytes:
		reason = fmt.Sprintf("%d lines (limit: %d)", lineCount, MaxEntrypointLines)
	default:
		reason = fmt.Sprintf("%d lines and %s", lineCount, formatFileSize(byteCount))
	}
	return ActiveMemoriesHeader + "\n" + body + "\n\n" + BuildPartialIndexWarning(reason)
}

func (m *Manager) Clear() {
	for _, dir := range []string{m.userDir, m.projectDir} {
		if dir == "" {
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || !strings.HasSuffix(name, ".md") {
				continue
			}
			if err := os.Remove(filepath.Join(dir, name)); err != nil {
				log.Error(map[string]any{"err": err}, "memory operation failed")
			}
		}
	}
}

// RebuildIndex scans both directories and writes MEMORY.md in the project
// directory: one line per memory, sorted alphabetically by name, truncated at
// the entrypoint caps.
func (m *Manager) RebuildIndex() {
	m.writeIndex(m.scanAllMemories())
}

type indexEntry struct {
	name        string
	relPath     string
	description string
}

func (m *Manager) writeIndex(memories []MemoryFile) {
	entries := make([]indexEntry, 0, len(memories))
	for _, memory := range memories {
		relPath, err := filepath.Rel(m.projectDir, memory.Path)
		if err != nil || relPath == "" {
			relPath = filepath.Base(memory.Path)
		}
		entries = append(entries, indexEntry{name: memory.Name, relPath: relPath, description: memory.Description})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		return strings.ToLower(entries[i].name) < strings.ToLower(entries[j].name)
	})
	lines := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.description != "" {
			lines = append(lines, "- ["+entry.name+"]("+entry.relPath+") — "+entry.description)
		} else {
			lines = append(lines, "- ["+entry.name+"]("+entry.relPath+")")
		}
	}
	if len(lines) > MaxEntrypointLines {
		lines = lines[:MaxEntrypointLines]
	}
	content := capEntrypoint(strings.Join(lines, "\n")) + "\n"
	indexPath := filepath.Join(m.projectDir, MemoryIndexName)
	if !m.allowed("WriteFile", tools.CategoryWrite, map[string]any{"file_path": indexPath}) {
		return
	}
	_ = storage.WithFileSyncLock(indexPath, func() error {
		if err := storage.MkdirPrivateSync(m.projectDir); err != nil {
			return err
		}
		if existing, err := storage.ReadPrivateFileSync(indexPath); err == nil && string(existing) == content {
			return nil
		}
		temporary := fmt.Sprintf("%s.%d.%s.tmp", indexPath, os.Getpid(), randomHex(8))
		defer os.Remove(temporary)
		if err := storage.WritePrivateFileSync(temporary, []byte(content), os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
			return err
		}
		return os.Rename(temporary, indexPath)
	})
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

// FindRelevantMemories scans memory headers from both dirs, asks the LLM to
// select the most relevant ones for the query, and returns their paths.
// Best-effort: selector failures return an empty result.
func (m *Manager) FindRelevantMemories(ctx context.Context, query string, client llm.Client, recentTools []string, alreadySurfaced map[string]struct{}) []RelevantMemory {
	var all []MemoryHeader
	if m.userDir != "" {
		all = append(all, m.scanMemoryHeaders(m.userDir, "user")...)
	}
	if m.projectDir != "" {
		all = append(all, m.scanMemoryHeaders(m.projectDir, "project")...)
	}
	candidates := make([]MemoryHeader, 0, len(all))
	for _, header := range all {
		if _, surfaced := alreadySurfaced[header.FilePath]; surfaced {
			continue
		}
		candidates = append(candidates, header)
	}
	if len(candidates) == 0 {
		return nil
	}
	manifest := FormatMemoryManifest(candidates)
	userMessage := BuildSelectorUserMessage(query, manifest, recentTools)

	conv := conversation.NewManager()
	conv.AddUserMessage(SelectMemoriesSystemPrompt + "\n\n" + userMessage)

	maxOutputTokens := config.DefaultMaxOutputTokens
	thinkingTokens := 0
	if budgetProvider, ok := client.(llm.OutputBudgetProvider); ok {
		budget := budgetProvider.GetOutputBudget()
		thinkingTokens = budget.ThinkingTokens
		if budget.MaxOutputTokens > 0 {
			maxOutputTokens = budget.MaxOutputTokens
		}
	}
	maxOutput := max(1, min(thinkingTokens+SelectorAnswerReserveTokens, maxOutputTokens))
	streamCtx := llm.WithMaxOutputTokens(ctx, maxOutput)
	streamCtx = llm.WithAnswerReserveTokens(streamCtx, SelectorAnswerReserveTokens)

	events, errs := client.Stream(streamCtx, conv, nil)
	var rawResponse strings.Builder
	completed := false
	for events != nil || errs != nil {
		select {
		case event, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			switch e := event.(type) {
			case llm.TextDelta:
				rawResponse.WriteString(e.Text)
			case llm.StreamEnd:
				completed = e.StopReason == "end_turn" || e.StopReason == "stop"
			}
		case err, ok := <-errs:
			if !ok {
				errs = nil
			} else if err != nil {
				log.Error(map[string]any{"err": err}, "memory operation failed")
				return nil
			}
		}
	}
	if !completed || ctx.Err() != nil {
		return nil
	}

	jsonText := extractJSONObject(rawResponse.String())
	if jsonText == "" {
		return nil
	}
	var parsed struct {
		SelectedMemories []string `json:"selected_memories"`
	}
	if err := json.Unmarshal([]byte(jsonText), &parsed); err != nil {
		log.Error(map[string]any{"err": err}, "memory operation failed")
		return nil
	}

	byKey := make(map[string]MemoryHeader, len(candidates)*2)
	for _, header := range candidates {
		byKey[header.FilePath] = header
		if _, exists := byKey[header.Filename]; !exists {
			byKey[header.Filename] = header
		}
	}
	var selected []RelevantMemory
	seen := map[string]bool{}
	for _, filename := range parsed.SelectedMemories {
		header, ok := byKey[filename]
		if !ok || seen[header.FilePath] {
			continue
		}
		selected = append(selected, RelevantMemory{Path: header.FilePath, MtimeMs: header.MtimeMs})
		seen[header.FilePath] = true
		if len(selected) >= MaxSelectedMemories {
			break
		}
	}
	return selected
}

func (m *Manager) scanMemoryHeaders(dir, scope string) []MemoryHeader {
	if _, err := os.Stat(dir); err != nil {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		log.Error(map[string]any{"err": err, "path": dir}, "memory operation failed")
		return nil
	}
	var headers []MemoryHeader
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".md") || name == MemoryIndexName {
			continue
		}
		memory, mtime, ok := m.readMemory(filepath.Join(dir, name))
		if !ok {
			continue
		}
		headers = append(headers, MemoryHeader{
			Filename:    name,
			FilePath:    memory.Path,
			Scope:       scope,
			MtimeMs:     mtime,
			Description: memory.Description,
			Type:        memory.Type,
		})
	}
	sort.SliceStable(headers, func(i, j int) bool {
		return headers[i].MtimeMs > headers[j].MtimeMs
	})
	if len(headers) > MaxEntrypointLines {
		headers = headers[:MaxEntrypointLines]
	}
	return headers
}

func (m *Manager) RenderReminder(memories []RelevantMemory) string {
	if len(memories) == 0 {
		return ""
	}
	parts := []string{RelevantMemoriesPreamble + "\n"}
	for _, memory := range memories {
		data, err := storage.ReadPrivateFileSync(memory.Path)
		if err != nil {
			continue
		}
		parts = append(parts, fmt.Sprintf("## Memory: %s (saved %s)\n", filepath.Base(memory.Path), MemoryAge(memory.MtimeMs)))
		if note := MemoryFreshnessText(memory.MtimeMs); note != "" {
			parts = append(parts, note+"\n")
		}
		parts = append(parts, string(data)+"\n\n---\n")
	}
	return capEntrypoint(strings.Join(parts, "\n"))
}

// capEntrypoint truncates index content to fit within the byte limit,
// preferring the last newline before the limit so only complete entries are
// retained, then backing up to a character boundary.
func capEntrypoint(content string) string {
	if len(content) <= MaxEntrypointBytes {
		return content
	}
	if nl := strings.LastIndex(content[:MaxEntrypointBytes], "\n"); nl > 0 {
		return content[:nl]
	}
	end := MaxEntrypointBytes
	for end > 0 && content[end]&0xc0 == 0x80 {
		end--
	}
	return content[:end]
}

func formatFileSize(bytes int) string {
	switch {
	case bytes < 1024:
		return fmt.Sprintf("%dB", bytes)
	case bytes < 1024*1024:
		return fmt.Sprintf("%.1fKB", float64(bytes)/1024)
	default:
		return fmt.Sprintf("%.1fMB", float64(bytes)/1024/1024)
	}
}

// extractJSONObject extracts a {...} JSON object from raw text, tolerating
// markdown fences or prose around it.
func extractJSONObject(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if strings.HasPrefix(trimmed, "{") {
		return trimmed
	}
	start := strings.Index(trimmed, "{")
	if start < 0 {
		return ""
	}
	end := strings.LastIndex(trimmed, "}")
	if end < start {
		return ""
	}
	return trimmed[start : end+1]
}
