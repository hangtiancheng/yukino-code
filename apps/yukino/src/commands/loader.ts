import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import yaml from "js-yaml";
import { z, parse } from "zod";

import type { Command } from "./commands.js";

import { yukinoPath } from "@/storage/paths.js";

// Subdirectories namespace command names: sub/dir/foo.md → "sub:dir:foo".
export function loadUserCommands(): Command[] {
  const base = yukinoPath("prompts");
  if (!existsSync(base)) {
    return [];
  }
  const byName = new Map<string, Command>();
  for (const cmd of walkDir(base, base)) {
    byName.set(cmd.name, cmd);
  }
  return [...byName.values()];
}

function walkDir(base: string, dir: string): Command[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Command[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walkDir(base, full));
    } else if (entry.endsWith(".md")) {
      const cmd = parseCommandFile(base, full);
      if (cmd) {
        out.push(cmd);
      }
    }
  }
  return out;
}

function commandName(base: string, full: string): string {
  const rel = full.slice(base.length + 1).replace(/\.md$/, "");
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

  const frontmatterMatch =
    /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(raw);
  if (frontmatterMatch) {
    const frontmatter = frontmatterMatch[1].trim();
    body = raw.slice(frontmatterMatch[0].length).trim();
    try {
      const p: unknown = yaml.load(frontmatter);
      const data = parse(YamlFrontmatterSchema, p);
      description = data.description ?? "";
      argumentHint = data["argument-hint"] ?? "";
    } catch {
      // Ignore frontmatter parse errors; keep the body text that follows the
      // frontmatter block.
    }
  }

  const name = commandName(base, full);
  if (!name) {
    return null;
  }

  return {
    name,
    type: "prompt",
    description: `${
      description ||
      (argumentHint
        ? `custom command (args: ${argumentHint})`
        : "custom command")
    } [custom]`,
    handler: (ctx) => renderBody(body, ctx.args),
  };
}

export function parseCommandArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (
      char === "\\" &&
      quote !== "'" &&
      index + 1 < input.length &&
      (!quote || ["\\", '"'].includes(input[index + 1]))
    ) {
      current += input[++index];
      started = true;
    } else if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }
  if (started) {
    args.push(current);
  }
  return args;
}

export function renderBody(body: string, args: string): string {
  const positional = parseCommandArgs(args);
  let substituted = false;
  const rendered = body.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/gu,
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
          target === "ARGUMENTS"
            ? args
            : target === "@"
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
      return simple === "ARGUMENTS"
        ? args
        : simple === "@"
          ? positional.join(" ")
          : (positional[Number(simple) - 1] ?? "");
    },
  );
  if (!substituted && args) {
    return `${body}\n\n${args}`;
  }
  return rendered;
}
