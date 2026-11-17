package conversation

import "regexp"

const (
	MaxInlineBytes      = 100_000
	MaxInlineTotalBytes = 300_000
	MaxAtRefs           = 32
	// Files larger than this are never read, even for a narrow line range.
	MaxRangeFileBytes = 10_000_000
)

// Used to fill in tool calls that have no result. The tool may never have
// started, or it may have been interrupted partway through, so the wording must
// not assert that it produced no side effects.
const InterruptedToolResult = "Tool execution was interrupted. The tool may or may not have completed; verify before relying on its effects."

// Used for tool calls the user explicitly declined to authorize. In this case
// we can assert that nothing was changed, and we must state this clearly;
// otherwise the model will assume the modification took effect and proceed
// accordingly.
const RejectedToolResult = "The user rejected this tool use. Nothing was changed (for file edits, the new content was NOT written)."

// Protocol wrapper for model-facing reminders injected as user messages.
const (
	SystemReminderOpen  = "<system-reminder>"
	SystemReminderClose = "</system-reminder>"
)

// Nested reminder tags in injected content are escaped so the wrapper boundary
// stays unambiguous. The reference uses a lookahead; Go regexp captures the tag
// prefix instead and re-emits it.
var SystemReminderTagRe = regexp.MustCompile(`(?i)<(\s*/?\s*system-reminder\b)`)

// An @ref may carry a #L3 or #L3-10 line-range suffix (inserted via the IDE
// integration).
var AtRefLineRangeRe = regexp.MustCompile(`^(.+)#L(\d+)(?:-L?(\d+))?$`)

// JavaScript's \s set: ASCII whitespace plus the ECMAScript Unicode space
// separators and BOM.
const jsWhitespace = `\t\n\v\f\r \x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}`

// Clipboard images and paths containing spaces use quoted mentions.
var AtRefRe = regexp.MustCompile(`(?:^|[` + jsWhitespace + `(（])(?:'@([^']+)'|"@([^"]+)"|@"([^"]+)"|@'([^']+)'|@([^` + jsWhitespace + `#,;，；。！？、()（）<>"'` + "`" + `]+(?:#L\d+(?:-L?\d+)?)?))`)

// User-executed Bash ("!" prefix) protocol markers and inline-output budgets.
const (
	UserBashPrefix            = "!"
	UserBashExcludedPrefix    = "!!"
	UserBashInlineOutputBytes = 50 * 1024
	UserBashInlineOutputLines = 2000
)
