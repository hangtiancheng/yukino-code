package tools

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strings"

	"github.com/yukino-js/yukino/yukino/internal/file_history"
	"github.com/yukino-js/yukino/yukino/internal/storage"
)

type EditFileTool struct {
	FileHistory    *file_history.History
	FileStateCache *FileStateCache
}

func (t *EditFileTool) Name() string           { return "EditFile" }
func (t *EditFileTool) Description() string    { return EditFileDescription }
func (t *EditFileTool) Category() ToolCategory { return CategoryWrite }
func (t *EditFileTool) Schema() map[string]any {
	return map[string]any{"name": t.Name(), "description": t.Description(), "input_schema": map[string]any{
		"type": "object", "properties": map[string]any{
			"file_path": map[string]any{"type": "string", "description": EditFileFilePathDescription},
			"edits": map[string]any{"type": "array", "minItems": 1, "description": EditFileEditsDescription, "items": map[string]any{
				"type": "object", "properties": map[string]any{
					"old_string":  map[string]any{"type": "string", "minLength": 1, "description": EditFileOldStringDescription},
					"new_string":  map[string]any{"type": "string", "description": EditFileNewStringDescription},
					"replace_all": map[string]any{"type": "boolean", "default": false, "description": EditFileReplaceAllDescription},
				}, "required": []string{"old_string", "new_string"},
			}},
		}, "required": []string{"file_path", "edits"},
	}}
}

type fileEdit struct {
	old, replacement string
	all              bool
}
type TextReplacement struct {
	Start, End int
	Text       string
}
type indexedReplacement struct {
	TextReplacement
	edit int
}

func normalizeLineEndings(text string) (string, []int) {
	var out strings.Builder
	offsets := make([]int, 0, len(text)+1)
	for i := 0; i < len(text); i++ {
		offsets = append(offsets, i)
		if text[i] == '\r' && i+1 < len(text) && text[i+1] == '\n' {
			i++
		}
		out.WriteByte(text[i])
	}
	offsets = append(offsets, len(text))
	return out.String(), offsets
}

func firstLineEnding(text string) string {
	if index := strings.IndexByte(text, '\n'); index >= 0 {
		if index > 0 && text[index-1] == '\r' {
			return "\r\n"
		}
		return "\n"
	}
	return ""
}

func withoutStrayCarriageReturns(text string) string {
	var out strings.Builder
	for i := 0; i < len(text); i++ {
		if text[i] != '\r' || i+1 < len(text) && text[i+1] == '\n' {
			out.WriteByte(text[i])
		}
	}
	return out.String()
}

func applyFileEdits(content string, edits []fileEdit) (string, []TextReplacement, error) {
	normalized, offsets := normalizeLineEndings(content)
	ending := firstLineEnding(content)
	if ending == "" {
		ending = "\n"
	}
	var replacements []indexedReplacement
	for i, edit := range edits {
		old := edit.old
		pattern, _ := normalizeLineEndings(old)
		replacement := edit.replacement
		first := strings.Index(normalized, pattern)
		if first < 0 {
			cleaned := withoutStrayCarriageReturns(old)
			if cleaned != "" && cleaned != old {
				old = cleaned
				pattern, _ = normalizeLineEndings(cleaned)
				replacement = withoutStrayCarriageReturns(replacement)
				first = strings.Index(normalized, pattern)
			}
		}
		if first < 0 {
			return "", nil, fmt.Errorf("edits[%d].old_string not found in file\n%s", i, describeEditMismatch(content, old))
		}
		count := 0
		for at := first; at >= 0; {
			if count > 0 && !edit.all {
				return "", nil, fmt.Errorf("edits[%d].old_string occurs more than once in file. It must be unique. Add more surrounding context, or set replace_all to true", i)
			}
			start, end := offsets[at], offsets[at+len(pattern)]
			matchedEnding := firstLineEnding(content[start:end])
			if matchedEnding == "" {
				matchedEnding = ending
			}
			text, _ := normalizeLineEndings(replacement)
			text = strings.ReplaceAll(text, "\n", matchedEnding)
			if content[start:end] == text {
				return "", nil, fmt.Errorf("edits[%d] would not change the file", i)
			}
			replacements = append(replacements, indexedReplacement{TextReplacement{start, end, text}, i})
			count++
			next := at + len(pattern)
			index := strings.Index(normalized[next:], pattern)
			if index < 0 {
				break
			}
			at = next + index
		}
	}
	slices.SortStableFunc(replacements, func(a, b indexedReplacement) int { return a.Start - b.Start })
	var out strings.Builder
	cursor := 0
	result := make([]TextReplacement, 0, len(replacements))
	for _, replacement := range replacements {
		if replacement.Start < cursor {
			return "", nil, fmt.Errorf("edits[%d] overlaps another edit. Merge overlapping changes into one edit", replacement.edit)
		}
		out.WriteString(content[cursor:replacement.Start])
		out.WriteString(replacement.Text)
		cursor = replacement.End
		result = append(result, replacement.TextReplacement)
	}
	out.WriteString(content[cursor:])
	return out.String(), result, nil
}

