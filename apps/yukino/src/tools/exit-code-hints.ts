import { EXIT_CODE_HINTS, GENERIC_HINTS } from "@/tools/constants.js";

/**
 * Extract the base command name from a command string.
 * Take the last command in a pipeline or command chain because shells surface
 * the exit code of the command that ran last.
 */
// Splits on top-level shell separators (| || ; &&) while treating quoted spans
// as literal text. Returns undefined when quotes are unbalanced, signalling that
// the command cannot be parsed reliably.
function splitTopLevelSegments(command: string): string[] | undefined {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (quote === '"' && ch === "\\" && i + 1 < command.length) {
        current += ch + command[i + 1];
        i++;
        continue;
      }
      if (ch === quote) {
        quote = undefined;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "|") {
      if (ch === "|" && command[i + 1] === "|") {
        i++;
      }
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    current += ch;
  }
  if (quote) {
    return undefined;
  }
  segments.push(current);
  return segments;
}

export function extractBaseCmd(command: string): string {
  const segments = splitTopLevelSegments(command);
  if (!segments) {
    // Unreliable parse (e.g. unbalanced quotes): report no command so only the
    // generic exit-code hints are shown rather than a wrong command-specific one.
    return "";
  }
  const lastSegment = segments[segments.length - 1]?.trim() ?? "";
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
