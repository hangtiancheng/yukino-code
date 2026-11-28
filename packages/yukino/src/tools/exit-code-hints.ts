import { parse } from "shell-quote";

import { EXIT_CODE_HINTS, GENERIC_HINTS } from "@/tools/constants.js";

export function extractBaseCmd(command: string): string {
  try {
    let words: string[] = [];
    for (const token of parse(command, (key) => `$${key}`)) {
      if (typeof token === "string") {
        words.push(token);
      } else if (
        "op" in token &&
        [";", "|", "&", "&&", "||"].includes(token.op)
      ) {
        words = [];
      }
    }
    const name = words.find(
      (word) => !/^(?:\$env:)?[a-zA-Z_][a-zA-Z0-9_]*=/u.test(word),
    );
    return (name?.split(/[\\/]/u).at(-1) ?? "")
      .replace(/\.exe$/iu, "")
      .toLowerCase();
  } catch {
    return "";
  }
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
