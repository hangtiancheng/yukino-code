import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";

import { version } from "@/bootstrap/version.js";
import { THINKING_LEVELS } from "@/config/constants.js";
import type { ThinkingLevel } from "@/config/provider-config.js";
import type { OutputFormat } from "@/print/index.js";
import { runUpdate } from "@/update/index.js";

export interface InvocationOptions {
  cwd?: string;
  config?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  sessionId?: string;
  name?: string;
  continue?: boolean;
  persist?: boolean;
  tools?: string[];
  excludeTools?: string[];
  systemPrompt?: string;
  systemPromptFile?: string;
  appendSystemPromptFile?: string;
  attachments?: string[];
  stdin?: boolean;
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  trustProject?: boolean;
  noProjectResources?: boolean;
}

export type CliMode =
  | { kind: "help"; topic?: "update" }
  | { kind: "version" }
  | { kind: "update"; tag?: string }
  | {
      kind: "print";
      prompt: string;
      outputFormat: OutputFormat;
      options?: InvocationOptions;
    }
  | { kind: "rpc"; options?: InvocationOptions }
  | { kind: "remote"; address: string; options?: InvocationOptions }
  | { kind: "a2a"; address?: string; options?: InvocationOptions }
  | { kind: "ui"; resume?: true | string; options?: InvocationOptions };

export type RuntimeMode = Exclude<
  CliMode,
  { kind: "help" | "version" | "update" }
>;
export class CliUsageError extends Error {}

