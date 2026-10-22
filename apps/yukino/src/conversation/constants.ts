export const MAX_INLINE_BYTES = 100_000;
export const MAX_INLINE_TOTAL_BYTES = 300_000;
export const MAX_AT_REFS = 32;
// Files larger than this are never read, even for a narrow line range.
export const MAX_RANGE_FILE_BYTES = 10_000_000;

/** Used to fill in tool calls that have no result. The tool may never have started,
 *  or it may have been interrupted partway through, so the wording must not assert
 *  that it produced no side effects. */
export const INTERRUPTED_TOOL_RESULT =
  "Tool execution was interrupted. The tool may or may not have completed; verify before relying on its effects.";

/** Used for tool calls the user explicitly declined to authorize. In this case we can
 *  assert that nothing was changed, and we must state this clearly; otherwise the
 *  model will assume the modification took effect and proceed accordingly. */
export const REJECTED_TOOL_RESULT =
  "The user rejected this tool use. Nothing was changed (for file edits, the new content was NOT written).";

// Protocol wrapper for model-facing reminders injected as user messages.
export const SYSTEM_REMINDER_OPEN = "<system-reminder>";
export const SYSTEM_REMINDER_CLOSE = "</system-reminder>";
// Nested reminder tags in injected content are escaped so the wrapper boundary
// stays unambiguous.
export const SYSTEM_REMINDER_ESCAPE_RE = /<(?=\s*\/?\s*system-reminder\b)/giu;

// An @ref may carry a #L3 or #L3-10 line-range suffix (inserted via the IDE integration).
export const AT_REF_LINE_RANGE_RE = /^(.+)#L(\d+)(?:-(\d+))?$/;
// Clipboard images and paths containing spaces use quoted mentions.
export const AT_REF_RE =
  /(?:^|\s)(?:'@([^']+)'|"@([^"]+)"|@"([^"]+)"|@'([^']+)'|@([^\s]+))/g;

// User-executed Bash ("!" prefix) protocol markers and inline-output budgets.
export const USER_BASH_PREFIX = "!";
export const USER_BASH_EXCLUDED_PREFIX = "!!";
export const USER_BASH_INLINE_OUTPUT_BYTES = 50 * 1024;
export const USER_BASH_INLINE_OUTPUT_LINES = 2000;
