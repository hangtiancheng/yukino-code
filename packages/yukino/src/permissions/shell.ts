import { parse } from "shell-quote";

export interface ShellCommand {
  content: string;
  words: string[];
}
export interface ShellAnalysis {
  commands: ShellCommand[];
  complete: boolean;
}

export function analyzeShell(
  command: string,
  powershell = false,
): ShellAnalysis {
  const commands: ShellCommand[] = [];
  let words: string[] = [];
  let complete = !/[`\r\n\u0000]/u.test(command);
  const endCommand = () => {
    if (words.length) {
      commands.push({ content: words.join(" "), words });
      words = [];
    }
  };
  try {
    const tokens = parse<{ expansion: string }>(
      command,
      (key) => {
        complete = false;
        return { expansion: key };
      },
      { escape: powershell ? "`" : "\\" },
    );
    for (const token of tokens) {
      if (typeof token === "string") {
        words.push(token);
      } else if (
        "op" in token &&
        [";", "|", "&", "&&", "||"].includes(token.op)
      ) {
        endCommand();
      } else if (!("comment" in token)) {
        complete = false;
      }
    }
    endCommand();
    if (
      commands.some(
        (entry) =>
          /\s/u.test(entry.words[0]) ||
          /^[a-zA-Z_][a-zA-Z0-9_]*\+?=/u.test(entry.words[0]),
      )
    ) {
      complete = false;
    }
    return { commands, complete: complete && commands.length > 0 };
  } catch {
    return { commands, complete: false };
  }
}
