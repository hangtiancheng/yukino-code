package extractor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/yukino-js/yukino/yukino/internal/agent"
	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/llm"
	"github.com/yukino-js/yukino/yukino/internal/logger"
	"github.com/yukino-js/yukino/yukino/internal/memory"
	"github.com/yukino-js/yukino/yukino/internal/permissions"
	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/tools"
)

var log = logger.CreateChildLogger("memory")

type ParsedTextMemory struct {
	Name        string
	Type        string
	Description string
	Body        string
}

// Extractor implements the background memory-extraction subagent.
type Extractor struct {
	client llm.Client
	cwd    string

	mu         sync.Mutex
	inProgress bool
	pending    *string
	cancel     context.CancelFunc
	completion chan struct{}
	disposed   bool
}

func New(client llm.Client, cwd string) *Extractor {
	return &Extractor{client: client, cwd: cwd}
}

func (e *Extractor) Extract(ctx context.Context, conversationSummary string) []string {
	e.mu.Lock()
	if e.disposed {
		e.mu.Unlock()
		return nil
	}
	if e.inProgress {
		e.pending = &conversationSummary
		e.mu.Unlock()
		return nil
	}
	e.mu.Unlock()
	return e.runExtraction(ctx, conversationSummary)
}

// Dispose stops any in-flight extraction and awaits its settlement.
func (e *Extractor) Dispose() {
	e.mu.Lock()
	e.disposed = true
	e.pending = nil
	cancel := e.cancel
	completion := e.completion
	e.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if completion != nil {
		<-completion
	}
}

func (e *Extractor) runExtraction(parent context.Context, conversationSummary string) []string {
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	e.mu.Lock()
	e.inProgress = true
	e.cancel = cancel
	e.completion = done
	e.mu.Unlock()

	var result []string
	var failure error
	func() {
		defer close(done)
		defer func() {
			e.mu.Lock()
			e.inProgress = false
			e.cancel = nil
			e.completion = nil
			pending := e.pending
			e.pending = nil
			disposed := e.disposed
			e.mu.Unlock()
			cancel()
			if pending != nil && !disposed {
				trailing := e.runExtraction(parent, *pending)
				result = append(result, trailing...)
			}
		}()
		result, failure = e.doExtract(ctx, conversationSummary)
		if failure != nil {
			log.Error(map[string]any{"err": failure}, "memory extractor failed")
		}
	}()
	if failure != nil {
		return nil
	}
	return result
}

// scanExistingMemories scans memory files and builds a manifest for LLM
// deduplication.
func (e *Extractor) scanExistingMemories() string {
	dirs := []string{
		memory.GetAutoMemPath(e.cwd),
		memory.GetUserAutoMemPath(),
	}
	var entries []string
	checker := memory.NewMemoryPermissionChecker(e.cwd, false)
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		if !allowed(checker, "Glob", tools.CategoryRead, map[string]any{"path": dir, "pattern": "*.md"}) {
			continue
		}
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			continue
		}
		dirEntries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range dirEntries {
			file := entry.Name()
			if entry.IsDir() || !strings.HasSuffix(file, ".md") || file == memory.MemoryIndexName {
				continue
			}
			filePath := filepath.Join(dir, file)
			if !allowed(checker, "ReadFile", tools.CategoryRead, map[string]any{"file_path": filePath}) {
				continue
			}
			data, err := storage.ReadPrivateFileSync(filePath)
			if err != nil {
				continue
			}
			memoryType := memory.DefaultMemoryType
			if match := memory.FrontmatterTypeRe.FindStringSubmatch(string(data)); match != nil {
				memoryType = strings.TrimSpace(match[1])
			}
			desc := ""
			if match := memory.FrontmatterDescriptionRe.FindStringSubmatch(string(data)); match != nil {
				desc = strings.TrimSpace(match[1])
			}
			entries = append(entries, fmt.Sprintf("- [%s] %s: %s", memoryType, file, desc))
		}
	}
	if len(entries) == 0 {
		return ""
	}
	return strings.Join(entries, "\n")
}

