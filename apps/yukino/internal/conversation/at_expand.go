package conversation

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/yukino-js/yukino/yukino/internal/images"
	"github.com/yukino-js/yukino/yukino/internal/logger"
)

var atExpandLog = logger.CreateChildLogger("at-expand")

var hanRunRe = regexp.MustCompile(`\p{Han}+`)

func collectAtRefs(text, cwd string) []string {
	matches := AtRefRe.FindAllStringSubmatchIndex(text, -1)
	if len(matches) > MaxAtRefs {
		matches = matches[:MaxAtRefs]
	}
	var refs []string
	for _, match := range matches {
		group := func(i int) (string, bool) {
			start, end := match[2*i], match[2*i+1]
			if start < 0 {
				return "", false
			}
			return text[start:end], true
		}
		ref := ""
		unquoted := false
		for i := 1; i <= 5; i++ {
			if value, ok := group(i); ok {
				ref = value
				unquoted = i == 5
				break
			}
		}
		// Prose can glue CJK text onto an unquoted mention; trim back to the
		// longest existing prefix before each Han run.
		if unquoted && !pathExists(ref, cwd) {
			runs := hanRunRe.FindAllStringIndex(ref, -1)
			for i := len(runs) - 1; i >= 0; i-- {
				prefix := ref[:runs[i][0]]
				if prefix != "" && pathExists(prefix, cwd) {
					ref = prefix
					break
				}
			}
		}
		refs = append(refs, ref)
	}
	return refs
}

func pathExists(ref, cwd string) bool {
	p := ref
	if !filepath.IsAbs(p) {
		p = filepath.Join(cwd, p)
	}
	_, err := os.Stat(p)
	return err == nil
}

func parseRef(ref string) (path string, lineStart, lineEnd int, hasRange bool) {
	match := AtRefLineRangeRe.FindStringSubmatch(ref)
	if match == nil {
		return ref, 0, 0, false
	}
	start, err := strconv.Atoi(match[2])
	if err != nil {
		return ref, 0, 0, false
	}
	end := start
	if match[3] != "" {
		if parsed, err := strconv.Atoi(match[3]); err == nil {
			end = parsed
		}
	}
	return match[1], start, end, true
}

func sliceLines(content string, lineStart, lineEnd int) string {
	all := strings.Split(content, "\n")
	from := lineStart
	if from < 1 {
		from = 1
	}
	to := len(all)
	if upper := lineEnd; upper < to {
		to = upper
	}
	if to < from {
		to = from
	}
	if from > len(all) {
		return ""
	}
	return strings.Join(all[from-1:to], "\n")
}

// ExpandAtRefs expands @path references in a user message by appending the
// referenced files' contents (resolved relative to cwd), or just the selected
// line range when the ref carries a #L suffix. Tokens that don't resolve to a
// small readable file are left untouched.
func ExpandAtRefs(text, cwd string) string {
	refs := collectAtRefs(text, cwd)
	if len(refs) == 0 {
		return text
	}
	var appendix strings.Builder
	totalBytes := 0
	appendBlock := func(block string) {
		if totalBytes+len(block) > MaxInlineTotalBytes {
			return
		}
		appendix.WriteString(block)
		totalBytes += len(block)
	}
	seen := map[string]bool{}
	for _, ref := range refs {
		if seen[ref] {
			continue
		}
		seen[ref] = true
		refPath, lineStart, lineEnd, hasRange := parseRef(ref)
		p := refPath
		if !filepath.IsAbs(p) {
			p = filepath.Join(cwd, p)
		}
		info, err := os.Stat(p)
		if err != nil {
			atExpandLog.Error(map[string]any{"err": err}, "@-mention expansion failed")
			continue
		}
		if !info.Mode().IsRegular() {
			continue
		}
		if hasRange {
			if info.Size() > MaxRangeFileBytes {
				continue
			}
			data, err := os.ReadFile(p)
			if err != nil {
				atExpandLog.Error(map[string]any{"err": err}, "@-mention expansion failed")
				continue
			}
			snippet := sliceLines(string(data), lineStart, lineEnd)
			if utf8.RuneCountInString(snippet) <= MaxInlineBytes {
				appendBlock(fmt.Sprintf("\n\n<file path=%q lines=\"%d-%d\">\n%s\n</file>", refPath, lineStart, lineEnd, snippet))
			}
			continue
		}
		if info.Size() > MaxInlineBytes {
			continue
		}
		data, err := os.ReadFile(p)
		if err != nil {
			atExpandLog.Error(map[string]any{"err": err}, "@-mention expansion failed")
			continue
		}
		appendBlock(fmt.Sprintf("\n\n<file path=%q>\n%s\n</file>", ref, string(data)))
	}
	if appendix.Len() == 0 {
		return text
	}
	return text + appendix.String()
}

