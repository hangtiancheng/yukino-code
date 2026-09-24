/**
 * Copyright (c) 2026 hangtiancheng
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

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
export const BASH_BACKGROUND_DESCRIPTION = `- Set run_in_background to true to run the command in the background. The call returns a task ID immediately and the result arrives later as a task notification; do not poll or sleep waiting for it. Use this for long-running commands you do not need the result of right away. Use TaskStop with the task_id to kill a background command early. A foreground command that exceeds its timeout is moved to the background automatically instead of being killed, unless it is a bare sleep.`;

export const POWERSHELL_DESCRIPTION = `Execute command in PowerShell; return stdout and stderr. Recommended on Windows (powershell.exe); uses pwsh elsewhere.
- timeout is in seconds: default 120, maximum 600. Each call starts a fresh, independent shell in the Agent's working directory; location, variables, and options do not persist.
- Quote paths with spaces; use Set-Location -LiteralPath "path" in the same call. Separate independent commands. For dependencies, check $LASTEXITCODE for native commands and use -ErrorAction Stop for cmdlets; ; does not stop on failure. Do not assume PowerShell 7 syntax.
- Prefer dedicated file/search tools over Get-Content, Select-String, or Write-Output. Scope recursion to a directory, not a drive root. Diagnose failures rather than retrying in Start-Sleep loops.
${GIT_GUIDANCE}`;

/**
 * Appended to the PowerShell schema description only when background execution
 * is available; mirrors BASH_BACKGROUND_DESCRIPTION with PS-flavored wording.
 */
export const POWERSHELL_BACKGROUND_DESCRIPTION = `- Set run_in_background to true to run the command in the background. The call returns a task ID immediately and the result arrives later as a task notification; do not poll or Start-Sleep waiting for it. Use this for long-running commands you do not need the result of right away. Use TaskStop with the task_id to kill a background command early. A foreground command that exceeds its timeout is moved to the background automatically instead of being killed, unless it is a bare Start-Sleep.`;

export const READ_FILE_DESCRIPTION = `Read text with 1-based display line numbers, or images (png, jpg, jpeg, gif, webp) as visual content; not directories.
- file_path is absolute or relative to the Agent's working directory. offset skips lines (0-based, default 0); limit defaults to 2000 lines, with a 50KB text output cap. Displayed line 101 starts at offset=100. Follow continuation/readback instructions for partial output.
- Images ignore offset/limit. A successful read refreshes the file-state cache used by EditFile/WriteFile; re-read after an external-change error.`;

export const EDIT_FILE_DESCRIPTION = `Replace exact text in an existing file and return a diff. Prefer this over whole-file rewrites.
- file_path is absolute or relative to the Agent's working directory. ReadFile is required first; stale file-state errors require a fresh read and revised edit.
- old_string must be non-empty and unique unless replace_all=true (default false). Use enough context to disambiguate; preserve whitespace and exclude display line numbers.
- new_string must differ from old_string; an empty string deletes the match.`;

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
- HTML is converted to Markdown; other text formats (plain text, JSON, XML, Markdown) are returned as-is. Binary content (images, PDFs, archives) is rejected.
- Responses over 10MB are rejected and results are truncated at 100K characters. Successful fetches are cached for 15 minutes.`;