function nonEmpty(value: string): string {
  if (!value.trim()) {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  return value;
}

function toolNames(value: string): string[] {
  const names = value.split(",").map((name) => name.trim());
  if (names.some((name) => !name)) {
    throw new InvalidArgumentError(
      "Tool lists must contain non-empty comma-separated names.",
    );
  }
  return [...new Set(names)];
}

function createCliCommand(): Command {
  const command = new Command()
    .name("yukino")
    .action(() => undefined)
    .description("Yukino is a terminal-based AI coding agent.")
    .version(version, "-v, --version", "Show the version number")
    .argument(
      "[prompt...]",
      "Prompt data (use -- before data starting with '-')",
    )
    .option(
      "-p <prompt>",
      "Run a prompt without a terminal (- reads stdin)",
      nonEmpty,
    )
    .addOption(
      new Option(
        "--rpc",
        "Run the bidirectional JSONL stdio protocol",
      ).conflicts(["p", "remote", "a2a", "stdin"]),
    )
    .addOption(
      new Option(
        "--remote [addr]",
        "Start the browser server (127.0.0.1:18888)",
      )
        .argParser(nonEmpty)
        .conflicts(["p", "a2a", "stdin"]),
    )
    .addOption(
      new Option("--a2a [addr]", "Start the A2A server (127.0.0.1:18890)")
        .argParser(nonEmpty)
        .conflicts(["p", "stdin"]),
    )
    .addOption(
      new Option(
        "--resume [session-id]",
        "Resume a session; omit the ID for the TUI picker",
      )
        .argParser(nonEmpty)
        .conflicts(["session", "continue"]),
    )
    .addOption(
      new Option(
        "--continue",
        "Continue the latest session in the selected cwd",
      ).conflicts("session"),
    )
    .option("--cwd <path>", "Working directory", nonEmpty)
    .option("--config <path>", "User configuration file", nonEmpty)
    .option("--provider <name>", "Configured provider", nonEmpty)
    .option("--model <id>", "Session model ID", nonEmpty)
    .addOption(
      new Option("--thinking <level>", "Thinking level").choices(
        THINKING_LEVELS,
      ),
    )
    .option("--session <id>", "Existing session ID", nonEmpty)
    .option("--name <name>", "Session name", nonEmpty)
    .addOption(
      new Option("--no-persist", "Keep this invocation in memory").conflicts([
        "resume",
        "session",
        "continue",
      ]),
    )
    .option("--tools <names>", "Comma-separated tool allowlist", toolNames)
    .option(
      "--exclude-tools <names>",
      "Comma-separated tool exclusions",
      toolNames,
    )
    .addOption(
      new Option(
        "--no-tools",
        "Disable all model tools, including indirect calls",
      ),
    )
    .addOption(
      new Option("--system-prompt <text>", "Replace the system prompt")
        .argParser(nonEmpty)
        .conflicts("systemPromptFile"),
    )
    .option(
      "--system-prompt-file <path>",
      "Read the replacement prompt as data",
      nonEmpty,
    )
    .option(
      "--append-system-prompt-file <path>",
      "Append prompt data",
      nonEmpty,
    )
    .option(
      "--attachment <path>",
      "Attach a local file (repeatable)",
      (value: string, previous?: string[]) => [
        ...(previous ?? []),
        nonEmpty(value),
      ],
    )
    .option("--stdin", "Read prompt text from stdin")
    .addOption(
      new Option("--permission-mode <mode>", "Permission mode").choices([
        "default",
        "acceptEdits",
        "plan",
        "bypassPermissions",
      ]),
    )
    .addOption(
      new Option(
        "--trust-project",
        "Trust this canonical project for this invocation",
      ).conflicts("projectResources"),
    )
    .option(
      "--no-project-resources",
      "Skip project configuration and executable resources",
    )
    .addOption(
      new Option("--output-format <fmt>", "Print output format").choices([
        "text",
        "stream-json",
      ]),
    )
    .addHelpText(
      "after",
      `
With no mode, Yukino starts an interactive terminal session.
Type /help inside a session to list the available commands.
API keys belong in private configuration or environment variables, not argv.
Print has no implicit permission bypass; preauthorize tools or use an interactive host.

Examples:
  yukino -p "explain this codebase" --tools ReadFile,Grep
  yukino -p - --no-persist
  yukino -- --prompt-starting-with-dashes
  yukino --rpc --cwd /path/to/project
  yukino --remote 9000`,
    );
  const toolFlags = new Set<string>();
  for (const flag of ["tools", "no-tools"]) {
    command.on(`option:${flag}`, () => {
      toolFlags.add(flag);
      if (toolFlags.size > 1) {
        throw new CliUsageError("--tools cannot be combined with --no-tools.");
      }
    });
  }
  command
    .command("update")
    .description("Update Yukino from an npm dist-tag")
    .option("--tag <tag>", "npm dist-tag to check", nonEmpty, "latest")
    .action(() => undefined);
  return command;
}

function helpText(command: Command): string {
  let output = "";
  command.configureOutput({
    writeOut: (text) => {
      output += text;
    },
  });
  command.outputHelp();
  return output.trimEnd();
}

export const CLI_HELP = helpText(createCliCommand());
export const UPDATE_HELP = helpText(createCliCommand().commands[0]);

type ParsedOptions = Omit<InvocationOptions, "tools" | "attachments"> & {
  p?: string;
  rpc?: boolean;
  remote?: true | string;
  a2a?: true | string;
  resume?: true | string;
  session?: string;
  tools?: string[] | false;
  attachment?: string[];
  projectResources?: boolean;
  outputFormat?: OutputFormat;
};

export function parseCliArgs(argv: string[]): CliMode {
  const command = createCliCommand();
  let promptWords: string[] = [];
  command.action((words: string[]) => {
    promptWords = words;
  });
  command
    .exitOverride()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  for (const child of command.commands) {
    child.exitOverride().configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined,
    });
  }
  try {
    command.parse(argv, { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error;
    }
    if (error.code === "commander.helpDisplayed") {
      return {
        kind: "help",
        ...(command.args[0] === "update" ? { topic: "update" as const } : {}),
      };
    }
    if (error.code === "commander.version") {
      return { kind: "version" };
    }
    throw new CliUsageError(
      `${error.message}\n${command.args[0] === "update" ? UPDATE_HELP : CLI_HELP}`,
    );
  }
  const update = command.commands[0];
  if (command.args[0] === "update") {
    return update.getOptionValueSource("tag") === "default"
      ? { kind: "update" }
      : { kind: "update", tag: update.opts<{ tag: string }>().tag };
  }
  const {
    p,
    rpc,
    remote,
    a2a,
    resume,
    session,
    tools,
    attachment,
    projectResources,
    outputFormat,
    ...settings
  } = command.opts<ParsedOptions>();
  const options: InvocationOptions = { ...settings };
  if (command.getOptionValueSource("persist") === "default") {
    delete options.persist;
  }
  if (
    command.getOptionValueSource("projectResources") !== "default" &&
    projectResources === false
  ) {
    options.noProjectResources = true;
  }
  if (
    command.getOptionValueSource("tools") !== "default" &&
    tools !== undefined
  ) {
    options.tools = tools === false ? [] : tools;
  }
  if (attachment) {
    options.attachments = attachment;
  }
  if (session || typeof resume === "string") {
    options.sessionId =
      session ?? (typeof resume === "string" ? resume : undefined);
  }
  let prompt = p;
  if (promptWords.length) {
    if (p !== undefined) {
      throw new CliUsageError("Prompt was already specified.");
    }
    prompt = promptWords.join(" ");
    if (!prompt.trim()) {
      throw new CliUsageError("Expected non-empty prompt data.");
    }
  }
  if (p === "-") {
    options.stdin = true;
    prompt = "";
  }
  const serverMode = rpc || remote !== undefined || a2a !== undefined;
  if (serverMode && (prompt !== undefined || options.stdin)) {
    throw new CliUsageError(
      "Prompt data cannot be combined with a server mode.",
    );
  }
  const print = prompt !== undefined || options.stdin;
  if (outputFormat && !print) {
    throw new CliUsageError("--output-format requires print mode.");
  }
  if (resume === true && (serverMode || print)) {
    throw new CliUsageError(
      "Non-interactive modes require an explicit session ID.",
    );
  }
  const extra = Object.keys(options).length ? { options } : {};
  if (print) {
    return {
      kind: "print",
      prompt: prompt ?? "",
      outputFormat: outputFormat ?? "text",
      ...extra,
    };
  }
  if (rpc) {
    return { kind: "rpc", ...extra };
  }
  if (remote !== undefined) {
    return {
      kind: "remote",
      address: typeof remote === "string" ? remote : "18888",
      ...extra,
    };
  }
  if (a2a !== undefined) {
    return {
      kind: "a2a",
      ...(typeof a2a === "string" ? { address: a2a } : {}),
      ...extra,
    };
  }
  return { kind: "ui", ...(resume !== undefined ? { resume } : {}), ...extra };
}

async function run(): Promise<void> {
  let mode: CliMode;
  try {
    mode = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof CliUsageError)) {
      throw error;
    }
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  switch (mode.kind) {
    case "help":
      console.log(mode.topic === "update" ? UPDATE_HELP : CLI_HELP);
      return;
    case "version":
      console.log(version);
      return;
    case "update":
      await runUpdate(mode.tag);
      return;
    case "rpc": {
      const { runRpcMode } = await import("./rpc/mode.js");
      await runRpcMode(mode.options);
      return;
    }
    default: {
      const { runMode } = await import("./main.js");
      await runMode(mode);
    }
  }
}

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