func (t *EditFileTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	cache := fileCacheForContext(ctx, t.FileStateCache)
	history := fileHistoryForContext(ctx, t.FileHistory)
	requested, _ := args["file_path"].(string)
	if requested == "" {
		return ToolResult{Output: "Error: file_path is required", IsError: true}
	}
	rawEdits, ok := args["edits"].([]any)
	if !ok || len(rawEdits) == 0 {
		return ToolResult{Output: "Error: edits must contain at least one replacement", IsError: true}
	}
	edits := make([]fileEdit, 0, len(rawEdits))
	for i, raw := range rawEdits {
		entry, _ := raw.(map[string]any)
		old, _ := entry["old_string"].(string)
		if old == "" {
			return ToolResult{Output: fmt.Sprintf("Error: edits[%d].old_string is required", i), IsError: true}
		}
		replacement, ok := entry["new_string"].(string)
		if !ok {
			return ToolResult{Output: fmt.Sprintf("Error: edits[%d].new_string is required", i), IsError: true}
		}
		all, _ := entry["replace_all"].(bool)
		edits = append(edits, fileEdit{old, replacement, all})
	}
	path := toolPath(ctx, requested)
	return withFileMutation(ctx, t.Name(), args, path, func() ToolResult {
		if ctx.Err() != nil {
			return ToolResult{Output: OperationInterruptedError, IsError: true}
		}
		if cache != nil {
			if ok, message := cache.Check(path); !ok {
				return ToolResult{Output: message, IsError: true}
			}
		}
		if storage.IsPrivateStatePath(path) {
			if err := storage.ProtectPrivateFileSync(path); err != nil {
				return ToolResult{Output: fmt.Sprintf("Error reading file: %s", err), IsError: true}
			}
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return ToolResult{Output: fmt.Sprintf("Error reading file: %s", err), IsError: true}
		}
		content := strings.ToValidUTF8(string(data), "�")
		applied, replacements, err := applyFileEdits(content, edits)
		if err != nil {
			return ToolResult{Output: "Error: " + err.Error(), IsError: true}
		}
		if ctx.Err() != nil {
			return ToolResult{Output: OperationInterruptedError, IsError: true}
		}
		if cache != nil {
			if ok, message := cache.Check(path); !ok {
				return ToolResult{Output: message, IsError: true}
			}
		}
		if history != nil {
			history.TrackEdit(path)
		}
		if err := writeFileAtomically(ctx, path, applied); err != nil {
			if ctx.Err() != nil {
				return ToolResult{Output: OperationInterruptedError, IsError: true}
			}
			return ToolResult{Output: fmt.Sprintf("Error writing file: %s", err), IsError: true}
		}
		if cache != nil {
			cache.Update(path)
		}
		diff := BuildEditDiff(content, replacements)
		return ToolResult{Output: fmt.Sprintf("Updated %s with %d addition%s and %d removal%s (%d replacement%s)\n%s", path, diff.Additions, plural(diff.Additions), diff.Removals, plural(diff.Removals), len(replacements), plural(len(replacements)), diff.Text)}
	})
}
