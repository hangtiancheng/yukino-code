export interface ShellCommand {
  content: string;
  words: string[];
}

export interface ShellAnalysis {
  commands: ShellCommand[];
  complete: boolean;
}

const COMPLEX_COMMANDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "select",
  "coproc",
  "!",
  "time",
  "eval",
  "exec",
  "source",
  ".",
  "command",
  "builtin",
  "env",
  "sudo",
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "pwsh",
  "powershell",
  "xargs",
  "find",
]);

// Analyze literal simple commands and lists; expansion, redirection and control
// syntax deliberately require a separate approval instead of prefix authority.
export function analyzeShell(
  command: string,
  powershell = false,
): ShellAnalysis {
  const commands: ShellCommand[] = [];
  let complete = true;
  let quote = "";
  let word = "";
  let inWord = false;
  let words: string[] = [];
  const endWord = () => {
    if (inWord) {
      words.push(word);
      word = "";
      inWord = false;
    }
  };
  const endCommand = () => {
    endWord();
    if (words.length) {
      const executable = words[0].split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
      if (
        !words[0] ||
        COMPLEX_COMMANDS.has(executable.replace(/\.exe$/u, "")) ||
        /[\s*?[\]~]/u.test(words[0]) ||
        /^[\w]+=/u.test(words[0])
      ) {
        complete = false;
      }
      commands.push({ content: words.join(" "), words });
      words = [];
    }
  };
  const escape = powershell ? "`" : "\\";
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (c === "'") {
        if (powershell && next === "'") {
          word += "'";
          i++;
        } else {
          quote = "";
        }
      } else {
        word += c;
      }
      continue;
    }
    if (c === escape) {
      if (next === undefined) {
        complete = false;
      } else if (next === "\n") {
        i++;
      } else if (next === "\r" && command[i + 2] === "\n") {
        i += 2;
      } else if (!quote || powershell || /[$`"\\]/u.test(next)) {
        word += next;
        inWord = true;
        i++;
      } else {
        word += c;
      }
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        if (powershell && next === '"') {
          word += '"';
          i++;
        } else {
          quote = "";
        }
      } else {
        if (c === "$" || (!powershell && c === "`")) {
          complete = false;
        }
        word += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "#" && !inWord) {
      while (i + 1 < command.length && !/[\r\n]/u.test(command[i + 1])) {
        i++;
      }
    } else if (/[;|&\r\n]/u.test(c)) {
      if (!words.length && !inWord && /[|&]/u.test(c)) {
        complete = false;
      }
      endCommand();
      if ((c === "&" || c === "|") && next === c) {
        i++;
      }
    } else if (/\s/u.test(c)) {
      endWord();
    } else {
      if (/[$`(){}<>\u0000]/u.test(c)) {
        complete = false;
      }
      word += c;
      inWord = true;
    }
  }
  if (quote) {
    complete = false;
  }
  endCommand();
  return { commands, complete: complete && commands.length > 0 };
}