func (e *Extractor) doExtract(ctx context.Context, conversationSummary string) ([]string, error) {
	extractionPrompt := memory.BuildExtractionPrompt(
		conversationSummary,
		e.scanExistingMemories(),
		memory.GetUserAutoMemPath(),
		memory.GetAutoMemPath(e.cwd),
	)

	subRegistry := memory.NewTaskToolRegistry()
	subChecker := memory.NewMemoryPermissionChecker(e.cwd, false)

	forkedConv := conversation.NewManager()
	forkedConv.AddUserMessage(extractionPrompt)

	subagent := agent.New(e.client, subRegistry, e.protocol())
	subagent.Checker = subChecker
	subagent.WorkDir = e.cwd
	subagent.MaxIterations = memory.ExtractionMaxIterations

	var streamedText strings.Builder
	for event := range subagent.Run(ctx, forkedConv) {
		switch ev := event.(type) {
		case agent.ErrorEvent:
			return nil, errors.New(ev.Message)
		case agent.StreamText:
			streamedText.WriteString(ev.Text)
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	writtenPaths := memory.ExtractWrittenPaths(forkedConv.GetMessages())
	var memoryPaths []string
	for _, path := range writtenPaths {
		if filepath.Base(path) != memory.MemoryIndexName {
			memoryPaths = append(memoryPaths, path)
		}
	}
	var saved []string
	if len(memoryPaths) > 0 {
		for _, path := range memoryPaths {
			saved = append(saved, strings.TrimSuffix(filepath.Base(path), ".md"))
		}
	} else {
		saved = e.persistTextMemories(streamedText.String())
	}
	if len(saved) > 0 {
		manager := memory.NewManager(e.cwd, subChecker)
		manager.RebuildIndex()
	}
	return saved, nil
}

// persistTextMemories parses structured MEMORY_NAME/... text blocks and
// persists them by type. Returns written memory names (without extensions).
func (e *Extractor) persistTextMemories(text string) []string {
	memories := parseTextMemoryBlocks(text)
	if len(memories) == 0 {
		return nil
	}
	var saved []string
	for _, mem := range memories {
		dir := e.dirForMemoryType(mem.Type)
		filePath := filepath.Join(dir, mem.Name+".md")
		if !allowed(memory.NewMemoryPermissionChecker(e.cwd, false), "WriteFile", tools.CategoryWrite, map[string]any{"file_path": filePath}) {
			continue
		}
		content := formatMemoryFile(mem)
		err := storage.WithFileSyncLock(filePath, func() error {
			if err := storage.MkdirPrivateSync(dir); err != nil {
				return err
			}
			if _, statErr := os.Stat(filePath); statErr == nil {
				if !allowed(memory.NewMemoryPermissionChecker(e.cwd, false), "ReadFile", tools.CategoryRead, map[string]any{"file_path": filePath}) {
					return nil
				}
				existing, readErr := storage.ReadPrivateFileSync(filePath)
				if readErr == nil && string(existing) != content {
					log.Warn(map[string]any{"filePath": filePath}, "memory text fallback: refusing to overwrite an existing memory file")
				}
				return nil
			}
			temporary := fmt.Sprintf("%s.%d.mem-tmp", filePath, os.Getpid())
			defer os.Remove(temporary)
			if err := storage.WritePrivateFileSync(temporary, []byte(content), os.O_WRONLY|os.O_CREATE|os.O_EXCL); err != nil {
				return err
			}
			if err := os.Rename(temporary, filePath); err != nil {
				return err
			}
			saved = append(saved, mem.Name)
			return nil
		})
		if err != nil {
			log.Error(map[string]any{"err": err}, "memory text fallback write failed")
		}
	}
	return saved
}

func parseTextMemoryBlocks(text string) []ParsedTextMemory {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || trimmed == memory.NoneSentinel {
		return nil
	}
	var memories []ParsedTextMemory
	for _, block := range memory.TextBlockSeparatorRe.Split(trimmed, -1) {
		if mem, ok := parseTextMemoryBlock(block); ok {
			memories = append(memories, mem)
		}
	}
	return memories
}

// parseTextMemoryBlock parses a single block; MEMORY_BODY supports multiple
// lines.
func parseTextMemoryBlock(block string) (ParsedTextMemory, bool) {
	var mem ParsedTextMemory
	var bodyLines []string
	inBody := false
	for _, line := range strings.Split(block, "\n") {
		nameMatch := memory.MemoryNameRe.FindStringSubmatch(line)
		typeMatch := memory.MemoryTypeRe.FindStringSubmatch(line)
		descMatch := memory.MemoryDescRe.FindStringSubmatch(line)
		bodyMatch := memory.MemoryBodyRe.FindStringSubmatch(line)
		switch {
		case nameMatch != nil:
			if mem.Name != "" {
				mem.Type = ""
				mem.Description = ""
				mem.Body = ""
				bodyLines = nil
			}
			mem.Name = strings.TrimSpace(nameMatch[1])
			inBody = false
		case typeMatch != nil:
			mem.Type = strings.TrimSpace(typeMatch[1])
			inBody = false
		case descMatch != nil:
			mem.Description = strings.TrimSpace(descMatch[1])
			inBody = false
		case bodyMatch != nil:
			if mem.Body != "" || len(bodyLines) > 0 {
				bodyLines = nil
			}
			mem.Body = bodyMatch[1]
			inBody = true
		case inBody:
			bodyLines = append(bodyLines, line)
		}
	}
	if mem.Body != "" {
		mem.Body = strings.Join(append([]string{mem.Body}, bodyLines...), "\n")
	} else {
		mem.Body = strings.Join(bodyLines, "\n")
	}
	mem.Body = strings.TrimRight(mem.Body, " \t\r\n")
	if !memory.MemoryNamePattern.MatchString(mem.Name) || strings.TrimSpace(mem.Body) == "" {
		return ParsedTextMemory{}, false
	}
	if mem.Type == "" {
		mem.Type = memory.DefaultMemoryType
	}
	return mem, true
}

func (e *Extractor) dirForMemoryType(memoryType string) string {
	switch strings.ToLower(memoryType) {
	case "user", "feedback":
		return memory.GetUserAutoMemPath()
	default:
		return memory.GetAutoMemPath(e.cwd)
	}
}

// formatMemoryFile formats frontmatter (name/description/type) + body.
func formatMemoryFile(mem ParsedTextMemory) string {
	return "---\n" +
		"name: " + strconv.Quote(mem.Name) + "\n" +
		"description: " + strconv.Quote(mem.Description) + "\n" +
		"type: " + strconv.Quote(mem.Type) + "\n" +
		"---\n\n" + mem.Body + "\n"
}

func (e *Extractor) protocol() string {
	if provider, ok := e.client.(interface{ Protocol() string }); ok {
		return provider.Protocol()
	}
	return "anthropic"
}

func allowed(checker *permissions.Checker, name string, category tools.ToolCategory, args map[string]any) bool {
	return checker != nil && checker.CheckNamed(name, category, args).Effect == permissions.Allow
}
