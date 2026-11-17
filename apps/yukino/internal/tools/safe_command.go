package tools

import (
	"regexp"
	"strings"
)

// SafePrefixes mirrors SAFE_PREFIXES in src/permissions/constants.ts:
// read-only commands that never need approval on their own.
var safePrefixes = []string{
	"echo", // Output only, no dangerous flags
	"printf",
	"wc",
	"grep",
	"head",
	"tail",

	// Time and date
	"cal",
	"uptime",

	// File content viewing
	"cat",
	"stat",
	"strings",
	"hexdump",
	"od",
	"nl",

	// System info
	"id",
	"uname",
	"free",
	"df",
	"du",
	"locale",
	"groups",
	"nproc",

	// Path information
	"basename",
	"dirname",
	"realpath",
	"readlink",

	// Text processing
	"cut",
	"paste",
	"tr",
	"column",
	"tac",
	"rev",
	"fold",
	"expand",
	"unexpand",
	"fmt",
	"comm",
	"cmp",
	"numfmt",

	// File comparison
	"diff",

	// true and false, used to silence or create errors
	"true",
	"false",

	// Misc. safe commands
	"sleep",
	"which",
	"type",
	"expr",
	"test",
	"getconf",
	"seq",
	"tsort",
	"pr",
}

var safePrefixRegexes = []*regexp.Regexp{
	regexp.MustCompile(`^docker\s+(?:ps|images)(?:\s|$)`),
}

// Shell metacharacters that disqualify a command from the safe fast path: a
// "safe" prefix like cat must not become a gateway to piping, chaining,
// redirection or substitution.
var safeCommandMetaRe = regexp.MustCompile("[\r\n&|;<>`(){}\\[\\]]")

func IsSafeCommand(command string) bool {
	trimmed := strings.TrimSpace(command)
	if safeCommandMetaRe.MatchString(trimmed) {
		return false
	}
	for _, prefix := range safePrefixes {
		if trimmed == prefix || strings.HasPrefix(trimmed, prefix+" ") || strings.HasPrefix(trimmed, prefix+"\t") {
			return true
		}
	}
	for _, re := range safePrefixRegexes {
		if re.MatchString(trimmed) {
			return true
		}
	}
	return false
}
