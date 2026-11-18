package tools

import (
	"fmt"
	"path"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/dlclark/regexp2/v2"
)

type searchOutput struct {
	lines      []string
	bytes, max int
	limit      string
}

func (s *searchOutput) append(line string) bool {
	if len(s.lines) >= s.max {
		s.limit = "matches"
		return false
	}
	size := len(line)
	if len(s.lines) > 0 {
		size++
	}
	if s.bytes+size > MaxSearchOutputBytes {
		s.limit = "bytes"
		return false
	}
	s.lines = append(s.lines, line)
	s.bytes += size
	return true
}
func takeUTF8Prefix(text string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(text) <= n {
		return text
	}
	for n > 0 && !utf8.RuneStart(text[n]) {
		n--
	}
	return text[:n]
}

func expandBraces(pattern string) []string {
	start := -1
	depth := 0
	for i, r := range pattern {
		if r == '{' {
			if start < 0 {
				start = i
			}
			depth++
		}
		if r == '}' && start >= 0 {
			depth--
			if depth != 0 {
				continue
			}
			body := pattern[start+1 : i]
			var options []string
			cursor, nested := 0, 0
			for j, c := range body {
				if c == '{' {
					nested++
				}
				if c == '}' {
					nested--
				}
				if c == ',' && nested == 0 {
					options = append(options, body[cursor:j])
					cursor = j + 1
				}
			}
			if len(options) > 0 {
				options = append(options, body[cursor:])
			} else {
				numbers := strings.Split(body, "..")
				if len(numbers) == 2 || len(numbers) == 3 {
					from, e1 := strconv.Atoi(numbers[0])
					to, e2 := strconv.Atoi(numbers[1])
					step := 1
					if len(numbers) == 3 {
						step, _ = strconv.Atoi(numbers[2])
						if step < 0 {
							step = -step
						}
					}
					if e1 == nil && e2 == nil && step > 0 && max(from, to)-min(from, to) <= 10000 {
						if from > to {
							step = -step
						}
						for n := from; step > 0 && n <= to || step < 0 && n >= to; n += step {
							options = append(options, strconv.Itoa(n))
						}
					}
				}
			}
			if len(options) == 0 {
				return []string{pattern}
			}
			var out []string
			for _, option := range options {
				out = append(out, expandBraces(pattern[:start]+option+pattern[i+1:])...)
			}
			return out
		}
	}
	return []string{pattern}
}

func matchGlob(pattern, name string) bool {
	for _, expanded := range expandBraces(pattern) {
		candidate := name
		if !strings.Contains(expanded, "/") {
			candidate = path.Base(name)
		}
		patterns, segments := strings.Split(expanded, "/"), strings.Split(candidate, "/")
		type state struct{ p, s int }
		seen := map[state]bool{}
		var match func(int, int) bool
		match = func(p, s int) bool {
			key := state{p, s}
			if seen[key] {
				return false
			}
			seen[key] = true
			if p == len(patterns) {
				return s == len(segments)
			}
			if patterns[p] == "**" {
				return match(p+1, s) || s < len(segments) && match(p, s+1)
			}
			if s >= len(segments) {
				return false
			}
			return matchSegment(patterns[p], segments[s]) && match(p+1, s+1)
		}
		if match(0, 0) {
			return true
		}
	}
	return false
}

func searchAllowed(ctx ExecutionContext, path string, traverse bool) bool {
	if traverse && ctx.CanTraverseSearchPath != nil {
		return ctx.CanTraverseSearchPath(path)
	}
	if ctx.CanReadSearchPath != nil {
		return ctx.CanReadSearchPath(path)
	}
	return true
}

// matchSegment matches a single path segment against a glob pattern that may
// use the @(a|b), ?(a|b), *(a|b), +(a|b), !(a|b) extglob forms, mirroring
// minimatch in the reference. !(...) compiles to a negative lookahead whose
// body also contains everything following the group in the segment — the
// minimatch AST copies the trailing parts into the negation (fillNegs) — so
// !(a).ts rejects exactly the segment "a.ts" while !(a) alone still matches
// it. Segments without extglob keep using path.Match unchanged.
func matchSegment(pattern, name string) bool {
	if !hasExtglob(pattern) {
		if strings.HasPrefix(pattern, "[!") {
			pattern = "[^" + pattern[2:]
		}
		ok, _ := path.Match(pattern, name)
		return ok
	}
	re, err := compileGlobSegment(pattern)
	if err != nil {
		return false
	}
	return re.MatchString(name)
}

// hasExtglob reports whether the pattern uses one of the extglob group forms
// OP(...) with OP in @ ? * + !.
func hasExtglob(pattern string) bool {
	for i := 0; i+1 < len(pattern); i++ {
		if pattern[i+1] == '(' && strings.IndexByte("?*+@!", pattern[i]) >= 0 {
			return true
		}
	}
	return false
}

