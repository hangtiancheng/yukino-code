import { existsSync, lstatSync, readFileSync } from "node:fs";

import { globSync } from "glob";
import { parse as parseShell } from "shell-quote";
import { z, parse } from "zod";

import type { Command } from "@/commands/commands.js";
import {
  ARGUMENT_PLACEHOLDER_RE,
  COMMAND_FILE_EXTENSION_RE,
  CUSTOM_COMMAND_TAG,
  PROMPTS_DIR_NAME,
} from "@/commands/constants.js";
import { createChildLogger } from "@/logger/index.js";
import { yukinoPath } from "@/storage/index.js";
import { parseYamlFrontmatter } from "@/utils/frontmatter.js";

const log = createChildLogger({ module: "commands" });

interface LoadedCommand {
  command: Command;
  sourcePath: string;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Subdirectories namespace command names: sub/dir/foo.md → "sub:dir:foo".
export function loadUserCommands(
  options: { paths?: string[]; disabled?: string[] } = {},
): Command[] {
  return loadPromptCommands(
    options.paths ?? [yukinoPath(PROMPTS_DIR_NAME)],
    options.disabled,
  );
}

/** Later directories replace earlier named prompts; disabled names win last. */
export function loadPromptCommands(
  directories: string[],
  disabled: string[] = [],
): Command[] {
  const byName = new Map<string, LoadedCommand>();
  for (const base of directories) {
    if (!existsSync(base) || lstatSync(base).isSymbolicLink()) {
      continue;
    }
    const loaded = walkDir(base, base);
    // Sort by source path so a name collision (e.g. Foo.md vs foo.md, or a file
    // whose name already contains ":") never resolves by readdir order: the
    // lexicographically smallest path wins and every loser is reported.
    loaded.sort((a, b) => compareStrings(a.sourcePath, b.sourcePath));
    const directoryNames = new Set<string>();
    for (const item of loaded) {
      const existing = byName.get(item.command.name);
      if (directoryNames.has(item.command.name) && existing) {
        log.warn(
          `User command name collision for '${item.command.name}': keeping '${existing.sourcePath}', ignoring '${item.sourcePath}'`,
        );
        continue;
      }
      directoryNames.add(item.command.name);
      byName.set(item.command.name, item);
    }
  }
  for (const name of disabled) {
    byName.delete(name);
  }
  return [...byName.values()].map((i) => i.command);
}

function walkDir(base: string, dir: string): LoadedCommand[] {
  return globSync("**/*.md", {
    cwd: dir,
    absolute: true,
    nodir: true,
    stat: true,
    ignore: {
      ignored: (entry) => entry.isSymbolicLink(),
      childrenIgnored: (entry) => entry.isSymbolicLink(),
    },
  }).flatMap((full) => {
    const command = parseCommandFile(base, full);
    return command ? [{ command, sourcePath: full }] : [];
  });
}

function commandName(base: string, full: string): string {
  const rel = full
    .slice(base.length + 1)
    .replace(COMMAND_FILE_EXTENSION_RE, "");
  return rel
    .split(/[/\\]/)
    .map((p) => p.toLowerCase().replace(/ /g, "-"))
    .join(":");
}

const YamlFrontmatterSchema = z.object({
  description: z.string().optional(),
  "argument-hint": z.string().optional(),
});

function parseCommandFile(base: string, full: string): Command | null {
  let raw: string;
  try {
    raw = readFileSync(full, "utf-8").replace(/^\uFEFF/u, "");
  } catch {
    return null;
  }

  let description = "";
  let argumentHint = "";
  let body = raw;

  try {
    const frontmatter = parseYamlFrontmatter(raw);
    if (frontmatter) {
      const data = parse(YamlFrontmatterSchema, frontmatter.data);
      body = frontmatter.body;
      description = data.description ?? "";
      argumentHint = data["argument-hint"] ?? "";
    }
  } catch (err) {
    log.error({ err, full }, "Invalid command frontmatter");
    return null;
  }

  const name = commandName(base, full);
  if (!name) {
    return null;
  }

  return {
    name,
    type: "prompt",
    resource: "prompt",
    description: `${
      description ||
      (argumentHint
        ? `custom command (args: ${argumentHint})`
        : "custom command")
    } ${CUSTOM_COMMAND_TAG}`,
    handler: (ctx) => renderBody(body, ctx.args),
  };
}

export function parseCommandArgs(input: string): string[] {
  return parseShell(input, (key) => `$${key}`).flatMap((token) => {
    if (typeof token === "string") {
      return [token];
    }
    if ("pattern" in token) {
      return [token.pattern];
    }
    if ("op" in token) {
      return [token.op];
    }
    return [];
  });
}

export function renderBody(body: string, args: string): string {
  const positional = parseCommandArgs(args);
  let substituted = false;
  const rendered = body.replace(
    ARGUMENT_PLACEHOLDER_RE,
    (
      _match,
      target: string | undefined,
      fallback: string | undefined,
      start: string | undefined,
      length: string | undefined,
      simple: string | undefined,
    ) => {
      substituted = true;
      if (target) {
        const value =
          target === "ARGUMENTS" || target === "@"
            ? positional.join(" ")
            : positional[Number(target) - 1];
        return value || fallback || "";
      }
      if (start) {
        const offset = Math.max(0, Number(start) - 1);
        return positional
          .slice(
            offset,
            length === undefined ? undefined : offset + Number(length),
          )
          .join(" ");
      }
      return simple === "ARGUMENTS" || simple === "@"
        ? positional.join(" ")
        : (positional[Number(simple) - 1] ?? "");
    },
  );
  if (!substituted && args) {
    return `${body}\n\n${args}`;
  }
  return rendered;
}
