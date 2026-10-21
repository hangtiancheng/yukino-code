import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { OutputFormat } from "@/print-mode.js";
import { runUpdate } from "@/update/index.js";
import { version } from "@/version.js";

export const CLI_HELP = `Yukino is a terminal-based AI coding agent.

Usage: yukino [options]

Options:
  -h, --help                  Show this help
  -v, --version               Show the version number
  -p <prompt>                 Run a single prompt non-interactively and print the result
      --output-format <fmt>   Output format for -p: text (default) or stream-json
      --resume [session-id]   Resume a previous session; opens a picker when omitted
      --remote [addr]         Start the remote server (default: 127.0.0.1:18888)
      --acp                   Serve the Agent Client Protocol over stdio
      --acp-ws [addr]         Serve ACP over WebSocket (default: 127.0.0.1:18889)
      --a2a [addr]            Start an A2A server (default: 127.0.0.1:18890)

Commands:
  update [--tag <tag>]        Update Yukino from an npm dist-tag (default: latest)

With no options, Yukino starts an interactive terminal session.
Type /help inside a session to list the available slash commands.

Examples:
  yukino
  yukino -p "explain this codebase"
  yukino -p "fix the failing test" --output-format stream-json
  yukino --resume
  yukino --remote 9000`;

const UPDATE_USAGE = "Usage: yukino update [--tag <tag>]";

export const UPDATE_HELP = `${UPDATE_USAGE}

Update Yukino from an npm dist-tag.

Options:
  --tag <tag>  npm dist-tag to check (default: latest)
  -h, --help   Show this help

Examples:
  yukino update
  yukino update --tag=canary`;

export type CliMode =
  | { kind: "help"; topic?: "update" }
  | { kind: "version" }
  | { kind: "update"; tag?: string }
  | { kind: "print"; prompt: string; outputFormat: OutputFormat }
  | { kind: "remote"; address: string }
  | { kind: "acp" }
  | { kind: "acp-ws"; address?: string }
  | { kind: "a2a"; address?: string }
  | { kind: "ui"; resume?: true | string };

/** Modes that need the full runtime (src/main.tsx), loaded on demand. */
export type RuntimeMode = Exclude<
  CliMode,
  { kind: "help" | "version" | "update" }
>;

type ServerMode = Extract<
  RuntimeMode,
  { kind: "remote" | "acp" | "acp-ws" | "a2a" }
>;

const SERVER_MODE_FLAGS = {
  remote: "--remote",
  acp: "--acp",
  "acp-ws": "--acp-ws",
  a2a: "--a2a",
} as const;

export class CliUsageError extends Error {}

const PRINT_PROMPT_REQUIRED =
  "-p requires a prompt argument immediately after it; use '-p -- <prompt>' when the prompt starts with '-'";
const HELP_HINT = "Run 'yukino --help' for usage.";

function parseOutputFormat(value: string | undefined): OutputFormat {
  if (value !== "text" && value !== "stream-json") {
    // Also catches a missing value at the end of the argument list.
    throw new CliUsageError(
      `--output-format requires 'text' or 'stream-json' (got '${value ?? "nothing"}')`,
    );
  }
  return value;
}

function parseUpdateArgs(args: string[]): CliMode {
  let tag: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === "--help" || token === "-h") {
      return { kind: "help", topic: "update" };
    }
    if (token === "--tag") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliUsageError(
          `Option '--tag' requires a value.\n${UPDATE_USAGE}`,
        );
      }
      tag = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--tag=")) {
      tag = token.slice("--tag=".length);
      continue;
    }
    const problem = token.startsWith("-")
      ? `Unknown option '${token}'.`
      : `Unexpected argument '${token}'.`;
    throw new CliUsageError(`${problem}\n${UPDATE_USAGE}`);
  }
  return tag === undefined ? { kind: "update" } : { kind: "update", tag };
}

/**
 * Single owner of the CLI grammar: every flag yukino accepts is parsed here
 * into a typed mode. Invalid input throws CliUsageError, which the entry
 * point below reports on stderr with exit code 1.
 */
