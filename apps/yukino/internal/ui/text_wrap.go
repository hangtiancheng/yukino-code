package ui

import (
	"math"
	"strconv"
	"strings"
	"unicode"

	"github.com/charmbracelet/x/ansi"
	"golang.org/x/text/unicode/norm"
)

type terminalToken struct {
	value  string
	width  int
	escape bool
}

func terminalTokens(value string) []terminalToken {
	var tokens []terminalToken
	for len(value) > 0 {
		seq, width, n, _ := ansi.DecodeSequence(value, 0, nil)
		if n == 0 {
			break
		}
		tokens = append(tokens, terminalToken{seq, width, strings.HasPrefix(seq, "\x1b") || strings.HasPrefix(seq, "\u009b")})
		value = value[n:]
	}
	return tokens
}
func wrapTerminalText(value string, width int, words bool) []string {
	return wrapTerminalTextOptions(value, width, words, words)
}
func wrapTerminalTextOptions(value string, width int, words, trim bool) []string {
	width = max(1, width)
	var result []string
	for _, line := range strings.Split(expandTabs(strings.ReplaceAll(value, "\r\n", "\n")), "\n") {
		type word struct {
			value string
			width int
		}
		parts := []word{{}}
		for _, token := range terminalTokens(line) {
			if token.value == " " && !token.escape {
				parts = append(parts, word{})
				continue
			}
			last := &parts[len(parts)-1]
			if token.escape {
				last.value += token.value
			} else {
				last.value += norm.NFC.String(token.value)
				last.width += token.width
			}
		}
		rows := []string{""}
		length, trimmed := 0, -1
		wrapWord := func(value string) int {
			visible := length
			tokens := terminalTokens(value)
			for i, token := range tokens {
				if token.width > 0 && visible > 0 && visible+token.width > width {
					rows = append(rows, "")
					visible = 0
				}
				rows[len(rows)-1] += token.value
				visible += token.width
				if visible == width && i < len(tokens)-1 {
					rows = append(rows, "")
					visible = 0
				}
			}
			if visible == 0 && rows[len(rows)-1] != "" && len(rows) > 1 {
				rows[len(rows)-2] += rows[len(rows)-1]
				rows = rows[:len(rows)-1]
			}
			return visibleWidth(rows[len(rows)-1])
		}
		for i, part := range parts {
			index := len(rows) - 1
			if trim && trimmed != index {
				rows[index] = strings.TrimLeftFunc(rows[index], unicode.IsSpace)
				length = visibleWidth(rows[index])
				if rows[index] != "" {
					trimmed = index
				}
			}
			if i > 0 {
				if length >= width && (!words || !trim) {
					rows = append(rows, "")
					length = 0
				}
				if length > 0 || !trim {
					rows[len(rows)-1] += " "
					length++
				}
			}
			if words && part.width > width {
				remaining := width - length
				thisBreaks := 1 + int(math.Floor(float64(part.width-remaining-1)/float64(width)))
				nextBreaks := (part.width - 1) / width
				if nextBreaks < thisBreaks {
					rows = append(rows, "")
					length = 0
				}
				length = wrapWord(part.value)
				continue
			}
			if length+part.width > width && length > 0 && part.width > 0 {
				if !words && length < width {
					length = wrapWord(part.value)
					continue
				}
				rows = append(rows, "")
				length = 0
			}
			if length+part.width > width && !words {
				length = wrapWord(part.value)
				continue
			}
			rows[len(rows)-1] += part.value
			length += part.width
		}
		if trim {
			for i, row := range rows {
				rows[i] = trimVisibleSpacesRight(row)
			}
		}
		result = append(result, rows...)
	}
	return restoreRowStyles(result)
}
func trimVisibleSpacesRight(value string) string {
	tokens := terminalTokens(value)
	for i := len(tokens) - 1; i >= 0; i-- {
		if tokens[i].escape {
			continue
		}
		if tokens[i].value != " " {
			break
		}
		tokens[i].value = ""
	}
	var sb strings.Builder
	for _, token := range tokens {
		sb.WriteString(token.value)
	}
	return sb.String()
}

type sgrStyle struct{ family, open, close string }

func restoreRowStyles(rows []string) []string {
	var styles []sgrStyle
	result := make([]string, len(rows))
	remove := func(family string) {
		for i := len(styles) - 1; i >= 0; i-- {
			if styles[i].family == family {
				styles = append(styles[:i], styles[i+1:]...)
			}
		}
	}
	for i, row := range rows {
		var sb strings.Builder
		if row != "" {
			for _, style := range styles {
				sb.WriteString("\x1b[" + style.open + "m")
			}
		}
		for _, token := range terminalTokens(row) {
			sb.WriteString(token.value)
			if !strings.HasPrefix(token.value, "\x1b[") || !strings.HasSuffix(token.value, "m") {
				continue
			}
			parts := strings.Split(token.value[2:len(token.value)-1], ";")
			for j := 0; j < len(parts); j++ {
				code, _ := strconv.Atoi(parts[j])
				if code == 0 {
					styles = nil
					continue
				}
				family, close := "", ""
				switch code {
				case 1, 2:
					family, close = "intensity", "22"
				case 3:
					family, close = "italic", "23"
				case 4:
					family, close = "underline", "24"
				case 7:
					family, close = "inverse", "27"
				case 9:
					family, close = "strike", "29"
				case 22:
					remove("intensity")
				case 23:
					remove("italic")
				case 24:
					remove("underline")
				case 27:
					remove("inverse")
				case 29:
					remove("strike")
				case 39:
					remove("foreground")
				case 49:
					remove("background")
				default:
					if code >= 30 && code <= 37 || code >= 90 && code <= 97 || code == 38 {
						family, close = "foreground", "39"
					}
					if code >= 40 && code <= 47 || code >= 100 && code <= 107 || code == 48 {
						family, close = "background", "49"
					}
				}
				if family != "" {
					open := parts[j]
					if (code == 38 || code == 48) && j+1 < len(parts) {
						count := 2
						if parts[j+1] == "2" {
							count = 4
						}
						end := min(len(parts), j+count+1)
						open = strings.Join(parts[j:end], ";")
						j = end - 1
					}
					remove(family)
					styles = append(styles, sgrStyle{family, open, close})
				}
			}
		}
		if row != "" && i < len(rows)-1 {
			for j := len(styles) - 1; j >= 0; j-- {
				sb.WriteString("\x1b[" + styles[j].close + "m")
			}
		}
		result[i] = sb.String()
	}
	return result
}
