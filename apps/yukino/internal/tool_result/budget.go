package tool_result

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/yukino-js/yukino/yukino/internal/conversation"
	"github.com/yukino-js/yukino/yukino/internal/storage"
	"github.com/yukino-js/yukino/yukino/internal/utils"
)

// Aggregate cap across all tool results within a single message. The size of
// an individual result is gated by the agent's per-result threshold; what is
// managed here is the aggregate. When a turn fans out to several tools in
// parallel, each result can stay under the per-result threshold while their
// sum blows up the context.
const (
	MessageAggregateLimit  = 200000
	ToolResultPreviewChars = 2000
	SpillDirName           = "tool-results"
	SpillFileExtension     = ".txt"
)

var errNoSessionID = errors.New("Tool-result spilling requires a session ID")

func SpillDir(sessionID string) (string, error) {
	if sessionID == "" {
		return "", errNoSessionID
	}
	return storage.SessionPath(sessionID, SpillDirName)
}

// encodeToolUseID mirrors encodeURIComponent plus the "*" escape: provider
// call IDs are opaque data, never filesystem paths.
func encodeToolUseID(id string) string {
	var sb strings.Builder
	for i := 0; i < len(id); i++ {
		b := id[i]
		if (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') ||
			b == '-' || b == '_' || b == '.' || b == '!' || b == '~' || b == '\'' ||
			b == '(' || b == ')' {
			sb.WriteByte(b)
		} else {
			fmt.Fprintf(&sb, "%%%02X", b)
		}
	}
	return strings.ReplaceAll(sb.String(), "*", "%2A")
}

func resultPath(sessionID, toolUseID string) (string, error) {
	dir, err := SpillDir(sessionID)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, encodeToolUseID(toolUseID)+SpillFileExtension), nil
}

// writeSpill persists the full text of a tool result to disk. tool_use_id is
// unique per invocation and its content is deterministic, so when the file
// already exists it is reused instead of written again.
func writeSpill(sessionID, toolUseID, content string) (string, error) {
	dir, err := SpillDir(sessionID)
	if err != nil {
		return "", err
	}
	if err := storage.MkdirPrivateSync(dir); err != nil {
		return "", err
	}
	path := filepath.Join(dir, encodeToolUseID(toolUseID)+SpillFileExtension)
	err = storage.WritePrivateFileSync(path, []byte(content), os.O_WRONLY|os.O_CREATE|os.O_TRUNC|os.O_EXCL)
	if err != nil {
		if os.IsExist(err) {
			if perr := storage.ProtectPrivateFileSync(path); perr != nil {
				return "", perr
			}
			return path, nil
		}
		return "", err
	}
	return path, nil
}

// BuildPersistedOutputPreview renders the <persisted-output> wrapper text.
// Identical input yields a byte-for-byte identical string; once the
// replacement enters the conversation history it is never modified again.
func BuildPersistedOutputPreview(totalSize int, preview, spillPath, sizeUnit string) string {
	previewSize := utf8.RuneCountInString(preview)
	if sizeUnit == "bytes" {
		previewSize = len(preview)
	}
	var msg strings.Builder
	msg.WriteString("<persisted-output>\n")
	fmt.Fprintf(&msg, "Output too large (%d %s). Full content saved to:\n%s\n\n", totalSize, sizeUnit, spillPath)
	fmt.Fprintf(&msg, "Preview (first %d %s):\n%s", previewSize, sizeUnit, preview)
	if totalSize > previewSize {
		msg.WriteString("\n...")
	}
	msg.WriteString("\n</persisted-output>")
	return msg.String()
}

func buildSpillPreview(content, spillPath string) string {
	preview := content
	if utf8.RuneCountInString(preview) > ToolResultPreviewChars {
		preview = string([]rune(preview)[:ToolResultPreviewChars])
	}
	return BuildPersistedOutputPreview(utf8.RuneCountInString(content), preview, spillPath, "characters")
}

