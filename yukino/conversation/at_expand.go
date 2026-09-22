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

package conversation

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/hangtiancheng/yukino-code/yukino/images"
	"github.com/hangtiancheng/yukino-code/yukino/logger"
	"github.com/hangtiancheng/yukino-code/yukino/utils"
)

// atLog mirrors the TS at-expand child logger (module "terminal").
var atLog = logger.CreateChildLogger("terminal")

const (
	maxInlineBytes = 100_000
	// Files larger than this are never read, even for a narrow line range.
	maxRangeFileBytes = 10_000_000
)

// An @ref may carry a #L3 or #L3-10 suffix (inserted via the IDE integration).
// Clipboard images and paths containing spaces use quoted mentions.
var atRefPattern = regexp.MustCompile(`(?:^|\s)(?:'@([^']+)'|"@([^"]+)"|@"([^"]+)"|@'([^']+)'|@([^\s]+))`)

var atRefRangePattern = regexp.MustCompile(`^(.+)#L(\d+)(?:-(\d+))?$`)

type atRef struct {
	path      string
	lineStart int
	lineEnd   int
	hasRange  bool
}

func parseAtRef(ref string) atRef {
	m := atRefRangePattern.FindStringSubmatch(ref)
	if m == nil {
		return atRef{path: ref}
	}
	start, _ := strconv.Atoi(m[2])
	end := start
	if m[3] != "" {
		end, _ = strconv.Atoi(m[3])
	}
	return atRef{path: m[1], lineStart: start, lineEnd: end, hasRange: true}
}

func sliceLines(content string, lineStart, lineEnd int) string {
	all := strings.Split(content, "\n")
	from := max(1, lineStart)
	to := min(len(all), max(lineEnd, from))
	// JS slice(from-1, to) yields an empty array when the start is past the
	// end (e.g. #L999 on a 10-line file); a Go slice would panic there.
	if from-1 > to {
		return ""
	}
	return strings.Join(all[from-1:to], "\n")
}

func collectAtRefs(text string) []string {
	matches := atRefPattern.FindAllStringSubmatch(text, -1)
	refs := make([]string, 0, len(matches))
	for _, m := range matches {
		for _, group := range m[1:] {
			if group != "" {
				refs = append(refs, group)
				break
			}
		}
	}
	return refs
}

// ExpandAtRefs expands @path references in a user message by inlining the
// referenced files' contents (resolved relative to workDir). Tokens that don't
// resolve to a small readable file are left untouched.
func ExpandAtRefs(text, workDir string) string {
	refs := collectAtRefs(text)
	if len(refs) == 0 {
		return text
	}

	var appendix strings.Builder
	seen := make(map[string]bool)
	for _, ref := range refs {
		if seen[ref] {
			continue
		}
		seen[ref] = true
		parsed := parseAtRef(ref)
		p := parsed.path
		if !filepath.IsAbs(p) {
			p = filepath.Join(workDir, p)
		}
		st, err := os.Stat(p)
		if err != nil {
			// TS: statSync throws → catch → log; not a readable file → leave
			// the @token as literal text.
			atLog.Error("UI operation failed", "err", err)
			continue
		}
		if !st.Mode().IsRegular() {
			continue
		}
		if parsed.hasRange {
			if st.Size() <= maxRangeFileBytes {
				raw, err := os.ReadFile(p)
				if err != nil {
					atLog.Error("UI operation failed", "err", err)
					continue
				}
				snippet := sliceLines(string(raw), parsed.lineStart, parsed.lineEnd)
				// TS compares snippet.length — UTF-16 code units.
				if utils.UTF16Len(snippet) <= maxInlineBytes {
					fmt.Fprintf(&appendix, "\n\n<file path=\"%s\" lines=\"%d-%d\">\n%s\n</file>",
						parsed.path, parsed.lineStart, parsed.lineEnd, snippet)
				}
			}
		} else if st.Size() <= maxInlineBytes {
			raw, err := os.ReadFile(p)
			if err != nil {
				atLog.Error("UI operation failed", "err", err)
				continue
			}
			fmt.Fprintf(&appendix, "\n\n<file path=\"%s\">\n%s\n</file>", parsed.path, raw)
		}
	}
	if appendix.Len() == 0 {
		return text
	}
	return text + appendix.String()
}

// ExpandAtRefsWithImages behaves like ExpandAtRefs, except @references to
// image files (png/jpg/gif/webp) are loaded as inline image content blocks
// instead of being inlined as (garbled) utf-8 text. The appendix gets an
// <image> placeholder so the model can pair each block with its @token.
// Image load failures are skipped (only exceeding the per-message image limit
// appends an error note); non-image refs behave exactly like ExpandAtRefs.
//
// TS returns `string | Record<string, unknown>[]` because Message.content is a
// union; Go's Message.Content is string-only, so the image blocks are returned
// separately and attaching them to the outgoing user message is up to the
// caller (nil when no image is referenced).
func ExpandAtRefsWithImages(text, workDir string) (string, []map[string]any) {
	refs := collectAtRefs(text)
	if len(refs) == 0 {
		return text, nil
	}

	var appendix strings.Builder
	seen := make(map[string]bool)
	var imageBlocks []map[string]any
	for _, ref := range refs {
		if seen[ref] {
			continue
		}
		seen[ref] = true
		parsed := parseAtRef(ref)
		p := parsed.path
		if !filepath.IsAbs(p) {
			p = filepath.Join(workDir, p)
		}
		st, err := os.Stat(p)
		if err != nil {
			atLog.Error("UI operation failed", "err", err)
			continue
		}
		if !st.Mode().IsRegular() {
			continue
		}
		if images.IsImagePath(p) {
			if len(imageBlocks) >= images.MaxImagesPerMessage {
				fmt.Fprintf(&appendix, "\n\nError: too many images attached (limit %d per message)",
					images.MaxImagesPerMessage)
				continue
			}
			attachment, err := images.LoadImageAttachment(p)
			if err != nil {
				atLog.Error("UI operation failed", "err", err)
				continue
			}
			imageBlocks = append(imageBlocks, map[string]any{
				"type": "image",
				"source": map[string]any{
					"type":       "base64",
					"media_type": string(attachment.MediaType),
					"data":       attachment.Data,
				},
			})
			fmt.Fprintf(&appendix, "\n\n<image type=\"base64\" media_type=\"%s\" path=\"%s\" />",
				attachment.MediaType, parsed.path)
		} else if parsed.hasRange {
			if st.Size() <= maxRangeFileBytes {
				raw, err := os.ReadFile(p)
				if err != nil {
					atLog.Error("UI operation failed", "err", err)
					continue
				}
				snippet := sliceLines(string(raw), parsed.lineStart, parsed.lineEnd)
				// TS compares snippet.length — UTF-16 code units.
				if utils.UTF16Len(snippet) <= maxInlineBytes {
					fmt.Fprintf(&appendix, "\n\n<file path=\"%s\" lines=\"%d-%d\">\n%s\n</file>",
						parsed.path, parsed.lineStart, parsed.lineEnd, snippet)
				}
			}
		} else if st.Size() <= maxInlineBytes {
			raw, err := os.ReadFile(p)
			if err != nil {
				atLog.Error("UI operation failed", "err", err)
				continue
			}
			fmt.Fprintf(&appendix, "\n\n<file path=\"%s\">\n%s\n</file>", parsed.path, raw)
		}
	}
	expanded := text
	if appendix.Len() > 0 {
		expanded = text + appendix.String()
	}
	return expanded, imageBlocks
}
