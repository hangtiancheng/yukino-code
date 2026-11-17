package tools

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/dlclark/regexp2/v2"
	"github.com/yukino-js/yukino/yukino/internal/storage"
)

type GrepTraversalLimits struct{ MaxEntries, MaxDepth int }
type GrepTool struct{ TraversalLimits *GrepTraversalLimits }

func (t *GrepTool) Name() string           { return "Grep" }
func (t *GrepTool) Description() string    { return GrepDescription }
func (t *GrepTool) Category() ToolCategory { return CategoryRead }
func (t *GrepTool) Schema() map[string]any {
	return map[string]any{"name": t.Name(), "description": t.Description(), "input_schema": map[string]any{"type": "object", "properties": map[string]any{
		"pattern": map[string]any{"type": "string", "description": "Case-insensitive regular expression matched against each line. Escape backslashes in JSON; use ReadFile for surrounding context."},
		"path":    map[string]any{"type": "string", "description": "Directory or file, absolute or relative to the Agent's working directory (default '.'). Narrow the path to reduce output.", "default": "."},
		"include": map[string]any{"type": "string", "description": "Optional filename glob. Bare patterns such as '*.ts' match at any depth; patterns with '/' match paths relative to the Agent's working directory."},
	}, "required": []string{"pattern"}}}
}

const grepPatternTimeoutError = "Error: the pattern timed out while matching (likely catastrophic backtracking). Simplify it — avoid nested quantifiers such as (a+)+ — or narrow the path/include filter."
const unicodeWord = `\p{L}\p{M}\p{N}_`

var bracedHex = regexp.MustCompile(`^\{([0-9a-fA-F]{1,6})\}`)

func unicodeGrepPattern(pattern string) string {
	var out strings.Builder
	inClass := false
	for i := 0; i < len(pattern); i++ {
		ch := pattern[i]
		if ch == '\\' && i+1 < len(pattern) {
			next := pattern[i+1]
			if next == 'x' {
				if hex := bracedHex.FindStringSubmatch(pattern[i+2:]); hex != nil {
					value, _ := strconv.ParseInt(hex[1], 16, 32)
					if value <= 0x10ffff {
						out.WriteString(`\u` + hex[0])
						i += 1 + len(hex[0])
						continue
					}
				}
			}
			replacements := map[byte]string{'w': "[" + unicodeWord + "]", 'W': "[^" + unicodeWord + "]", 'd': `\p{Nd}`, 'D': `\P{Nd}`,
				'b': "(?:(?<![" + unicodeWord + "])(?=[" + unicodeWord + "])|(?<=[" + unicodeWord + "])(?![" + unicodeWord + "]))",
				'B': "(?:(?<=[" + unicodeWord + "])(?=[" + unicodeWord + "])|(?<![" + unicodeWord + "])(?![" + unicodeWord + "]))"}
			if inClass {
				replacements = map[byte]string{'w': unicodeWord, 'd': `\p{Nd}`}
			}
			if replacement, ok := replacements[next]; ok {
				out.WriteString(replacement)
			} else {
				out.WriteByte(ch)
				out.WriteByte(next)
			}
			i++
			continue
		}
		if ch == '[' && !inClass {
			inClass = true
		} else if ch == ']' && inClass {
			inClass = false
		}
		out.WriteByte(ch)
	}
	return out.String()
}

