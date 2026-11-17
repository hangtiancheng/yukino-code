package tools

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode"
)

func editPosition(text []rune, offset int) string {
	line, column := 1, 1
	for _, r := range text[:min(offset, len(text))] {
		if r == '\n' {
			line++
			column = 1
		} else {
			column++
		}
	}
	return fmt.Sprintf("line %d, column %d", line, column)
}

func editQuoted(text string) string {
	data, _ := json.Marshal(text)
	return strings.ReplaceAll(string(data), " ", "\\u0020")
}

func editCharacter(text []rune, offset int) string {
	if offset >= len(text) {
		return "end of text"
	}
	r := text[offset]
	return fmt.Sprintf("%s (U+%04X)", editQuoted(string(r)), r)
}

func editContext(text []rune, offset int) string {
	return editQuoted(string(text[max(0, offset-30):min(len(text), offset+30)]))
}

func editMismatch(file, snippet []rune, start int) string {
	length := 0
	for length < len(snippet) && start+length < len(file) && file[start+length] == snippet[length] {
		length++
	}
	return fmt.Sprintf("First difference: old_string %s has %s; file %s has %s.\nold_string context: %s\nfile context: %s", editPosition(snippet, length), editCharacter(snippet, length), editPosition(file, start+length), editCharacter(file, start+length), editContext(snippet, length), editContext(file, start+length))
}

func normalizeHorizontalWhitespace(text []rune) (string, []int) {
	var out strings.Builder
	var offsets []int
	space := false
	for i, r := range text {
		horizontal := (unicode.IsSpace(r) || r == '\uFEFF') && r != '\r' && r != '\n'
		if horizontal && space {
			continue
		}
		if horizontal {
			r = ' '
		}
		out.WriteRune(r)
		for range len(string(r)) {
			offsets = append(offsets, i)
		}
		space = horizontal
	}
	return out.String(), offsets
}

func describeEditMismatch(content, old string) string {
	file := []rune(strings.ReplaceAll(content, "\r\n", "\n"))
	snippet := []rune(strings.ReplaceAll(old, "\r\n", "\n"))
	normalized, offsets := normalizeHorizontalWhitespace(file)
	needle, _ := normalizeHorizontalWhitespace(snippet)
	var candidates []int
	for cursor := 0; needle != "" && cursor <= len(normalized) && len(candidates) < 3; {
		at := strings.Index(normalized[cursor:], needle)
		if at < 0 {
			break
		}
		at += cursor
		candidates = append(candidates, offsets[at])
		cursor = at + len(needle)
	}
	var details []string
	if len(candidates) > 0 {
		var positions []string
		for _, start := range candidates {
			positions = append(positions, "file "+editPosition(file, start))
		}
		details = append(details, "Candidates matching after horizontal whitespace normalization (up to 3): "+strings.Join(positions, "; ")+". These are suggestions only; whitespace must match exactly.", editMismatch(file, snippet, candidates[0]))
	} else {
		low, high := 0, len(snippet)
		for low < high {
			middle := (low + high + 1) / 2
			if strings.Contains(string(file), string(snippet[:middle])) {
				low = middle
			} else {
				high = middle - 1
			}
		}
		if low > 0 {
			byteStart := strings.Index(string(file), string(snippet[:low]))
			start := len([]rune(string(file)[:byteStart]))
			details = append(details, "Longest matching prefix starts at file "+editPosition(file, start)+".", editMismatch(file, snippet, start))
		} else {
			details = append(details, "No matching prefix or horizontal-whitespace candidate found.")
		}
	}
	details = append(details, "No edits were written.")
	return strings.Join(details, "\n")
}
