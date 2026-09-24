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

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import yaml from "js-yaml";
import { z, parse } from "zod";

import type { Command } from "./commands.js";

// Loads user-defined slash commands from .yukino/commands/*.md (user then
// project, so project wins on a name collision). Subdirectories namespace the
// command name: sub/dir/foo.md → "sub:dir:foo".
export function loadUserCommands(workDir: string): Command[] {
  const byName = new Map<string, Command>();
  const bases = [
    join(homedir(), ".yukino", "commands"),
    join(workDir, ".yukino", "commands"),
  ];
  for (const base of bases) {
    if (!existsSync(base)) {
      continue;
    }
    for (const cmd of walkDir(base, base)) {
      byName.set(cmd.name, cmd);
    }
  }
  return [...byName.values()];
}

function walkDir(base: string, dir: string): Command[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // log.error({ err }, "commands operation failed");

    return [];
  }
  const out: Command[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      // log.error({ err }, "commands operation failed");

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
  aliases: z.array(z.string()).optional(),
});

function parseCommandFile(base: string, full: string): Command | null {
  let raw: string;
  try {
    raw = readFileSync(full, "utf-8");
  } catch {
    // log.error({ err }, "commands operation failed");

    return null;
  }

  let description = "";
  let argumentHint = "";
  let aliases: string[] = [];
  let body = raw;

  if (raw.startsWith("---")) {
    const end = raw.indexOf("---", 3);
    if (end !== -1) {
      const frontmatter = raw.slice(3, end).trim();
      body = raw.slice(end + 3).trim();
      try {
        const p: unknown = yaml.load(frontmatter);
        const data = parse(YamlFrontmatterSchema, p);
        description = data.description ?? "";
        argumentHint = data["argument-hint"] ?? "";
        aliases = data.aliases ?? [];
      } catch {
        // log.error({ err }, "commands operation failed");
        // ignore frontmatter parse errors; treat whole file as body
      }
    }
  }

  const name = commandName(base, full);
  if (!name) {
    return null;
  }

  return {
    name,
    aliases: Array.isArray(aliases) ? aliases : [],
    type: "prompt",
    description:
      description ||
      (argumentHint
        ? `custom command (args: ${argumentHint})`
        : "custom command"),
    handler: (ctx) => renderBody(body, ctx.args),
  };
}

// Render a command body, substituting $ARGUMENTS; if there is no placeholder and
// args were given, append them.
export function renderBody(body: string, args: string): string {
  if (body.includes("$ARGUMENTS")) {
    return body.replaceAll("$ARGUMENTS", () => args);
  }
  if (args) {
    return `${body}\n\n${args}`;
  }
  return body;
}
