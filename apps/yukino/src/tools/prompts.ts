const GIT_GUIDANCE = `Git: commit or push only when requested. Destructive operations (push --force, reset --hard, checkout ., clean -f, branch -D), amending, or skipping hooks/signing require explicit authorization; never bypass permission/hook denials. Prefer new commits. When committing, include Co-Authored-By: Yukino <usr161043261@outlook.com>.`;

export const BASH_DESCRIPTION = `Execute command in Bash; return stdout and stderr. Prefer PowerShell on Windows.
- timeout is in seconds: default 120, maximum 600. Each call starts a fresh, independent shell in the Agent's working directory; cd, variables, functions, and options do not persist.
- Quote paths with spaces. To change directory, use cd "path" && command in the same call. Separate independent commands; chain dependent commands with &&, not ;.
- Prefer dedicated file/search tools over cat, head, tail, sed, awk, echo, or find. Scope searches to a directory, never the filesystem root. Diagnose failures rather than retrying in sleep loops.
${GIT_GUIDANCE}`;

/**
 * Appended to the Bash schema description only when background execution is
 * available (a TaskManager is wired and not disabled via env), so the
 * run_in_background parameter and its guidance never advertise a capability
 * the current host cannot deliver.
 */
export const BASH_BACKGROUND_DESCRIPTION = `- Set run_in_background to true to run the command in the background. The call returns a task ID immediately and the result arrives later as a task notification; do not poll or sleep waiting for it. Use this for long-running commands you do not need the result of right away. Use TaskStop with the task_id to kill a background command early. A foreground command that exceeds its timeout is moved to the background automatically instead of being killed.`;

export const POWERSHELL_DESCRIPTION = `Execute command in PowerShell; return stdout and stderr. Recommended on Windows (powershell.exe); uses pwsh elsewhere.
- timeout is in seconds: default 120, maximum 600. Each call starts a fresh, independent shell in the Agent's working directory; location, variables, and options do not persist.
- Quote paths with spaces; use Set-Location -LiteralPath "path" in the same call. Separate independent commands. For dependencies, check $LASTEXITCODE for native commands and use -ErrorAction Stop for cmdlets; ; does not stop on failure. Do not assume PowerShell 7 syntax.
- Prefer dedicated file/search tools over Get-Content, Select-String, or Write-Output. Scope recursion to a directory, not a drive root. Diagnose failures rather than retrying in Start-Sleep loops.
${GIT_GUIDANCE}`;

/**
 * Appended to the PowerShell schema description only when background execution
 * is available; mirrors BASH_BACKGROUND_DESCRIPTION with PS-flavored wording.
 */
export const POWERSHELL_BACKGROUND_DESCRIPTION = `- Set run_in_background to true to run the command in the background. The call returns a task ID immediately and the result arrives later as a task notification; do not poll or Start-Sleep waiting for it. Use this for long-running commands you do not need the result of right away. Use TaskStop with the task_id to kill a background command early. A foreground command that exceeds its timeout is moved to the background automatically instead of being killed.`;

export const READ_FILE_DESCRIPTION = `Read text with 1-based display line numbers, or images (png, jpg, jpeg, gif, webp) as visual content; not directories.
- file_path is absolute or relative to the Agent's working directory. offset skips lines (0-based, default 0); limit defaults to 2000 lines, with a 50KB text output cap. Displayed line 101 starts at offset=100. Follow continuation/readback instructions for partial output.
- Images ignore offset/limit. A successful read refreshes the file-state cache used by EditFile/WriteFile; re-read after an external-change error.`;

export const EDIT_FILE_DESCRIPTION = `Replace exact text in an existing file and return a diff. Prefer this over whole-file rewrites; batch disjoint changes in one edits array to read and write the file once.
- file_path is absolute or relative to the Agent's working directory. ReadFile is required first; stale file-state errors require a fresh read and revised edit.
- Each edits entry contains old_string and new_string, with optional replace_all. All matches use the original file; overlapping edits are rejected before writing. Merge overlapping changes into one entry.
- old_string must be non-empty and unique unless replace_all=true (default false). LF and CRLF line endings match equivalently. Use enough context to disambiguate; preserve all other whitespace and exclude display line numbers. If matching fails, stray carriage returns in both edit strings are removed before retrying.
- new_string must differ from old_string; an empty string deletes the match. The file's line endings and unchanged text are preserved.`;