// ExpandAtRefsWithImages behaves like ExpandAtRefs, but @references to image
// files (png/jpg/jpeg/gif/webp) are loaded as inline image content blocks
// instead of being inlined as (garbled) utf-8 text. The appendix gets an
// <image> placeholder so the model can pair each block with its @token. Image
// load failures are logged and skipped (only exceeding the per-message image
// limit appends an error note); non-image refs behave exactly like
// ExpandAtRefs. The second return is nil when no image is referenced.
func ExpandAtRefsWithImages(text, cwd string) (string, []map[string]any) {
	refs := collectAtRefs(text, cwd)
	if len(refs) == 0 {
		return text, nil
	}
	var appendix strings.Builder
	totalBytes := 0
	appendBlock := func(block string) bool {
		if totalBytes+len(block) > MaxInlineTotalBytes {
			return false
		}
		appendix.WriteString(block)
		totalBytes += len(block)
		return true
	}
	seen := map[string]bool{}
	var imageBlocks []map[string]any
	imageLimitNoticeAdded := false
	for _, ref := range refs {
		if seen[ref] {
			continue
		}
		seen[ref] = true
		refPath, lineStart, lineEnd, hasRange := parseRef(ref)
		p := refPath
		if !filepath.IsAbs(p) {
			p = filepath.Join(cwd, p)
		}
		info, err := os.Stat(p)
		if err != nil {
			atExpandLog.Error(map[string]any{"err": err}, "@-mention expansion failed")
			continue
		}
		if !info.Mode().IsRegular() {
			continue
		}
		if images.IsImagePath(p) {
			if len(imageBlocks) >= images.MaxImagesPerMessage {
				// Route the notice through the same byte budget as every other
				// appendix block, and emit it at most once regardless of how
				// many further images are over the limit.
				if !imageLimitNoticeAdded {
					imageLimitNoticeAdded = true
					appendBlock(fmt.Sprintf("\n\nError: too many images attached (limit %d per message)", images.MaxImagesPerMessage))
				}
				continue
			}
			attachment, err := images.LoadImageAttachment(context.Background(), p)
			if err != nil {
				atExpandLog.Error(map[string]any{"err": err}, "@-mention expansion failed")
				continue
			}
			imageBlock := map[string]any{
				"type": "image",
				"source": map[string]any{
					"type":       "base64",
					"media_type": string(attachment.MediaType),
					"data":       attachment.Data,
				},
			}
			if appendBlock(fmt.Sprintf("\n\n<image type=\"base64\" media_type=\"%s\" path=\"%s\" />", attachment.MediaType, refPath)) {
				imageBlocks = append(imageBlocks, imageBlock)
			}
			continue
		}
		if hasRange {
			if info.Size() > MaxRangeFileBytes {
				continue
			}
			data, err := os.ReadFile(p)
			if err != nil {
				atExpandLog.Error(map[string]any{"err": err}, "@-mention expansion failed")
				continue
			}
			snippet := sliceLines(string(data), lineStart, lineEnd)
			if utf8.RuneCountInString(snippet) <= MaxInlineBytes {
				appendBlock(fmt.Sprintf("\n\n<file path=%q lines=\"%d-%d\">\n%s\n</file>", refPath, lineStart, lineEnd, snippet))
			}
			continue
		}
		if info.Size() > MaxInlineBytes {
			continue
		}
		data, err := os.ReadFile(p)
		if err != nil {
			atExpandLog.Error(map[string]any{"err": err}, "@-mention expansion failed")
			continue
		}
		appendBlock(fmt.Sprintf("\n\n<file path=%q>\n%s\n</file>", ref, string(data)))
	}
	expanded := text
	if appendix.Len() > 0 {
		expanded = text + appendix.String()
	}
	if len(imageBlocks) == 0 {
		return expanded, nil
	}
	blocks := append([]map[string]any{{"type": "text", "text": expanded}}, imageBlocks...)
	return expanded, blocks
}