export function parseCliArgs(argv: string[]): CliMode {
  if (argv[0] === "update") {
    return parseUpdateArgs(argv.slice(1));
  }

  let server: ServerMode | undefined;
  let prompt: string | undefined;
  let resume: true | string | undefined;
  let outputFormat: OutputFormat | undefined;
  let endOfOptions = false;

  const takenOption = (): string | undefined => {
    if (server) {
      return SERVER_MODE_FLAGS[server.kind];
    }
    if (prompt !== undefined) {
      return "-p";
    }
    if (resume !== undefined) {
      return "--resume";
    }
    return outputFormat === undefined ? undefined : "--output-format";
  };
  const claimServerMode = (
    flag: (typeof SERVER_MODE_FLAGS)[keyof typeof SERVER_MODE_FLAGS],
  ): void => {
    const taken = takenOption();
    if (taken === flag) {
      throw new CliUsageError(`Option '${flag}' was already specified.`);
    }
    if (taken) {
      throw new CliUsageError(`${flag} cannot be combined with ${taken}.`);
    }
  };
  const setResume = (value: true | string): void => {
    if (server) {
      throw new CliUsageError(
        `--resume cannot be combined with ${SERVER_MODE_FLAGS[server.kind]}.`,
      );
    }
    if (prompt !== undefined) {
      throw new CliUsageError("--resume cannot be combined with -p.");
    }
    resume = value;
  };
  const optionalAddress = (index: number): [string | undefined, number] => {
    const next = argv[index + 1];
    return next !== undefined && !next.startsWith("-")
      ? [next, index + 1]
      : [undefined, index];
  };

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];

    if (endOfOptions) {
      throw new CliUsageError(`Unexpected argument "${token}". ${HELP_HINT}`);
    }
    if (token === "--") {
      endOfOptions = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      return { kind: "help" };
    }
    if (token === "--version" || token === "-v") {
      return { kind: "version" };
    }

    switch (token) {
      case "-p": {
        if (server) {
          throw new CliUsageError(
            `-p cannot be combined with ${SERVER_MODE_FLAGS[server.kind]}.`,
          );
        }
        if (prompt !== undefined) {
          throw new CliUsageError("Option '-p' was already specified.");
        }
        if (resume !== undefined) {
          throw new CliUsageError("-p cannot be combined with --resume.");
        }
        if (argv[index + 1] === "--") {
          // '-p -- <prompt>': the token after the separator is prompt data
          // even when it looks like a flag.
          const value = argv[index + 2];
          if (!value?.trim()) {
            throw new CliUsageError(PRINT_PROMPT_REQUIRED);
          }
          prompt = value;
          endOfOptions = true;
          index += 2;
        } else {
          const value = argv[index + 1];
          if (!value?.trim() || value.startsWith("-")) {
            throw new CliUsageError(PRINT_PROMPT_REQUIRED);
          }
          prompt = value;
          index += 1;
        }
        continue;
      }
      case "--output-format": {
        if (server) {
          throw new CliUsageError(
            `--output-format cannot be combined with ${SERVER_MODE_FLAGS[server.kind]}.`,
          );
        }
        outputFormat = parseOutputFormat(argv[index + 1]);
        index += 1;
        continue;
      }
      case "--resume": {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith("-")) {
          setResume(next);
          index += 1;
        } else {
          setResume(true);
        }
        continue;
      }
      case "--remote": {
        claimServerMode(token);
        const [address, nextIndex] = optionalAddress(index);
        server = { kind: "remote", address: address ?? "18888" };
        index = nextIndex;
        continue;
      }
      case "--acp": {
        claimServerMode(token);
        server = { kind: "acp" };
        continue;
      }
      case "--acp-ws": {
        claimServerMode(token);
        const [address, nextIndex] = optionalAddress(index);
        server =
          address === undefined
            ? { kind: "acp-ws" }
            : { kind: "acp-ws", address };
        index = nextIndex;
        continue;
      }
      case "--a2a": {
        claimServerMode(token);
        const [address, nextIndex] = optionalAddress(index);
        server =
          address === undefined ? { kind: "a2a" } : { kind: "a2a", address };
        index = nextIndex;
        continue;
      }
      default: {
        if (token.startsWith("--resume=")) {
          setResume(token.slice("--resume=".length) || true);
          continue;
        }
        throw new CliUsageError(
          token.startsWith("-")
            ? `Unknown option "${token}". ${HELP_HINT}`
            : `Unexpected argument "${token}". ${HELP_HINT}`,
        );
      }
    }
  }

  if (outputFormat !== undefined && prompt === undefined) {
    throw new CliUsageError("--output-format requires -p.");
  }
  if (prompt !== undefined) {
    return { kind: "print", prompt, outputFormat: outputFormat ?? "text" };
  }
  if (server) {
    return server;
  }
  return resume === undefined ? { kind: "ui" } : { kind: "ui", resume };
}

async function run(): Promise<void> {
  let mode: CliMode;
  try {
    mode = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof CliUsageError)) {
      throw err;
    }
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  switch (mode.kind) {
    case "help": {
      console.log(mode.topic === "update" ? UPDATE_HELP : CLI_HELP);
      return;
    }
    case "version": {
      console.log(version);
      return;
    }
    case "update": {
      await runUpdate(mode.tag);
      return;
    }
    default: {
      const { runMode } = await import("./main.js");
      await runMode(mode);
    }
  }
}

// Maintenance modes (help/version/update) must run without the runtime chunk
// (the full application graph, configuration). Tests also import this module for
// parseCliArgs, so only dispatch when this file is the process entry point.
function isProcessEntry(): boolean {
  const script = process.argv[1];
  if (!script) {
    return false;
  }
  try {
    return (
      realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isProcessEntry()) {
  await run();
}