export const WRITE_FILE_DESCRIPTION = `Write complete UTF-8 content to file_path, creating parent directories and overwriting existing content. Use for new files or complete rewrites; prefer EditFile for targeted changes.
- file_path is absolute or relative to the Agent's working directory. Existing files require ReadFile first; re-read if the cached state is stale.
- content includes any desired trailing newline; an empty string creates or truncates an empty file. Avoid unrelated files or unsolicited documentation.`;

export const GLOB_DESCRIPTION = `Find files by glob pattern (e.g. "**/*.ts", "*.{ts,tsx}"). Return paths relative to path, sorted newest modification first.
- path is absolute or relative to the Agent's working directory (default "."); never search the filesystem root.
- Includes dotfiles; traversal skips fixed directories such as .git, .agents, .yukino, node_modules, dist, and __pycache__, not rules from .gitignore.
- At most 1000 matches; narrow limited searches rather than treating them as exhaustive. Prefer this over shell find/ls.`;

export const GREP_DESCRIPTION = `Search file content with a case-insensitive, line-by-line JavaScript-style regex pattern; return file:line:content with 1-based lines and working-directory-relative paths.
- path is a file or directory, absolute or relative to the Agent's working directory (default "."). Escape regex backslashes in JSON. No multiline matching or general PCRE support.
- include is an optional glob: "*.ts" matches names at any depth; patterns with "/" match working-directory-relative paths. A direct file path is searched without this filter.
- Traversal includes dotfiles but skips fixed directories such as .git, .agents, .yukino, node_modules, dist, and __pycache__, not .gitignore rules. Binary/unreadable files are skipped; directory symlinks are not traversed.
- At most 500 matching lines. Narrow searches; never search the filesystem root. Use ReadFile for context and this tool instead of shell grep/rg.`;

export const WEB_FETCH_DESCRIPTION = `Fetch a URL over HTTP(S) and return its content as Markdown. Use it to retrieve and analyze web pages.
- url must be a fully-formed http or https URL; redirects are followed automatically and the final URL is reported when it differs.
- HTML is converted to Markdown; other text formats (plain text, JSON, XML, Markdown) are returned as-is. Binary content (images, PDFs, archives) are rejected.
- Responses over 10MB are rejected and results are truncated at 100K characters. Successful fetches are cached for 15 minutes.`;

export const ASK_USER_QUESTION_DESCRIPTION = `
  Ask the user 1 to 4 single-choice or multiple-choices questions and wait for their answers. Each question needs 2 to 4 options; an "Other" option for custom input is added automatically.
  Set multiSelect=true when the user may choose multiple options, or false for one mutually exclusive choice. Ask only for missing information that changes the task; do not re-request authorization already given.
  `;

export const ENTER_PLAN_MODE_DESCRIPTION = `Use this tool proactively before a non-trivial implementation when the right approach is genuinely unclear and user review would prevent significant rework. It runs the built-in plan agent synchronously in the foreground with a fork of your conversation. The read-only agent investigates and returns a concrete plan; the host saves the plan and presents it for user approval. A successful call ends this turn. Do not implement until the user approves.

Use it for significant architectural ambiguity, unclear requirements that require exploration, or high-impact restructuring. Skip it when the task is straightforward, the user has already specified the implementation, the fix is obvious after diagnosis, or the request is pure research. Do not use it from delegated agents. This tool takes no parameters.`;

export const EXIT_PLAN_MODE_DESCRIPTION =
  "Submit the completed plan from the plan file. The main agent presents it for user approval; a teammate follows the host's team approval policy (leader review in coordinator mode, automatic approval otherwise); a one-shot subagent returns it to the parent. Do not implement until the host approves execution.";

export const ENTER_WORKTREE_DESCRIPTION =
  "Create an isolated git worktree and switch this agent's working directory into it. " +
  "Use only when the user explicitly requests a worktree. Only one worktree session may be active at a time. " +
  "The optional slug is generated randomly when omitted. Use ExitWorktree to return to the original directory.";