func (t *GrepTool) Execute(ctx context.Context, args map[string]any) ToolResult {
	if ctx.Err() != nil {
		return ToolResult{Output: OperationInterruptedError, IsError: true}
	}
	pattern, _ := args["pattern"].(string)
	if pattern == "" {
		return ToolResult{Output: "Error: pattern is required", IsError: true}
	}
	re, err := regexp2.Compile(unicodeGrepPattern(pattern), regexp2.ECMAScript|regexp2.Unicode|regexp2.IgnoreCase)
	if err != nil {
		re, err = regexp2.Compile(pattern, regexp2.ECMAScript|regexp2.IgnoreCase)
	}
	if err != nil {
		return ToolResult{Output: "Error: invalid regex pattern: " + pattern, IsError: true}
	}
	searchPath, _ := args["path"].(string)
	if searchPath == "" {
		searchPath = "."
	}
	searchPath = toolPath(ctx, searchPath)
	include, _ := args["include"].(string)
	limits := GrepTraversalLimits{MaxTraversedEntries, MaxTraversalDepth}
	if t.TraversalLimits != nil {
		limits = *t.TraversalLimits
	}
	execution, _ := ctx.Value(executionContextKey{}).(ExecutionContext)
	results := searchOutput{max: MaxSearchResults}
	shortened, large, visited := 0, 0, 0
	entryLimit, depthLimit := false, false
	var searchErr error
	searchFile := func(path string, info os.FileInfo) {
		if searchErr != nil || results.limit != "" || !searchAllowed(execution, path, false) {
			return
		}
		if ctx.Err() != nil {
			searchErr = ctx.Err()
			return
		}
		if info.Size() > MaxGrepFileBytes {
			large++
			return
		}
		if storage.IsPrivateStatePath(path) {
			if storage.ProtectPrivateFileSync(path) != nil {
				return
			}
		}
		f, err := os.Open(path)
		if err != nil {
			return
		}
		defer f.Close()
		sniff := make([]byte, min(info.Size(), 8*1024))
		n, err := f.ReadAt(sniff, 0)
		if err != nil && n == 0 && info.Size() > 0 {
			return
		}
		if bytes.ContainsRune(sniff[:n], 0) {
			return
		}
		_, err = f.Seek(0, io.SeekStart)
		if err != nil {
			return
		}
		data, err := io.ReadAll(io.LimitReader(f, MaxGrepFileBytes+1))
		if err != nil {
			return
		}
		if len(data) > MaxGrepFileBytes {
			large++
			return
		}
		text := strings.ToValidUTF8(string(data), "�")
		relative, _ := filepath.Rel(workingDirectory(ctx), path)
		budget := min(10*time.Second, max(2*time.Second, time.Duration((info.Size()+1023)/1024)*5*time.Millisecond))
		deadline := time.Now().Add(budget)
		for i, line := range strings.Split(text, "\n") {
			if ctx.Err() != nil {
				searchErr = ctx.Err()
				return
			}
			re.MatchTimeout = time.Until(deadline)
			if re.MatchTimeout <= 0 {
				searchErr = fmt.Errorf("%s", grepPatternTimeoutError)
				return
			}
			matched, err := re.MatchString(line)
			if err != nil {
				searchErr = fmt.Errorf("%s", grepPatternTimeoutError)
				return
			}
			if !matched {
				continue
			}
			preview := takeUTF8Prefix(line, MaxMatchLineBytes)
			suffix := ""
			if len(preview) < len(line) {
				suffix = "…"
			}
			if !results.append(fmt.Sprintf("%s:%d:%s%s", relative, i+1, preview, suffix)) {
				return
			}
			if suffix != "" {
				shortened++
			}
		}
	}
	var walk func(string, int)
	walk = func(dir string, depth int) {
		if searchErr != nil || results.limit != "" || entryLimit {
			return
		}
		entries, err := os.Open(dir)
		if err != nil {
			return
		}
		defer entries.Close()
		for {
			batch, err := entries.ReadDir(64)
			if len(batch) == 0 {
				return
			}
			for _, entry := range batch {
				if ctx.Err() != nil {
					searchErr = ctx.Err()
					return
				}
				if searchErr != nil || results.limit != "" || entryLimit {
					return
				}
				if visited >= limits.MaxEntries {
					entryLimit = true
					return
				}
				visited++
				if SkipDirs[entry.Name()] {
					continue
				}
				path := filepath.Join(dir, entry.Name())
				if !searchAllowed(execution, path, false) {
					continue
				}
				info, e := entry.Info()
				if e != nil {
					continue
				}
				if info.Mode()&os.ModeSymlink != 0 {
					info, e = os.Stat(path)
					if e != nil || !info.Mode().IsRegular() {
						continue
					}
				}
				if info.IsDir() {
					if depth >= limits.MaxDepth {
						depthLimit = true
						continue
					}
					walk(path, depth+1)
				} else if info.Mode().IsRegular() {
					relative, _ := filepath.Rel(workingDirectory(ctx), path)
					if include == "" || matchGlob(include, filepath.ToSlash(relative)) {
						searchFile(path, info)
					}
				}
			}
			if err != nil {
				return
			}
		}
	}
	info, err := os.Stat(searchPath)
	if err != nil {
		searchErr = err
	} else if info.Mode().IsRegular() {
		searchFile(searchPath, info)
	} else {
		walk(searchPath, 0)
	}
	if ctx.Err() != nil {
		return ToolResult{Output: OperationInterruptedError, IsError: true}
	}
	if searchErr != nil {
		output := searchErr.Error()
		if output != grepPatternTimeoutError {
			output = "Error: " + output
		}
		return ToolResult{Output: output, IsError: true}
	}
	var notices []string
	if results.limit == "matches" {
		notices = append(notices, "results truncated at 500 matches")
	}
	if results.limit == "bytes" {
		notices = append(notices, "results truncated at 50KB; narrow the path, pattern or include filter")
	}
	if shortened > 0 {
		notices = append(notices, fmt.Sprintf("%d long matching line(s) shortened to 2000 bytes; use ReadFile for full lines", shortened))
	}
	if entryLimit {
		notices = append(notices, fmt.Sprintf("search truncated after visiting %d entries", limits.MaxEntries))
	}
	if depthLimit {
		notices = append(notices, fmt.Sprintf("search truncated: directories deeper than %d levels were skipped", limits.MaxDepth))
	}
	if large > 0 {
		notices = append(notices, fmt.Sprintf("%d file(s) over 25MB were skipped", large))
	}
	output := strings.Join(results.lines, "\n")
	if output == "" {
		output = "No matches found."
	}
	if len(notices) > 0 {
		output += "\n\n(" + strings.Join(notices, ")\n(") + ")"
	}
	return ToolResult{Output: output}
}