func ToDisplayPreview(content string) string {
	if utf8.RuneCountInString(content) <= ToolResultPreviewChars {
		return content
	}
	runes := []rune(content)
	return fmt.Sprintf("%s\n… %d chars omitted from transcript",
		string(runes[:ToolResultPreviewChars]), len(runes)-ToolResultPreviewChars)
}

func ReplaceToolResultContent(result *conversation.ToolResultBlock, content string) {
	result.Content = content
	if len(result.ContentBlocks) > 0 {
		blocks := []map[string]any{{"type": "text", "text": content}}
		for _, block := range result.ContentBlocks {
			if t, _ := block["type"].(string); t != "text" {
				blocks = append(blocks, block)
			}
		}
		result.ContentBlocks = blocks
	}
}

// IsSpillReadback determines whether a tool call is reading back a file under
// the spill directory. Such results are not spilled: writing the model's
// freshly-read content back to disk and swapping it for a preview would mean
// the model never sees the full text, and it would loop between "read back"
// and "spill".
func IsSpillReadback(toolName string, args map[string]any, cwd, sessionID string) bool {
	if toolName != "ReadFile" || args == nil {
		return false
	}
	raw, _ := args["file_path"].(string)
	if raw == "" {
		return false
	}
	if sessionID == "" {
		return false
	}
	// Resolve against cwd like ReadFileTool does — under remote/teammate the
	// process cwd differs — and match on a path-segment boundary so a sibling
	// directory like "<spillDir>-extra" never counts as the spill dir.
	target := utils.ResolveToolPath(cwd, raw)
	spill, err := SpillDir(sessionID)
	if err != nil {
		return false
	}
	spill, err = filepath.Abs(spill)
	if err != nil {
		return false
	}
	return target == spill || strings.HasPrefix(target, spill+string(filepath.Separator))
}

// ApplyBudget runs the aggregate budget before a turn's tool results enter
// the conversation history: when the total character count of the batch
// exceeds MessageAggregateLimit, it spills results to disk one by one
// starting from the largest, replacing each in place with a preview, until
// the total is back within the limit. Exempt tool_use_ids do not participate
// in spilling. When everything is exempt, the overage is accepted.
func ApplyBudget(results []conversation.ToolResultBlock, sessionID string, exempt map[string]bool) {
	total := 0
	for i := range results {
		total += utf8.RuneCountInString(results[i].Content)
	}
	if total <= MessageAggregateLimit {
		return
	}

	// Select in descending order of content length: spilling the largest
	// first minimizes the number of entries touched to get back under limit.
	order := make([]int, len(results))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool {
		return utf8.RuneCountInString(results[order[a]].Content) > utf8.RuneCountInString(results[order[b]].Content)
	})

	for _, idx := range order {
		if total <= MessageAggregateLimit {
			break
		}
		r := &results[idx]
		if exempt[r.ToolUseID] {
			continue
		}
		content := r.Content
		if utf8.RuneCountInString(content) <= ToolResultPreviewChars {
			// A result no longer than the preview gains no space from
			// spilling — the wrapper text would only enlarge it.
			continue
		}
		// Measure the replacement under the real wrapper + path overhead
		// before touching disk. Spilling only pays off when the preview is
		// strictly smaller than the original.
		spillPath, err := resultPath(sessionID, r.ToolUseID)
		if err != nil {
			// No session id means there is nowhere to spill.
			continue
		}
		replacement := buildSpillPreview(content, spillPath)
		if utf8.RuneCountInString(replacement) >= utf8.RuneCountInString(content) {
			continue
		}
		if _, err := writeSpill(sessionID, r.ToolUseID, content); err != nil {
			// On write failure, keep the original text. The message is
			// finalized into history right after, so there will be no retry.
			continue
		}
		total -= utf8.RuneCountInString(content) - utf8.RuneCountInString(replacement)
		ReplaceToolResultContent(r, replacement)
	}
}

// PersistLargeResult spills an oversized tool output to disk and returns the
// preview text. On write failure the content is returned unchanged.
func PersistLargeResult(sessionID, toolUseID, content string) string {
	path, err := writeSpill(sessionID, toolUseID, content)
	if err != nil {
		return content
	}
	return buildSpillPreview(content, path)
}