export const EXIT_WORKTREE_DESCRIPTION =
  "Exit this agent's active EnterWorktree session and restore its original working directory. " +
  "Use only when the user asks to leave the worktree. With no active session this is a no-op. " +
  "Use action: keep to preserve the worktree and branch, or remove to delete both. " +
  "Removal refuses uncommitted files, new commits, or unverifiable state unless discard_changes is true. " +
  "If removal is refused, confirm with the user before retrying with discard_changes: true. " +
  "Manually created worktrees and worktrees from other runtimes are never adopted.";

export const WORKTREE_SLUG_DESCRIPTION =
  "Optional worktree identifier and branch suffix, using letters, digits, hyphens, or underscores. A random slug is generated when omitted.";
export const WORKTREE_ACTION_DESCRIPTION =
  '"keep" preserves the worktree and branch; "remove" deletes both.';
export const WORKTREE_DISCARD_CHANGES_DESCRIPTION =
  "Explicitly allow discarding uncommitted files and new commits, or removing when changes cannot be verified. Confirm with the user before setting true. Only applies to remove.";

export const GOAL_DESCRIPTION =
  "Get the user-set persistent goal, or report in_progress, complete, or blocked with a reason. A goal is active automatically when the user sets it; in_progress reports progress and resets the blocker audit while keeping it active. Only the user can set, replace, pause, resume, or clear goals. Complete only when all requirements are achieved and verified. Record the same blocker on three consecutive continuation turns before stopping; multiple calls in one turn count once.";

export const GOAL_ACTION_DESCRIPTION =
  "Read goal status, or report progress, completion, or blockage.";
export const GOAL_STATUS_DESCRIPTION =
  "Required for update. Use in_progress to report progress and reset the blocker audit on an active goal, complete when verified, or blocked for an unavoidable blocker.";
export const GOAL_REASON_DESCRIPTION =
  "Required for update. Describe progress, evidence of completion, or the specific blocker.";

export const LSP_DESCRIPTION =
  "Query a configured language server for definitions, references, hover, symbols, implementations, type definitions, call hierarchy, or diagnostics. file_path resolves against the current working directory; line and character are 1-based UTF-16 positions. Returned ranges use the LSP standard (0-based UTF-16) and file URIs. This tool cannot edit files or run arbitrary commands. Servers must be explicitly configured in lsp_servers; no automatic installation.";

export const MCP_CALL_DESCRIPTION =
  "Invoke a tool on a connected MCP server. Call ToolSearch first to load the " +
  "tool's schema, then pass its arguments here exactly as that schema requires, " +
  "using the same JSON types.";

export const SYNTHETIC_OUTPUT_DESCRIPTION =
  "Return structured output in JSON format. Use this tool to return your final response " +
  "as structured data in non-interactive or coordinator mode sessions.";

export const TASK_OUTPUT_DESCRIPTION =
  "Inspect a background Agent/Bash/PowerShell task by its task_id, or wait once for at most timeout_ms (maximum 60000). This does not consume completion notifications or cancel timed-out tasks. Prefer automatic task notifications over repeated polling. TaskCreate IDs belong to the separate TODO list and cannot be used here.";

export const TOOL_SEARCH_DESCRIPTION =
  "Search for and load deferred tools by name or keyword.";

export function computerUseDescription(environment: string): string {
  return (
    `Control the current ${environment} computer with screenshots, mouse, keyboard, scrolling, waiting, and zoom. ` +
    "Use screenshot before choosing coordinates and verify consequential actions with another screenshot. " +
    "Two call styles are supported: Anthropic-style single actions (action + coordinate/scroll_amount/scroll_direction/start_coordinate/region/text), " +
    "and OpenAI-style batches (actions[] of typed actions with x/y/button/keys/path/scrollX/scrollY/text, plus pendingSafetyChecks and status; " +
    "a screenshot is returned after the batch). Flat OpenAI aliases (action=click/drag/keypress/move) are also accepted."
  );
}
