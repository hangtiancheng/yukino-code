/**
 * Extract the base command name from a command string.
 * Take the last command in a pipeline or command chain because shells surface
 * the exit code of the command that ran last.
 */
export function extractBaseCmd(command: string): string {
  const lastSegment =
    command
      .split(/\|\||&&|[|;]/u)
      .pop()
      ?.trim() ?? command;
  const tokens = lastSegment.split(/\s+/);
  for (const token of tokens) {
    // Skip tokens like VAR=value or $env:VAR=value (variable assignments)
    if (token.includes("=") && !token.startsWith("-")) {
      continue;
    }
    // Strip path prefix (both separators) and the .exe suffix; normalize to
    // lowercase since Windows command names are case-insensitive
    const base = token.split(/[\\/]/).pop() ?? token;
    return base.replace(/\.exe$/i, "").toLowerCase();
  }
  return "";
}

// grep, rg, findstr, diff, cmp, test, [, expr, find, robocopy
const EXIT_CODE_HINTS = new Map<string, Map<number, string>>([
  // Search tools: exit 1 means "no match", not failure
  [
    "grep",
    new Map([
      [1, "no matches found"],
      [2, "error while searching"],
    ]),
  ],
  [
    "rg",
    new Map([
      [1, "no matches found"],
      [2, "error while searching"],
    ]),
  ],
  [
    "findstr",
    new Map([
      [1, "no matches found"],
      [2, "error while searching"],
    ]),
  ],
  // Comparison / condition tools: non-zero exit is informational
  [
    "diff",
    new Map([
      [1, "files differ"],
      [2, "trouble reading files"],
    ]),
  ],
  [
    "cmp",
    new Map([
      [1, "files differ"],
      [2, "trouble reading files"],
    ]),
  ],
  [
    "test",
    new Map([
      [1, "condition is false"],
      [2, "expression error"],
    ]),
  ],
  [
    "[",
    new Map([
      [1, "condition is false"],
      [2, "expression error"],
    ]),
  ],
  [
    "expr",
    new Map([
      [1, "expression is null or zero"],
      [2, "syntax error"],
    ]),
  ],
  [
    "find",
    new Map([[1, "partial success — some inputs could not be processed"]]),
  ],
  // Windows
  [
    "robocopy",
    new Map([
      [1, "success — files copied"],
      [2, "success — extra files or directories detected"],
      [4, "success — mismatched files detected"],
      [8, "some files failed to copy"],
      [16, "serious error — no files copied"],
    ]),
  ],
]);

// Shell-level exit codes that apply to any command
const GENERIC_HINTS = new Map<number, string>([
  [126, "command found but not executable"],
  [127, "command not found"],
  [129, "terminated by SIGHUP"],
  [130, "terminated by SIGINT (Ctrl+C)"],
  [137, "killed by SIGKILL (often OOM)"],
  [141, "downstream consumer exited early (SIGPIPE)"],
  [143, "terminated by SIGTERM"],
]);

/**
 * Return a semantic hint for a non-zero exit code, helping the LLM understand
 * what the code means. Command-specific hints win over generic ones; POSIX
 * 128+n signal exits get a fallback description. Returns empty string when
 * nothing is recognized.
 */
export function exitCodeHint(command: string, exitCode: number): string {
  const baseCmd = extractBaseCmd(command);
  const hint =
    EXIT_CODE_HINTS.get(baseCmd)?.get(exitCode) ?? GENERIC_HINTS.get(exitCode);
  if (hint) {
    return hint;
  }
  // 128+n is the POSIX "killed by signal n" convention; the range is capped
  // because Windows HRESULT-style exit codes are far larger numbers.
  if (exitCode >= 129 && exitCode <= 159) {
    return `terminated by signal ${String(exitCode - 128)}`;
  }
  return "";
}
