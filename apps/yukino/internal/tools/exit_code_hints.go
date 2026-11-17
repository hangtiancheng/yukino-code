package tools

import (
	"fmt"
	"strings"
)

func extractLastCommand(command string) string {
	var segments []string
	var current strings.Builder
	var quote byte
	for i := 0; i < len(command); i++ {
		ch := command[i]
		if quote != 0 {
			if quote == '"' && ch == '\\' && i+1 < len(command) {
				current.WriteByte(ch)
				i++
				current.WriteByte(command[i])
				continue
			}
			if ch == quote {
				quote = 0
			}
			current.WriteByte(ch)
			continue
		}
		if ch == '"' || ch == '\'' {
			quote = ch
			current.WriteByte(ch)
			continue
		}
		if ch == ';' || ch == '|' || ch == '&' && i+1 < len(command) && command[i+1] == '&' {
			if (ch == '|' || ch == '&') && i+1 < len(command) && command[i+1] == ch {
				i++
			}
			segments = append(segments, current.String())
			current.Reset()
			continue
		}
		current.WriteByte(ch)
	}
	if quote != 0 {
		return ""
	}
	segments = append(segments, current.String())
	for _, token := range strings.Fields(segments[len(segments)-1]) {
		if strings.Contains(token, "=") && !strings.HasPrefix(token, "-") {
			continue
		}
		pieces := strings.FieldsFunc(token, func(r rune) bool { return r == '/' || r == '\\' })
		if len(pieces) == 0 {
			return ""
		}
		return strings.TrimSuffix(strings.ToLower(pieces[len(pieces)-1]), ".exe")
	}
	return ""
}

var exitCodeHints = map[string]map[int]string{
	"grep": {1: "no matches found", 2: "error while searching"}, "rg": {1: "no matches found", 2: "error while searching"}, "findstr": {1: "no matches found", 2: "error while searching"},
	"diff": {1: "files differ", 2: "trouble reading files"}, "cmp": {1: "files differ", 2: "trouble reading files"}, "test": {1: "condition is false", 2: "expression error"}, "[": {1: "condition is false", 2: "expression error"}, "expr": {1: "expression is null or zero", 2: "syntax error"}, "find": {1: "partial success — some inputs could not be processed"}, "robocopy": {1: "success — files copied", 2: "success — extra files or directories detected", 4: "success — mismatched files detected", 8: "some files failed to copy", 16: "serious error — no files copied"},
}
var genericExitCodeHints = map[int]string{126: "command found but not executable", 127: "command not found", 129: "terminated by SIGHUP", 130: "terminated by SIGINT (Ctrl+C)", 137: "killed by SIGKILL (often OOM)", 141: "downstream consumer exited early (SIGPIPE)", 143: "terminated by SIGTERM"}

func exitCodeHint(command string, code int) string {
	if hint := exitCodeHints[extractLastCommand(command)][code]; hint != "" {
		return hint
	}
	if hint := genericExitCodeHints[code]; hint != "" {
		return hint
	}
	if code >= 129 && code <= 159 {
		return fmt.Sprintf("terminated by signal %d", code-128)
	}
	return ""
}