// segmentMatcher abstracts over regexp.Regexp and regexp2.Regexp; the !(...)
// negative lookahead requires the backtracking engine.
type segmentMatcher interface {
	MatchString(string) bool
}

type regexp2Matcher struct{ re *regexp2.Regexp }

func (m regexp2Matcher) MatchString(s string) bool {
	ok, err := m.re.MatchString(s)
	return err == nil && ok
}

// compileGlobSegment converts a glob segment (possibly with extglob) into an
// anchored matcher.
func compileGlobSegment(pattern string) (segmentMatcher, error) {
	body, _, err := globSegmentRegex(pattern, false, "")
	if err != nil {
		return nil, err
	}
	source := "^" + body + "$"
	if strings.Contains(body, "(?!") {
		re, err := regexp2.Compile(source, regexp2.None)
		if err != nil {
			return nil, err
		}
		return regexp2Matcher{re: re}, nil
	}
	return regexp.Compile(source)
}

// splitExtglobAlternatives scans the alternatives of an extglob group starting
// just past the opening paren and returns the raw alternative sources plus the
// index just past the closing paren.
func splitExtglobAlternatives(pattern string, start int) ([]string, int, error) {
	var alts []string
	depth := 1
	altStart := start
	for i := start; i < len(pattern); i++ {
		switch pattern[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				alts = append(alts, pattern[altStart:i])
				return alts, i + 1, nil
			}
		case '|':
			if depth == 1 {
				alts = append(alts, pattern[altStart:i])
				altStart = i + 1
			}
		}
	}
	return nil, 0, fmt.Errorf("unbalanced extglob group in %q", pattern)
}

// globSegmentRegex builds a regex fragment for pattern and reports the bytes
// consumed. When inGroup is true, an unescaped '|' or ')' terminates the
// fragment because it belongs to the enclosing extglob group. outerTail is
// the regex of everything following the current context within the segment;
// !(...) lookaheads must include it because the minimatch AST copies the
// trailing parts of enclosing groups into the negation.
func globSegmentRegex(pattern string, inGroup bool, outerTail string) (string, int, error) {
	var sb strings.Builder
	i := 0
	for i < len(pattern) {
		c := pattern[i]
		if inGroup && (c == '|' || c == ')') {
			return sb.String(), i, nil
		}
		if strings.IndexByte("?*+@!", c) >= 0 && i+1 < len(pattern) && pattern[i+1] == '(' {
			alts, end, err := splitExtglobAlternatives(pattern, i+2)
			if err != nil {
				return "", 0, err
			}
			tail, tailConsumed, err := globSegmentRegex(pattern[end:], inGroup, outerTail)
			if err != nil {
				return "", 0, err
			}
			suffix := tail + outerTail
			alternatives := make([]string, 0, len(alts))
			for _, alt := range alts {
				frag, _, err := globSegmentRegex(alt, true, suffix)
				if err != nil {
					return "", 0, err
				}
				alternatives = append(alternatives, frag)
			}
			group := "(?:" + strings.Join(alternatives, "|") + ")"
			switch c {
			case '?':
				sb.WriteString(group + "?")
			case '*':
				sb.WriteString(group + "*")
			case '+':
				sb.WriteString(group + "+")
			case '@':
				sb.WriteString(group)
			case '!':
				if len(alts) == 1 && alts[0] == "" {
					// An empty !() is exactly equivalent to a non-empty star.
					sb.WriteString(".+?")
				} else {
					sb.WriteString("(?:(?!(?:" + strings.Join(alternatives, "|") + suffix + "(?:$|/))).*?)")
				}
			}
			if c == '!' {
				// The negation consumed the tail: it was emitted inside the
				// lookahead and must follow the lazy star exactly once.
				sb.WriteString(tail)
				i = end + tailConsumed
			} else {
				i = end
			}
			continue
		}
		switch c {
		case '*':
			sb.WriteString(".*")
			i++
		case '?':
			sb.WriteString(".")
			i++
		case '[':
			j := i + 1
			if j < len(pattern) && (pattern[j] == '!' || pattern[j] == '^') {
				j++
			}
			if j < len(pattern) && pattern[j] == ']' {
				j++
			}
			for j < len(pattern) && pattern[j] != ']' {
				j++
			}
			if j >= len(pattern) {
				sb.WriteString(regexp.QuoteMeta(string(c)))
				i++
				continue
			}
			class := pattern[i : j+1]
			if strings.HasPrefix(class, "[!") {
				class = "[^" + class[2:]
			}
			sb.WriteString(class)
			i = j + 1
		default:
			sb.WriteString(regexp.QuoteMeta(string(c)))
			i++
		}
	}
	return sb.String(), i, nil
}
