package permissions

import (
	"regexp"
	"strings"
	"unicode"
)

type ShellCommand struct {
	Content string
	Words   []string
}

type ShellAnalysis struct {
	Commands []ShellCommand
	Complete bool
}

var (
	shellPathSepRe   = regexp.MustCompile(`[\\/]`)
	shellWordFlagRe  = regexp.MustCompile(`[\s*?[\]~]`)
	shellVarAssignRe = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*\+?=`)
	shellMetaRe      = regexp.MustCompile("[;|&\r\n]")
	shellExpandRe    = regexp.MustCompile("[$`(){}\x00<>]")
	shellCommentRe   = regexp.MustCompile("[\r\n]")
	shellDQExpandRe  = regexp.MustCompile("[$`]")
)

// AnalyzeShell analyzes literal simple commands and lists; expansion,
// redirection and control syntax deliberately require a separate approval
// instead of prefix authority.
func AnalyzeShell(command string, powershell bool) ShellAnalysis {
	var commands []ShellCommand
	complete := true
	quote := ""
	word := ""
	inWord := false
	var words []string

	endWord := func() {
		if inWord {
			words = append(words, word)
			word = ""
			inWord = false
		}
	}
	endCommand := func() {
		endWord()
		if len(words) > 0 {
			parts := shellPathSepRe.Split(words[0], -1)
			executable := strings.ToLower(parts[len(parts)-1])
			if words[0] == "" ||
				ComplexCommands[strings.TrimSuffix(executable, ".exe")] ||
				shellWordFlagRe.MatchString(words[0]) || strings.ContainsFunc(words[0], shellWhitespace) ||
				shellVarAssignRe.MatchString(words[0]) {
				complete = false
			}
			commands = append(commands, ShellCommand{Content: strings.Join(words, " "), Words: words})
			words = nil
		}
	}

	escape := '\\'
	if powershell {
		escape = '`'
	}
	runes := []rune(command)
	for i := 0; i < len(runes); i++ {
		c := runes[i]
		var next rune
		hasNext := i+1 < len(runes)
		if hasNext {
			next = runes[i+1]
		}
		if quote == "'" {
			if c == '\'' {
				if powershell && hasNext && next == '\'' {
					word += "'"
					i++
				} else {
					quote = ""
				}
			} else {
				word += string(c)
			}
			continue
		}
		if c == escape {
			if !hasNext {
				complete = false
			} else if next == '\n' {
				i++
			} else if next == '\r' && i+2 < len(runes) && runes[i+2] == '\n' {
				i += 2
			} else if quote == "" || powershell || next == '$' || next == '`' || next == '"' || next == '\\' {
				word += string(next)
				inWord = true
				i++
			} else {
				word += string(c)
			}
			continue
		}
		if quote == "\"" {
			if c == '"' {
				if powershell && hasNext && next == '"' {
					word += "\""
					i++
				} else {
					quote = ""
				}
			} else {
				if c == '$' || (!powershell && c == '`') {
					complete = false
				}
				word += string(c)
			}
			continue
		}
		if c == '\'' || c == '"' {
			quote = string(c)
			inWord = true
		} else if c == '#' && !inWord {
			for i+1 < len(runes) && runes[i+1] != '\r' && runes[i+1] != '\n' {
				i++
			}
		} else if c == ';' || c == '|' || c == '&' || c == '\r' || c == '\n' {
			if len(words) == 0 && !inWord && (c == '|' || c == '&') {
				complete = false
			}
			endCommand()
			if (c == '&' || c == '|') && hasNext && next == c {
				i++
			}
		} else if shellWhitespace(c) {
			endWord()
		} else {
			if strings.ContainsRune("$`(){}\x00<>", c) {
				complete = false
			}
			word += string(c)
			inWord = true
		}
	}
	if quote != "" {
		complete = false
	}
	endCommand()
	return ShellAnalysis{Commands: commands, Complete: complete && len(commands) > 0}
}

func shellWhitespace(r rune) bool {
	return r == '\uFEFF' || unicode.IsSpace(r) && r != '\u0085'
}
